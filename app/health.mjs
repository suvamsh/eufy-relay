/**
 * health.mjs — per-device coverage health for the Eufy relay (Stage 2,
 * sweep v4.2; see RELAY-BUILD.md "Stage 2"). Pure helpers, unit-tested
 * offline in health.test.mjs. The sweep (sweep.mjs) owns the state and
 * the alert-marker files; this module owns the bookkeeping rules.
 *
 * State shape (top-level `health` in the data repo's state.json, keyed
 * by DEVICE name — additive; pre-v4.2 state simply has no `health` key):
 *
 *   health: { [deviceName]: {
 *     station,                        // station the device hangs off
 *     lastContactOkAt,                // ISO | null — a sweep reached the
 *                                     //   station AND latest-info answered
 *     lastContactFailAt,              // ISO | null
 *     lastContactFailKind,            // "p2p-connect" | "latest-info-timeout"
 *                                     //   | "latest-info-error" | null
 *     consecutiveFailedContacts,      // failed sweeps in a row (any kind)
 *     consecutiveLatestInfoTimeouts, // latest-info timeouts in a row
 *     lastEventStamp,                 // 14-digit device-local stamp of the
 *                                     //   newest event latest-info reported
 *                                     //   (null = no event ever seen)
 *     dark,                           // dark rule currently tripped
 *     darkSince,                      // ISO | null
 *     darkAlertLastRaisedAt,          // ISO | null — marker re-raise throttle
 *     lastLiveness,                   // null | { at, classification,
 *                                     //   failurePattern, bytes }
 *     lastProbeAt,                    // ISO | null — livestream probe time
 *   } }
 *
 * A "contact" is a sweep's attempt on the device's station: P2P connect
 * plus a latest-info answer. A livestream liveness probe is recorded
 * separately (lastLiveness) — it proves the CAMERA is alive, which is a
 * different fact from the event path being reachable, and the dark
 * alert carries the latest liveness classification so the two are
 * never conflated.
 */

export const DARK_FAILURE_THRESHOLD = 3; // consecutive failed contacts
export const DARK_SILENCE_MS = 6 * 60 * 60 * 1000; // >6h without a successful contact
export const DARK_RERAISE_MS = 24 * 60 * 60 * 1000; // re-raise a still-dark alert at most daily

export function defaultHealth(deviceName, stationName) {
    return {
        station: stationName ?? null,
        lastContactOkAt: null,
        lastContactFailAt: null,
        lastContactFailKind: null,
        consecutiveFailedContacts: 0,
        consecutiveLatestInfoTimeouts: 0,
        lastEventStamp: null,
        dark: false,
        darkSince: null,
        darkAlertLastRaisedAt: null,
        lastLiveness: null,
        lastProbeAt: null,
    };
}

/** Get-or-create the health record for a device inside a state object. */
export function deviceHealth(state, deviceName, stationName) {
    if (!state.health || typeof state.health !== "object") state.health = {};
    const existing = state.health[deviceName];
    if (existing && typeof existing === "object") {
        if (stationName && !existing.station) existing.station = stationName;
        return existing;
    }
    const fresh = defaultHealth(deviceName, stationName);
    state.health[deviceName] = fresh;
    return fresh;
}

/**
 * Record a successful contact (station connected, latest-info answered).
 * Clears the dark flag; `lastEventStamp` (14-digit, may be null when the
 * device reported no event path) advances only when newer.
 */
export function recordContactOk(h, nowIso, lastEventStamp) {
    h.lastContactOkAt = nowIso;
    h.consecutiveFailedContacts = 0;
    h.consecutiveLatestInfoTimeouts = 0;
    h.dark = false;
    h.darkSince = null;
    if (lastEventStamp && (!h.lastEventStamp || lastEventStamp > h.lastEventStamp)) {
        h.lastEventStamp = lastEventStamp;
    }
}

/**
 * Record a failed contact. kind: "p2p-connect" | "latest-info-timeout" |
 * "latest-info-error". Only a latest-info TIMEOUT advances the timeout
 * streak (a connect failure is a different failure mode).
 */
export function recordContactFail(h, nowIso, kind) {
    h.lastContactFailAt = nowIso;
    h.lastContactFailKind = kind;
    h.consecutiveFailedContacts += 1;
    if (kind === "latest-info-timeout") h.consecutiveLatestInfoTimeouts += 1;
}

/**
 * The dark-camera rule: a device is DARK when it has ≥3 consecutive
 * failed contacts, or when it has had a successful contact before and
 * the newest success is >6h old. (A device that has never been reached
 * and has <3 recorded failures is not yet dark — the counter is the
 * evidence; pre-v4.2 history is not back-filled into the counters.)
 */
export function evaluateDark(h, nowMs) {
    if (h.consecutiveFailedContacts >= DARK_FAILURE_THRESHOLD) {
        return { dark: true, reason: `${h.consecutiveFailedContacts} consecutive failed contacts` };
    }
    if (h.lastContactOkAt) {
        const okMs = Date.parse(h.lastContactOkAt);
        if (Number.isFinite(okMs) && nowMs - okMs > DARK_SILENCE_MS) {
            return { dark: true, reason: `no successful contact for >6h (last ok ${h.lastContactOkAt})` };
        }
    }
    return { dark: false, reason: null };
}

/**
 * Marker throttle: write the alert marker when the device is dark AND
 * no marker file is currently present AND the last raise (if any) is
 * older than DARK_RERAISE_MS. The review loop deletes marker files once
 * surfaced; while the device stays dark this re-raises at most daily.
 */
export function shouldWriteMarker(h, nowMs, markerExists) {
    if (markerExists) return false;
    if (!h.darkAlertLastRaisedAt) return true;
    const last = Date.parse(h.darkAlertLastRaisedAt);
    return !Number.isFinite(last) || nowMs - last > DARK_RERAISE_MS;
}

/** Record a livestream liveness probe outcome on the health record. */
export function recordLiveness(h, nowIso, { classification, failurePattern = null, bytes = 0 }) {
    h.lastProbeAt = nowIso;
    h.lastLiveness = { at: nowIso, classification, failurePattern, bytes };
}
