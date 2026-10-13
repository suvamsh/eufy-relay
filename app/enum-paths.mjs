/**
 * enum-paths.mjs — pure helpers for sweep v3 bounded path enumeration.
 *
 * The SoloCam / indoor snapshot path family (proven by Experiment L,
 * run 38358594501: station.downloadImage on a CONSTRUCTED path returned
 * byte-identical JPEGs for two past events):
 *
 *   /media/mmcblk0p1/Camera00/event/<YYYYMM>/<YYYYMMDD>/<YYYYMMDDHHMMSS>_snapshot.jpg
 *
 * The stamp is the camera's device-local wall time. Stamp arithmetic is
 * done on the wall-clock representation itself (the fields reinterpreted
 * as UTC), so +1s / -1s rolls over minutes, hours, days, months and years
 * exactly the way the camera's file naming does. Directory components are
 * always rebuilt from the target stamp, so a shifted path never inherits
 * a stale <YYYYMM>/<YYYYMMDD> from the template.
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

const ENUM_PATH_RE = /^(.*\/event\/)\d{6}\/\d{8}\/(\d{14})(_snapshot\.jpg)$/;

/**
 * If `p` belongs to the enumerable event-snapshot family, return a template
 * { head, stamp, tail }; otherwise null (e.g. the Front Door's
 * /media/mmcblk0p1/video/<stamp>_c00.jpg scheme is NOT enumerable here).
 */
export function parseEnumTemplate(p) {
    const m = String(p ?? "").match(ENUM_PATH_RE);
    return m ? { head: m[1], stamp: m[2], tail: m[3] } : null;
}

/** Rebuild a full on-device snapshot path for a target 14-digit stamp. */
export function buildEnumPath(template, digits) {
    const d = String(digits);
    return `${template.head}${d.slice(0, 6)}/${d.slice(0, 8)}/${d}${template.tail}`;
}
