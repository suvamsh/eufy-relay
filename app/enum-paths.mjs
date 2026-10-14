/**
 * enum-paths.mjs — pure helpers for sweep path enumeration.
 *
 * Two enumerable snapshot path families (constructed paths proven by
 * Experiment L, run 38358594501, and exp-r, run 38467181060:
 * station.downloadImage on a CONSTRUCTED path returns the event's
 * byte-identical JPEG; a nonexistent path gets silence):
 *
 *   event family (SoloCam / indoor, sweep v3):
 *     /media/mmcblk0p1/Camera00/event/<YYYYMM>/<YYYYMMDD>/<YYYYMMDDHHMMSS>_snapshot.jpg
 *
 *   front-door family (doorbell via WifiBridge, sweep v4.2):
 *     /media/mmcblk0p1/video/<YYYYMMDDHHMMSS>_c00.jpg
 *     (snapshots only — Experiment O proved no clip path/cipher works
 *     for this family, so enumeration never derives clips from it)
 *
 * The stamp is the camera's device-local wall time. Stamp arithmetic is
 * done on the wall-clock representation itself (the fields reinterpreted
 * as UTC), so +1s / -1s rolls over minutes, hours, days, months and years
 * exactly the way the camera's file naming does. For the event family the
 * directory components are always rebuilt from the target stamp, so a
 * shifted path never inherits a stale <YYYYMM>/<YYYYMMDD> from the
 * template; the front-door family has no date directories.
 */

export function stampToWallMs(digits) {
    return Date.UTC(
        +digits.slice(0, 4),
        +digits.slice(4, 6) - 1,
        +digits.slice(6, 8),
        +digits.slice(8, 10),
        +digits.slice(10, 12),
        +digits.slice(12, 14),
    );
}

export function wallMsToStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return (
        `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
    );
}

/** Shift a 14-digit wall-clock stamp by deltaSeconds (may be negative). */
export function shiftStamp(digits, deltaSeconds) {
    return wallMsToStamp(stampToWallMs(digits) + deltaSeconds * 1000);
}

const EVENT_PATH_RE = /^(.*\/event\/)\d{6}\/\d{8}\/(\d{14})(_snapshot\.jpg)$/;
const FRONT_DOOR_PATH_RE = /^(.*\/video\/)(\d{14})(_c00\.jpg)$/;

/**
 * If `p` belongs to an enumerable snapshot family, return a template
 * { family, head, stamp, tail }; otherwise null. Families:
 * "event" (SoloCam/indoor) and "front-door" (doorbell, v4.2).
 */
export function parseEnumTemplate(p) {
    const s = String(p ?? "");
    const ev = s.match(EVENT_PATH_RE);
    if (ev) return { family: "event", head: ev[1], stamp: ev[2], tail: ev[3] };
    const fd = s.match(FRONT_DOOR_PATH_RE);
    if (fd) return { family: "front-door", head: fd[1], stamp: fd[2], tail: fd[3] };
    return null;
}

/** Rebuild a full on-device snapshot path for a target 14-digit stamp. */
export function buildEnumPath(template, digits) {
    const d = String(digits);
    if (template.family === "front-door") return `${template.head}${d}${template.tail}`;
    return `${template.head}${d.slice(0, 6)}/${d.slice(0, 8)}/${d}${template.tail}`;
}

/**
 * v4.2 cluster-first enumeration: the stamps within ±radiusSec of an
 * anchor stamp, clipped to the open window (fromExclusive, toExclusive),
 * ascending. Missed events arrive in bursts around captured ones, so the
 * sweep probes these windows BEFORE resuming its ascending cursor scan.
 * The anchor itself is included when it lies inside the window (callers
 * filter already-probed/delivered stamps via their scanned set).
 */
export function clusterWindowStamps(anchor, fromExclusive, toExclusive, radiusSec = 300) {
    const anchorMs = stampToWallMs(anchor);
    const fromMs = stampToWallMs(fromExclusive);
    const toMs = stampToWallMs(toExclusive);
    const lo = Math.max(anchorMs - radiusSec * 1000, fromMs + 1000);
    const hi = Math.min(anchorMs + radiusSec * 1000, toMs - 1000);
    const out = [];
    for (let ms = lo; ms <= hi; ms += 1000) out.push(wallMsToStamp(ms));
    return out;
}
