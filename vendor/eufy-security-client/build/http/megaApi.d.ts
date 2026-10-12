import { type MegaIdentity } from "./megaCrypto";
import { MegaResult, MegaCaptcha, MegaCaptchaAnswer, MegaUserMqttInfo, MegaMqttConnectConfig, MegaApiOptions, MegaSession } from "./megaInterfaces";
export type { MegaResult, MegaCaptcha, MegaCaptchaAnswer, MegaUserMqttInfo, MegaMqttConnectConfig, MegaApiOptions, MegaSession, } from "./megaInterfaces";
/**
 * Eufy "eufy_mega" v6 backend client.
 *
 * Talks to the new per-service `*.eufy.com` microservices (behind APISIX) that the
 * official app 6.0.50+ uses. Each cluster (us-pr, eu-pr, …) requires its own
 * key/exchange handshake → per-cluster {@link MegaIdentity} (keyIdent + sharedKey).
 * Bodies are ECDH-encrypted (`X-Encryption-Info: algo_ecdh`) and every request is
 * signed (`X-Signature`).
 *
 * This is intentionally a SEPARATE class from HTTPApi: the legacy backend still
 * works for not-yet-migrated devices, so we don't want to risk that path.
 *
 * Heavily rate-limited (1 request / ~3s) — the Eufy WAF rate-limits aggressive probing.
 */
/** Per-cluster server static public key (uncompressed hex) for the ECIES bootstrap. */
export declare const MEGA_SERVER_STATIC_PUBKEY = "04ebc77a23c7191f8c97fb2a7676710f64ddadfe5305fa80c8855476b024c6ad3d8c18d4be9d720c5a578167f899e0818d3a19de2e804407034b4a88cfdb7ae995";
/**
 * Salted change-detection hash for the persisted session: invalidate the cached mega session when
 * the credentials change. Salted with the stable device id so a leaked persistent file isn't an
 * offline-cracking aid the way a bare md5(user:pass) would be.
 */
