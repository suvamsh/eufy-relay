/**
 * session-lib.mjs — shared session-copy handling for the relay fleet
 * (Session permanence, Oct 13, 2026; see RELAY-BUILD.md "Session permanence").
 *
 * A "session copy" is one persistent.json document as written by the
 * vendored eufy-security-client: top-level legacy fields (cloud_token,
 * cloud_token_expiration in ms epoch) plus a nested megaApi object
 * (cloud_token, cloud_token_expiration in SECONDS epoch). This module
 * only ever inspects STRUCTURE and EXPIRY DATES — token values are never
 * logged, returned in messages, or compared anywhere.
 *
 * Mechanics that shape everything here (established from the vendored
 * client source): Eufy issues both tokens at login with a server-set
 * expiry (~30 days). There is NO refresh-token flow in the client — the
 * legacy api's "renewal" (HTTPApi.scheduleRenewAuthToken) is a forced
 * password re-login at expiry-24h, and the mega api has no renewal at
 * all. Using a session does not extend it. Copies therefore never
 * "rotate" on their own; the canonical copy in the data repo only
 * changes when the session keeper performs a real login.
 */

export const GATE_MARGIN_MS = 60_000; // same 60s margin as the apps' offline gates
export const RENEW_MARGIN_MS = 72 * 60 * 60 * 1000; // keeper renews when <72h of legacy life remains

export function expiryToMs(value) {
    if (value === undefined || value === null || value === 0 || value === "") return null;
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string") {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && asNumber > 0) return expiryToMs(asNumber);
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

/**
 * Structural validation of one parsed session copy. Never touches token
 * values beyond presence/type checks.
 * Returns { ok, problems, legacyExpiryMs, megaExpiryMs }.
 * ok requires: legacy token present + parseable expiry; mega object with
 * token + user_id + parseable expiry. (Expiries may still be in the past;
 * that is a classification, not a shape problem — see classifySession.)
 */
export function validateSessionShape(obj) {
    const problems = [];
    let legacyExpiryMs = null;
    let megaExpiryMs = null;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, problems: ["not a JSON object"], legacyExpiryMs, megaExpiryMs };
    }
    if (typeof obj.cloud_token !== "string" || obj.cloud_token.length === 0) {
        problems.push("legacy cloud_token missing/not a string");
    }
    legacyExpiryMs = expiryToMs(obj.cloud_token_expiration);
    if (legacyExpiryMs === null) problems.push("legacy cloud_token_expiration missing/unparseable");
    const mega = obj.megaApi;
    if (!mega || typeof mega !== "object" || Array.isArray(mega)) {
        problems.push("megaApi object missing");
    } else {
        if (typeof mega.cloud_token !== "string" || mega.cloud_token.length === 0) {
            problems.push("mega cloud_token missing/not a string");
        }
        if (typeof mega.user_id !== "string" || mega.user_id.length === 0) {
            problems.push("mega user_id missing/not a string");
        }
        megaExpiryMs = expiryToMs(mega.cloud_token_expiration);
        if (megaExpiryMs === null) problems.push("mega cloud_token_expiration missing/unparseable");
    }
    return { ok: problems.length === 0, problems, legacyExpiryMs, megaExpiryMs };
}

/**
 * Classify a shape-valid copy: "usable" when both tokens outlive
 * now+margin, "expiring" when usable but inside the renew margin,
 * "expired" when either token is at/past now+margin. Token expiry is
 * decisive on the LEGACY token for the fleet's offline gates, but a copy
 * whose mega half died early is not a healthy canonical copy either, so
 * both must clear the bar.
 */
export function classifySession(shape, now = Date.now()) {
    if (!shape.ok) return "invalid";
    const { legacyExpiryMs, megaExpiryMs } = shape;
    if (legacyExpiryMs <= now + GATE_MARGIN_MS || megaExpiryMs <= now + GATE_MARGIN_MS) return "expired";
    if (legacyExpiryMs <= now + RENEW_MARGIN_MS || megaExpiryMs <= now + RENEW_MARGIN_MS) return "expiring";
    return "usable";
}

/** Parse raw text into a validated copy descriptor; never throws. */
export function parseSessionCopy(text) {
    let obj = null;
    try {
        obj = JSON.parse(text);
    } catch {
        return { obj: null, shape: { ok: false, problems: ["unparseable JSON"], legacyExpiryMs: null, megaExpiryMs: null } };
    }
    return { obj, shape: validateSessionShape(obj) };
}

/**
 * Pick the fleet's restore source. Candidates are tried in fleet order:
 *   1. "data-repo"  — the canonical copy the keeper maintains
 *   2. "actions-secret" — the bootstrap/fallback secret copy
 * A candidate wins when it is shape-valid AND classified "usable" or
 * "expiring" (i.e. its tokens still clear the offline gate). An expired
 * or invalid data-repo copy NEVER shadows a usable secret copy, and an
 * invalid candidate never shadows anything. Returns
 * { source, text, shape, classification } or null.
 */
export function chooseSessionSource(candidates, now = Date.now()) {
    for (const candidate of candidates) {
        if (!candidate || typeof candidate.text !== "string" || candidate.text.length === 0) continue;
        const { shape } = parseSessionCopy(candidate.text);
        const classification = classifySession(shape, now);
        if (classification === "usable" || classification === "expiring") {
            return { source: candidate.source, text: candidate.text, shape, classification };
        }
    }
    return null;
}

export function isoOrNull(ms) {
    return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}
