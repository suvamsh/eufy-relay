"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MegaTransition = void 0;
const api_1 = require("./api");
const megaApi_1 = require("./megaApi");
const logging_1 = require("../logging");
const types_1 = require("./types");
const error_1 = require("../error");
const utils_1 = require("../utils");
/**
 * Coordinates the v6-first login sequence. The v6 "eufy_mega" backend is the primary login (it
 * carries push and is where the account is heading); the legacy login runs afterwards as
 * best-effort and never blocks. Each backend has its OWN 2FA email + captcha; whichever asks
 * records itself in {@link pendingChallenge} so the code/captcha from the next connect() is routed
 * to the backend that asked for it. The app-ready signal fires ONCE, at the very end, and only if a
 * login succeeded.
 */
class MegaTransition {
    host;
    megaApi;
    /**
     * Which backend a submitted 2FA code / captcha must be routed to. Set when WE emit the challenge,
     * so the next connect({verifyCode|captcha}) goes to the backend that asked for it — no guessing.
     * `undefined` = no challenge outstanding (start a fresh sequence).
     */
    pendingChallenge;
    /** Whether the v6 login succeeded this sequence (gates signalling the app as connected). */
    megaLoggedIn = false;
    /** Serialises connect(): concurrent calls await the in-flight one instead of racing the sequence. */
    connectInProgress;
    constructor(host) {
        this.host = host;
    }
    /** Record that the LEGACY login asked for a code/captcha (called from the host's api-event hooks). */
    recordLegacyChallenge() {
        this.pendingChallenge = "legacy";
    }
    /**
     * Build the live transport. Today this is just the upstream legacy {@link HTTPApi}; the v6 mega
     * client is created lazily on demand (login / push) via {@link getMegaApi}. Kept as a single
     * factory so the transport can be swapped here if v6 ever needs to drive data requests too.
     */
    async createTransport(persistentHttpApi) {
        return api_1.HTTPApi.initialize(this.host.config.country, this.host.config.username, this.host.config.password, persistentHttpApi);
    }
    /**
     * Lazily create (and restore) the v6 mega client. The persisted session (token ~30 days) is
     * reused so normal startups need no extra login/2FA; it is dropped if the credentials changed.
     */
    async getMegaApi() {
        if (!this.megaApi) {
            this.megaApi = new megaApi_1.MegaHTTPApi({
                ab: this.host.config.country ?? "US",
                osType: "android",
                phoneModel: this.host.config.trustedDeviceName,
                openudid: this.host.persistentData.openudid || undefined,
            });
            await this.megaApi.init();
            const saved = this.host.persistentData.megaApi;
            if (saved) {
                const currentHash = (0, megaApi_1.megaLoginHash)(this.host.config.username, this.host.config.password, this.host.persistentData.openudid);
                // GG-PATCH(session-reuse): no password configured -> restore the stored mega session; expiry is enforced later by hasValidSession().
                if (this.host.config.password && saved.login_hash && saved.login_hash !== currentHash) {
                    logging_1.rootMainLogger.debug("v6: credentials changed since last login, ignoring stored mega session");
                }
                else {
                    this.megaApi.restoreSession(saved);
                }
            }
        }
        return this.megaApi;
    }
    /**
     * Register the FCM token on the v6 backend, best-effort. No-ops with a log when there is no valid
     * v6 session yet (not-yet-migrated account); a v6 failure is swallowed so legacy push is unaffected.
     */
    async registerMegaPushToken(token) {
        try {
            const mega = await this.getMegaApi();
            if (!mega.hasValidSession()) {
                logging_1.rootMainLogger.debug("v6 push: no valid mega session yet, skipping register (legacy still active)");
                return false;
            }
            const result = await mega.registerPushToken(token);
            if (result.code === 0) {
                logging_1.rootMainLogger.info("v6 push: FCM token registered on the eufy_mega backend");
                return true;
            }
            logging_1.rootMainLogger.warn("v6 push: register_push_token returned a non-zero code", {
                code: result.code,
                msg: result.msg,
            });
            return false;
        }
        catch (err) {
            logging_1.rootMainLogger.warn("v6 push: register failed (legacy push unaffected)", { error: (0, utils_1.getError)((0, error_1.ensureError)(err)) });
            return false;
        }
    }
    /**
     * Authenticate against the v6 backend.
     *  1. first call -> on `26052` triggers the email code and returns "tfa_required"; on a captcha
     *     challenge it emits "captcha request" and returns "captcha_required".
     *  2. with a code/captcha -> completes login; the session is persisted (token ~30 days) so later
     *     startups reuse it with no relogin/2FA.
     *
     * Backend-enforced lockout (too many incorrect / max login limit) is surfaced as "locked" so the
     * caller stops retrying instead of deepening the lockout.
     */
    async loginMega(verifyCode, captcha) {
        try {
            const mega = await this.getMegaApi();
            if (mega.hasValidSession() && !verifyCode && !captcha)
                return "ok";
            await mega.estimateDomain();
            await mega.keyExchange(mega.clusterHost("openapi"));
            const result = await mega.login(this.host.config.username, this.host.config.password, verifyCode, captcha);
            if (result.code === types_1.ResponseErrorCode.CODE_NEED_VERIFY_CODE) {
                await mega.sendVerifyCode();
                this.pendingChallenge = "mega";
                this.host.emitTfaRequest();
                logging_1.rootMainLogger.info("v6 login: email 2FA required — call loginMega(code) with the received code");
                return "tfa_required";
            }
            if (result.code === types_1.ResponseErrorCode.LOGIN_NEED_CAPTCHA ||
                result.code === types_1.ResponseErrorCode.LOGIN_CAPTCHA_ERROR) {
                const c = await mega.generateCaptcha();
                this.pendingChallenge = "mega";
                this.host.emitCaptchaRequest(c.captcha_id, c.item);
                logging_1.rootMainLogger.info("v6 login: captcha required — call loginMega(undefined, {captchaId, answer})");
                return "captcha_required";
            }
            if (result.code === types_1.ResponseErrorCode.CODE_PASSWORD_TOO_MANY_INCORRECT ||
                result.code === types_1.ResponseErrorCode.CODE_PASSWORD_WRONG_FIVE_TIMES ||
                result.code === types_1.ResponseErrorCode.CODE_MAX_LOGIN_LIMIT) {
                logging_1.rootMainLogger.warn("v6 login temporarily locked by the backend — stop retrying", {
                    code: result.code,
                    msg: result.msg,
                });
                return "locked";
            }
            if (result.code !== 0) {
                logging_1.rootMainLogger.warn("v6 login failed", { code: result.code, msg: result.msg });
                return "failed";
            }
            this.host.persistentData.megaApi = mega.exportSession((0, megaApi_1.megaLoginHash)(this.host.config.username, this.host.config.password, this.host.persistentData.openudid));
            this.host.writePersistentData();
            logging_1.rootMainLogger.info("v6 login: success, mega session persisted");
            return "ok";
        }
        catch (err) {
            logging_1.rootMainLogger.error("v6 login error", { error: (0, utils_1.getError)((0, error_1.ensureError)(err)) });
            return "failed";
        }
    }
    /** Serialised connect(): concurrent callers await the in-flight run instead of racing it. */
    connect(options) {
        if (this.connectInProgress)
            return this.connectInProgress;
        this.connectInProgress = this.runConnect(options).finally(() => {
            this.connectInProgress = undefined;
        });
        return this.connectInProgress;
    }
    async runConnect(options) {
        const megaCaptcha = options?.captcha
            ? { captchaId: options.captcha.captchaId, answer: options.captcha.captchaCode }
            : undefined;
        // PHASE 1 — v6 first. Run it unless a challenge is currently outstanding for the LEGACY side.
        if (this.pendingChallenge !== "legacy") {
            const megaResult = await this.loginMega(options?.verifyCode, megaCaptcha);
            if (megaResult === "tfa_required" || megaResult === "captcha_required") {
                // loginMega already recorded pendingChallenge="mega" and prompted the consumer.
                return;
            }
            this.megaLoggedIn = megaResult === "ok";
            this.pendingChallenge = undefined;
        }
        // PHASE 2 — legacy afterwards, best-effort. A code/captcha just used by mega is not valid here;
        // the legacy login emits its OWN tfa/captcha event (which records pendingChallenge="legacy" via
        // the host) and we wait for the next connect(). If legacy has been decommissioned, its login
        // simply fails and we carry on with v6 only.
        if (!this.host.api.isConnected()) {
            const legacyOptions = this.pendingChallenge === "legacy"
                ? options
                : { ...options, verifyCode: undefined, captcha: undefined };
            this.pendingChallenge = undefined;
            await this.host.legacyConnect(legacyOptions);
            // legacyConnect may have recorded pendingChallenge="legacy" via the host's api-event hooks.
            if (this.pendingChallenge === "legacy" && !this.host.api.isConnected())
                return;
        }
        // PHASE 3 — both backends settled. Signal the app ONCE, only if a login actually succeeded.
        if (this.megaLoggedIn || this.host.api.isConnected()) {
            await this.host.onAPIConnect();
        }
        else {
            logging_1.rootMainLogger.warn("connect: neither v6 nor legacy login succeeded — not signalling connected");
            this.host.onConnectionError(new Error("Login failed on both backends"));
        }
    }
}
exports.MegaTransition = MegaTransition;
//# sourceMappingURL=megaTransition.js.map