export declare const megaLoginHash: (email: string, password: string, openudid: string) => string;
export declare class MegaHTTPApi {
    private readonly ab;
    private readonly osType;
    private readonly appName;
    private readonly appVersion;
    private readonly osVersion;
    private readonly phoneModel;
    private readonly minIntervalMs;
    private got;
    private throttle;
    /** Resolved domains from estimate_domain (eufy_security, etc). */
    private domains;
    private megaDomain;
    /** One identity per cluster host (e.g. app-openapi-eu-pr.eufy.com). */
    private identities;
    /** eufy.com auth token (from passport/login on the new backend). */
    private authToken?;
    /** Unix seconds when authToken expires (from login `token_expires_at`). */
    private tokenExpiresAt?;
    private userId?;
    constructor(opts: MegaApiOptions);
    init(): Promise<void>;
    private get gtoken();
    /** Stable per-install device id (uuid-ish, 32 hex). Restored from a persisted session. */
    private openudid;
    /**
     * Low-level signed/encrypted POST to a v6 host.
     *
     * X-Signature covers the ENCRYPTED VALUE (the base64 ciphertext), not the JSON wrapper: for
     * key/exchange the body is `{"client_public_key":"<b64>"}` but only `<b64>` is signed; for
     * regular requests the body IS the ciphertext, so signed value == body.
     *
     * No got-level retry: the timestamp/nonce/signature are computed once per call and the backend
     * enforces a replay/timestamp window, so a got retry would resend a frozen signature and be
     * rejected. Retry above this method (recomputing the signature) if needed.
     *
     * @param host    full host (e.g. app-passport-eu-pr.eufy.com)
     * @param path    request path
     * @param payload plaintext object (encrypted with the cluster identity sharedKey)
     * @param identity cluster identity; if omitted, bootstrap mode (presetKey) is used
     */
    private signedPost;
    /** Decrypt a v6 response `data` field with a cluster identity sharedKey. */
    decryptForCluster(identity: MegaIdentity, dataB64: string): string;
    /** Resolve the region's mega domain + product domains. Body is cleartext JSON. */
    estimateDomain(): Promise<Record<string, string>>;
    /**
     * Perform a key/exchange against a cluster's openapi host and cache the identity.
     * @param openapiHost e.g. app-openapi-eu-pr.eufy.com
     */
    keyExchange(openapiHost: string): Promise<MegaIdentity>;
    /**
     * Region cluster host for a service, e.g. "passport" → app-passport-eu-pr.eufy.com.
     *
     * Derived from the `domain` returned by {@link estimateDomain} (the server decides the region,
     * the client does not guess it) by replacing the `mega` prefix with `app-{service}` — the same
     * transform the app does in MegaAppDomain.createByMega. Falls back to a us/eu guess only when
     * estimate_domain has not run yet (e.g. the bootstrap key/exchange before login).
     */
    clusterHost(service: string): string;
    getDomains(): Record<string, string>;
    getIdentity(host: string): MegaIdentity | undefined;
    setAuth(authToken: string, userId: string): void;
    /**
     * Export the full session so a later run can resume WITHOUT a fresh login/2FA.
     *
     * Mirrors the legacy HTTPApi's `persistentData`: once authenticated you ARE authenticated —
     * persist the token + user_id + the per-cluster ECDH identities (keyIdent/sharedKey) + the
     * stable device id. As long as the token hasn't expired, `restoreSession()` lets every signed
     * call go straight through (no estimate_domain / key/exchange / login replay).
     */
    exportSession(loginHash?: string): MegaSession;
    /** Restore a session previously produced by {@link exportSession}. */
    restoreSession(s: MegaSession): void;
    /**
     * True if we hold a non-expired auth token (60s safety margin) → no login replay needed.
     * An unknown expiry is treated as invalid (forces a relogin) rather than valid-forever.
     */
    hasValidSession(): boolean;
    /** Generic signed/encrypted call once an identity exists for the host's cluster. */
    call(host: string, path: string, payload: unknown): Promise<MegaResult>;
    /** {@link call} + decrypt the `data` field. Throws on non-zero code. */
    callDecrypted(service: string, path: string, payload?: unknown): Promise<unknown>;
    /**
     * MQTT connection info for the v6 backend (`devicemanage/get_user_mqtt_info`).
     * This is how events are pushed in v6 — broker endpoint + credentials + topics, returned
     * dynamically (unlike the legacy static `security-mqtt-eu.eufylife.com`). Decrypted.
     */
    getUserMqttInfo(): Promise<MegaUserMqttInfo>;
    /**
     * Build the full AWS IoT MQTT connection config for the v6 event channel. Fetches the per-user
     * certificate/credentials and combines them with the client identity so a consumer can connect
     * without touching MegaHTTPApi internals.
     *
     * NOTE: SCAFFOLDING — there is no MQTT subscriber consuming this yet. The v6 AWS IoT channel
     * only serves devices flagged `is_support_mqtt`; ordinary cameras/sensors are delivered over
     * FCM ({@link registerPushToken}). This builder is shipped ahead of a follow-up MQTT-consumer
     * change so that change won't need to touch MegaHTTPApi. It is NOT a live event path today.
     *
     * The `clientId` format is mandatory for the AWS IoT policy (decompiled `createClientId`):
     * `android-{app_name}-{user_id}-{openudid}`. Topics carry `PN`/`SN` placeholders to fill per
     * device. Requires a valid session.
     */
    getMqttConnectConfig(): Promise<MegaMqttConnectConfig>;
    /**
     * Register an FCM push token on the v6 backend (`push/register_push_token`).
     *
     * Body (decompiled `PushManager.uploadToken`): `{token, is_notification_enable, voip_token}`.
     * There is NO platform/type field in the body — the backend routes FCM vs APNs purely by the
     * `os-type` header + the `x-key-ident` identity this request is signed under. So this MUST run
     * on an `os-type: android` identity (the default here) for events to be delivered over FCM.
     */
    registerPushToken(fcmToken: string): Promise<MegaResult>;
    /** Encrypt the login password exactly like the legacy HTTPApi (ECDH vs LOGIN_SERVER_PUBLIC_KEY). */
    private encryptLoginPassword;
    /** Validate the email exists on the new backend (the app does this before login). */
    validateEmail(email: string): Promise<MegaResult>;
    /** The 2FA session id, shared between login (which triggers 2FA) and loginAfterTFA. */
    private loginId?;
    /**
     * Obtain a `login_id` (2FA session id). The app calls `passport/get_login_id` before login and
     * passes the SAME login_id to both the initial login and the post-2FA login. (Decompiled flow.)
     */
    getLoginId(): Promise<string>;
    /**
     * Login against the v6 passport backend.
     *
     * The body sends `login_id: ""`: `get_login_id`/`getTouchId` is for biometric (TouchID) login
     * only and must not be called in the email+2FA flow. On success the backend returns code:0 even
     * when 2FA is still pending — the real state is in `fa_info.step` (26052), and the returned token
     * is provisional but still used to authenticate the subsequent sendVerifyCode + final login.
     *
     * @param verifyCode email 2FA code (omit on first call; pass it on retry after code 26052)
     * @param captcha    picture-captcha answer (pass it after code 100032/100033 — see {@link generateCaptcha})
     * @returns the full MegaResult. Codes the caller acts on: 26052 = email 2FA required;
     *          100032 = captcha required, 100033 = captcha answer incorrect. On success, token+user stored.
     */
    login(email: string, password: string, verifyCode?: string, captcha?: MegaCaptchaAnswer): Promise<MegaResult>;
    /**
     * Request the email 2FA code (after login indicates fa_info.step 26052).
     *
     * Exact payload confirmed by decompiling the Ijiami-packed `SendVerifyCodeRequest`
     * (dumped from process memory): the 2FA-login send is `{message_type, biz_type, transaction}`
     * with `biz_type = 1004` (BIZ_TYPE_TFA) and `message_type = 2` (TYPE_EMAIL). No captcha for send.
     */
    sendVerifyCode(_email?: string): Promise<MegaResult>;
    /**
     * Fetch a picture captcha (after login returns 100032/100033). Body
     * `{captcha_type, biz_type}` (decompiled CaptchaManager.getCaptcha); the response `item` is a
     * base64 image the user must solve, then pass the answer + captcha_id back into {@link login}.
     */
    generateCaptcha(): Promise<MegaCaptcha>;
    /**
     * Fetch the Tuya/Thingclips device list (`get_things_list`) and DECRYPT it.
     * This is the probe to see whether a given device (e.g. Kitchen sensor) has been
     * migrated server-side onto the Tuya backend.
     */
    getThingsListDecrypted(productCodes?: string[]): Promise<unknown>;
    /** Eufy-side device list (`house/get_devs_list`), decrypted. The non-Tuya inventory. */
    getDevsListDecrypted(): Promise<unknown>;
}
