import { HTTPApi } from "./api";
import { MegaHTTPApi } from "./megaApi";
import type { HTTPApiPersistentData, LoginOptions } from "./interfaces";
import type { EufySecurityConfig, EufySecurityPersistentData } from "../interfaces";
/**
 * Everything specific to the transitional v6 "eufy_mega" backend lives in this single file so it can
 * be removed in one block once a native v6 data layer (the new library) takes over.
 *
 * {@link MegaTransition} is the connect coordinator: v6-first login, legacy as best-effort
 * afterwards, the app-ready signal fired exactly once at the end. It owns all the v6 state (mega
 * client, pending challenge, serialisation) and talks to {@link EufySecurity} only through the
 * narrow {@link MegaTransitionHost} surface, so neither file leaks the other's internals.
 *
 * For now v6 is used only for login + FCM push registration: a migrated account logs in there and
 * receives events over its push channel, while the data layer keeps using the legacy transport. The
 * data endpoints differ on v6 (signed/encrypted, different paths/bodies) and belong in the new lib,
 * so we deliberately do NOT route legacy endpoints through mega here.
 *
 * Nothing here modifies {@link MegaHTTPApi}: this layer only consumes its public API.
 */
/** The result of one v6 login attempt. */
export type MegaLoginResult = "ok" | "tfa_required" | "captcha_required" | "locked" | "failed";
/** Which backend a submitted 2FA code / captcha must be routed to. */
export type ChallengeSource = "mega" | "legacy";
/**
 * The narrow surface {@link MegaTransition} needs from {@link EufySecurity}. It is satisfied with a
 * small closure object (not `this`) so neither side has to expose private members nor import the
 * other — keeping the transition layer self-contained and removable.
 */
export interface MegaTransitionHost {
    readonly config: EufySecurityConfig;
    readonly persistentData: EufySecurityPersistentData;
    /** The live (legacy) transport, set once by {@link MegaTransition.createTransport}. */
    readonly api: HTTPApi;
    writePersistentData(): void;
    /** Re-emit the 2FA prompt to the consumer (ws / plugin). */
    emitTfaRequest(): void;
    /** Re-emit the captcha prompt to the consumer (ws / plugin). */
    emitCaptchaRequest(id: string, captcha: string): void;
    /** The original upstream `connect()` (login + trust device), unchanged. */
    legacyConnect(options?: LoginOptions): Promise<void>;
    /** Signal the app as connected (refresh + push + mqtt). Fired once at the end of the sequence. */
    onAPIConnect(): Promise<void>;
    onConnectionError(error: Error): void;
}
/**
 * Coordinates the v6-first login sequence. The v6 "eufy_mega" backend is the primary login (it
 * carries push and is where the account is heading); the legacy login runs afterwards as
 * best-effort and never blocks. Each backend has its OWN 2FA email + captcha; whichever asks
 * records itself in {@link pendingChallenge} so the code/captcha from the next connect() is routed
 * to the backend that asked for it. The app-ready signal fires ONCE, at the very end, and only if a
 * login succeeded.
 */
export declare class MegaTransition {
    private readonly host;
    private megaApi?;
    /**
     * Which backend a submitted 2FA code / captcha must be routed to. Set when WE emit the challenge,
     * so the next connect({verifyCode|captcha}) goes to the backend that asked for it — no guessing.
     * `undefined` = no challenge outstanding (start a fresh sequence).
     */
    private pendingChallenge?;
    /** Whether the v6 login succeeded this sequence (gates signalling the app as connected). */
    private megaLoggedIn;
    /** Serialises connect(): concurrent calls await the in-flight one instead of racing the sequence. */
    private connectInProgress?;
    constructor(host: MegaTransitionHost);
    /** Record that the LEGACY login asked for a code/captcha (called from the host's api-event hooks). */
    recordLegacyChallenge(): void;
    /**
     * Build the live transport. Today this is just the upstream legacy {@link HTTPApi}; the v6 mega
     * client is created lazily on demand (login / push) via {@link getMegaApi}. Kept as a single
     * factory so the transport can be swapped here if v6 ever needs to drive data requests too.
     */
    createTransport(persistentHttpApi: HTTPApiPersistentData | undefined): Promise<HTTPApi>;
    /**
     * Lazily create (and restore) the v6 mega client. The persisted session (token ~30 days) is
     * reused so normal startups need no extra login/2FA; it is dropped if the credentials changed.
     */
    getMegaApi(): Promise<MegaHTTPApi>;
    /**
     * Register the FCM token on the v6 backend, best-effort. No-ops with a log when there is no valid
     * v6 session yet (not-yet-migrated account); a v6 failure is swallowed so legacy push is unaffected.
     */
    registerMegaPushToken(token: string): Promise<boolean>;
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
    loginMega(verifyCode?: string, captcha?: {
        captchaId: string;
        answer: string;
    }): Promise<MegaLoginResult>;
    /** Serialised connect(): concurrent callers await the in-flight run instead of racing it. */
    connect(options?: LoginOptions): Promise<void>;
    private runConnect;
}
