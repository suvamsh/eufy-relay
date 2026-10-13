/**
 * image-channel.mjs — response attribution for P2P image downloads
 * (sweep v4.1 hardening; see RELAY-BUILD.md "Sweep v4.1").
 *
 * The vendored client surfaces every image a station sends as a
 * client-level "station image download" event (station, file, image).
 * The `file` is NOT echoed from our request by the client: the p2p
 * session emits whatever path string the STATION put in its
 * CMD_DATABASE_IMAGE response payload (vendor p2p/session.js:
 * `this.emit("image download", image.file, ...)`). Attribution of a
 * response to a request therefore rests on two checks, both enforced
 * here:
 *
 *   1. STATION: the event's station serial must equal this channel's
 *      station. SoloCam stations share an identical on-device path
 *      scheme, so the same path STRING can be pending on different
 *      stations at different times — and every channel ever created
 *      stays registered on the client for the whole run. Without the
 *      serial check, a late image event from station A could settle a
 *      pending request for the same path string on station B.
 *   2. FILE: the event's file must exactly equal a currently pending
 *      requested path. Anything else — a stray response, a response
 *      for a different path, a late response for a request that has
 *      already timed out — is dropped, never credited.
 *
 * Why this matters (Experiment R / R2, Oct 13, 2026): a probe helper
 * that matched image events by STATION ONLY requested the (nonexistent)
 * path ...20261013122500 and, 1.4 s later, received the station's newest
 * snapshot (...20261013124251) — and credited it to the requested path.
 * A file-strict follow-up proved 122500 has no file at all. Production
 * always keyed on the event's file (check 2); v4.1 adds check 1 and
 * extracts the logic here so the race is covered by offline tests.
 */
export class ImageAttribution {
    constructor(stationSerial) {
        this.stationSerial = stationSerial;
        this.pending = new Map(); // filePath -> {resolve, reject, timer}
    }

    has(filePath) {
        return this.pending.has(filePath);
    }

    /** Register one outstanding request. Throws if the path is already pending. */
    register(filePath, entry) {
        if (this.pending.has(filePath)) throw new Error("an image download is already outstanding for this path");
        this.pending.set(filePath, entry);
    }

    /** Remove a pending entry WITHOUT settling it (send-failure cleanup). */
    drop(filePath) {
        const entry = this.pending.get(filePath);
        if (!entry) return false;
        clearTimeout(entry.timer);
        this.pending.delete(filePath);
        return true;
    }

    /** Remove a pending entry on timeout and return it so the caller can reject it. */
    expire(filePath) {
        const entry = this.pending.get(filePath);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(filePath);
        return entry;
    }

    /**
     * Route one "station image download" event. Settles (resolves) the
     * pending request only when the event is from THIS station and its
     * file exactly matches a pending path. Returns true iff a request
     * was settled; every other event is dropped.
     */
    route(stationSerial, file, image) {
        if (stationSerial !== this.stationSerial) return false;
        const entry = this.pending.get(file);
        if (!entry) return false;
        clearTimeout(entry.timer);
        this.pending.delete(file);
        entry.resolve(image);
        return true;
    }
}
