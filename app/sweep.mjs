#!/usr/bin/env node
/**
 * sweep.mjs — production Eufy relay sweep (runs in GitHub Actions).
 *
 * One run:
 *   1. Restores the stored GUEST session passwordlessly (no login is ever
 *      attempted here — no password exists in this environment; the vendored
 *      client's session-reuse patch accepts the stored session as-is).
 *   2. For each station (staggered, in STATION_ORDER): connects over P2P
 *      (one retry after a 20 s settle), then asks the station for its
 *      latest-event info (databaseQueryLatestInfo): per device, the total
 *      event count and the on-device path of the newest event's snapshot.
 *   3. For every device whose snapshot path changed since the last sweep,
 *      downloads that snapshot (downloadImage) and writes one bundle into
 *      the data repo checkout: inbox/<station>-<device>-<yyyymmddhhmmss>/
 *      {record.json, thumb.*}. A station's state advances ONLY after its
 *      bundles are fully written; a failed station keeps its old state and
 *      the sweep continues with the next station.
 *
 * WHY LATEST-INFO AND NOT THE EVENT-DATABASE QUERIES (firmware reality,
 * live-proven Oct 12-13, 2026 — runs 38322895407 / 38324139181, diags
 * 38324474756 / 38325670602; same behaviour reported upstream for this
 * client version in bropat/eufy-security-client issue #963, owner + LAN):
 *   - databaseQueryByDate: never answers on any station (and drops the
 *     P2P connection in the upstream report).
 *   - databaseQueryLocal: answers returnCode 0 with ZERO records on every
 *     station, even where databaseCountByDate reports dozens of records.
 *   - databaseCountByDate + databaseQueryLatestInfo DO answer, and
 *     downloadImage on the latest-info snapshot path delivers a real JPEG
 *     (verified: 21,505 bytes from the Front Door, JPEG magic confirmed).
 * Consequences, by design: each sweep delivers the NEWEST event snapshot
 * per device (plus the event-count delta, so events that arrived between
 * sweeps are counted even though only the newest is fetchable), and clips
 * are not available through this path on current firmware.
 *
 * Battery discipline: one latest-info round per station per sweep (the
 * client also auto-queries latest-info on connect). Timeouts get ONE
 * retry — battery cameras routinely answer only on the second ask.
 *
 * Event times come from the snapshot filename (a 14-digit device-local
 * timestamp, America/Los_Angeles), converted to true epoch instants with
 * the same reinterpretation helpers as harness/pull-p2p-24h.mjs.
 *
 * Logs never contain station/device serials or session material: stations
 * and devices are referred to by name only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_DIR = path.join(ROOT, "vendor", "eufy-security-client");
const VENDOR_ENTRY = path.join(VENDOR_DIR, "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR ? path.resolve(process.env.RELAY_DATA_DIR) : path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const INBOX_DIR = path.join(DATA_DIR, "inbox");
const DEVICE_TZ = "America/Los_Angeles";

const STATION_ORDER = ["WifiBridge", "Porch", "Backyard", "Sideyard", "Living Room"];
const GLOBAL_STATION_BUDGET_MS = 20 * 60_000; // abort NEW station work after 20 min
const HARD_WATCHDOG_MS = 28 * 60_000;
const CONNECT_TIMEOUT_MS = 90_000;
const CONNECT_SETTLE_MS = 20_000;
const LATEST_TIMEOUT_MS = 45_000;
const LATEST_SETTLE_MS = 10_000;
const IMAGE_TIMEOUT_MS = 30_000;
const STATION_GAP_MS = 5_000;

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => {
    const m = e instanceof Error ? e.message : String(e);
    return m.replace(/\s+/g, " ").slice(0, 240);
};
const isTimeoutErr = (e) => /timed out|timeout/i.test(e instanceof Error ? e.message : String(e));
const slugify = (name) =>
    String(name ?? "station")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "station";

// ---------------------------------------------------------------------------
// timezone helpers (mirrors pull-p2p-24h.mjs)
// ---------------------------------------------------------------------------
function tzOffsetMs(timeZone, utcMs) {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/** Device-local wall time (from a snapshot path's 14-digit stamp) -> epoch ms. */
function wallStampToMs(digits) {
    const y = +digits.slice(0, 4);
    const mo = +digits.slice(4, 6);
    const d = +digits.slice(6, 8);
    const h = +digits.slice(8, 10);
    const mi = +digits.slice(10, 12);
    const s = +digits.slice(12, 14);
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let utc = guess - tzOffsetMs(DEVICE_TZ, guess);
    utc = guess - tzOffsetMs(DEVICE_TZ, utc); // refine once
    return utc;
}
/** First 14-digit timestamp embedded in an on-device snapshot path. */
function parsePathStamp(p) {
    const m = String(p ?? "").match(/(\d{14})/);
    return m ? m[1] : null;
}
const fmtLocal = (ms) => {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: DEVICE_TZ,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second} PT`;
};

// ---------------------------------------------------------------------------
// session gate (mirrors probe.mjs)
// ---------------------------------------------------------------------------
function expiryToMs(value) {
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

// ---------------------------------------------------------------------------
// state (data repo: state.json)
//   { stations: { [stationName]: { watermarkMs, devices: {
//       [deviceName]: { cropPath, eventCount } } } } }
// ---------------------------------------------------------------------------
function loadState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.stations && typeof parsed.stations === "object") return parsed;
        log("state.json has unexpected shape — starting from empty state");
    } catch {
        log("no readable state.json — starting from empty state");
    }
    return { stations: {} };
}
function saveState(state) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}
function stationState(state, name) {
    const raw = state.stations[name] ?? {};
    state.stations[name] = {
        watermarkMs: typeof raw.watermarkMs === "number" && raw.watermarkMs > 0 ? raw.watermarkMs : null,
        devices: raw.devices && typeof raw.devices === "object" ? raw.devices : {},
    };
    return state.stations[name];
}

// ---------------------------------------------------------------------------
// P2P connect (mirrors probe.mjs ensureP2PConnected)
// ---------------------------------------------------------------------------
function ensureP2PConnected(station, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let done = false;
        let lastError = null;
        const finish = (connected, error) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            clearInterval(poller);
            station.off("connect", onConnect);
            station.off("connection error", onError);
            resolve({ connected, error: error ?? null });
        };
        const onConnect = () => finish(true, null);
        const onError = (_st, err) => {
            lastError = err instanceof Error ? err.message : String(err);
        };
        const deadline = setTimeout(() => finish(station.isConnected(), lastError ?? `no P2P connection within ${timeoutMs}ms`), timeoutMs);
        const poller = setInterval(() => {
            if (station.isConnected()) finish(true, null);
        }, 1_000);
        station.on("connect", onConnect);
        station.on("connection error", onError);
        if (station.isConnected()) {
            finish(true, null);
            return;
        }
        Promise.resolve()
            .then(() => station.connect())
            .catch((e) => {
                lastError = e instanceof Error ? e.message : String(e);
            });
    });
}

// ---------------------------------------------------------------------------
// per-station channel: latest-info + image download over client events,
// one retry on timeouts (battery cameras often answer only the second ask)
// ---------------------------------------------------------------------------
class StationChannel {
    constructor(client, station) {
        this.client = client;
        this.station = station;
        this.serial = station.getSerial();
        this.name = station.getName();
        this.pendingLatest = null; // {resolve, reject, timer}
        this.pendingImages = new Map(); // filePath -> {resolve, reject, timer}
        this.client.on("station database query latest", (station, returnCode, data) => {
            if (station?.getSerial?.() !== this.serial || !this.pendingLatest) return;
            const pending = this.pendingLatest;
            this.pendingLatest = null;
            clearTimeout(pending.timer);
            if (returnCode !== 0) pending.reject(new Error(`latest-info returned code ${returnCode}`));
            else pending.resolve(Array.isArray(data) ? data : []);
        });
        this.client.on("station image download", (station, file, image) => {
            const pending = this.pendingImages.get(file);
            if (!pending) return;
            this.pendingImages.delete(file);
            clearTimeout(pending.timer);
            pending.resolve(image);
        });
    }

    async latestInfoOnce() {
        if (this.pendingLatest) throw new Error("a latest-info request is already outstanding");
        const p = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingLatest = null;
                reject(new Error(`timeout after ${LATEST_TIMEOUT_MS}ms waiting for latest-info`));
            }, LATEST_TIMEOUT_MS);
            this.pendingLatest = { resolve, reject, timer };
        });
        try {
            this.station.databaseQueryLatestInfo();
        } catch (e) {
            if (this.pendingLatest) {
                clearTimeout(this.pendingLatest.timer);
                this.pendingLatest = null;
            }
            throw e;
        }
        return p;
    }

    async latestInfo() {
        try {
            return await this.latestInfoOnce();
        } catch (e) {
            if (!isTimeoutErr(e)) throw e;
            log(`  ${this.name}: latest-info timed out — settle ${LATEST_SETTLE_MS / 1000}s, one retry`);
            await sleep(LATEST_SETTLE_MS);
            return await this.latestInfoOnce();
        }
    }

    async downloadImageOnce(filePath) {
        if (this.pendingImages.has(filePath)) throw new Error("an image download is already outstanding for this path");
        const p = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingImages.delete(filePath);
                reject(new Error(`timeout after ${IMAGE_TIMEOUT_MS}ms waiting for image download`));
            }, IMAGE_TIMEOUT_MS);
            this.pendingImages.set(filePath, { resolve, reject, timer });
        });
        try {
            this.station.downloadImage(filePath);
        } catch (e) {
            const pending = this.pendingImages.get(filePath);
            if (pending) {
                this.pendingImages.delete(filePath);
                clearTimeout(pending.timer);
            }
            throw e;
        }
        const image = await p;
        const buf = Buffer.isBuffer(image) ? image : image?.data ? Buffer.from(image.data) : null;
        if (!buf || buf.length === 0) throw new Error("image download returned no data");
        return buf;
    }

    async downloadImage(filePath) {
        try {
            return await this.downloadImageOnce(filePath);
        } catch (e) {
            if (!isTimeoutErr(e)) throw e;
            log(`  ${this.name}: image download timed out — one retry`);
            await sleep(3_000);
            return await this.downloadImageOnce(filePath);
        }
    }
}

// ---------------------------------------------------------------------------
// image sniffing (mirrors watcher isImageBuffer semantics)
// ---------------------------------------------------------------------------
function sniffImage(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
    if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) return ".gif";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
    return ".jpg";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let client = null;
const watchdog = setTimeout(() => {
    console.error(`${stamp()} WATCHDOG: hard budget exceeded — exiting so completed stations can still be committed`);
    try {
        client?.close();
    } catch {
        /* ignore */
    }
    console.log("SWEEP DONE");
    process.exit(0);
}, HARD_WATCHDOG_MS);
watchdog.unref?.();

async function main() {
    if (!USERNAME) {
        console.error("FATAL: EUFY_USERNAME is not set (Actions secret missing) — refusing to start");
        process.exit(1);
    }
    // ---- session gate (offline; no password, no login attempt) -------------
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    } catch {
        console.error("FATAL: no stored session file — cannot run session-only sweep");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("FATAL: stored legacy token missing/expired — session-only sweep refused");
        process.exit(1);
    }
    log(`session gate ok: legacy token expires ${new Date(legacyExpiryMs).toISOString()}`);

    const { EufySecurity } = await import(VENDOR_ENTRY);
    let challengeSeen = null;
    client = await EufySecurity.initialize({
        username: USERNAME,
        password: "",
        country: COUNTRY,
        language: "en",
        trustedDeviceName: "gg-watcher",
        persistentDir: PERSISTENT_DIR,
        p2pConnectionSetup: 2,
        pollingIntervalMinutes: 10,
        eventDurationSeconds: 10,
        acceptInvitations: true,
        logging: { level: 4 }, // Error only: client debug logs would dump raw payloads
    });
    try {
        client.setLoggingLevel?.("all", 4);
    } catch {
        /* best-effort */
    }
    client.on("tfa request", () => {
        challengeSeen ??= "verify_code";
    });
    client.on("captcha request", () => {
        challengeSeen ??= "captcha";
    });
    await client.connect();
    if (challengeSeen) {
        console.error(`FATAL: server requested re-authentication (${challengeSeen}) — session-only sweep aborted`);
        process.exit(1);
    }
    log("cloud connected (session-only)");

    let stations = [];
    let devices = [];
    const devDeadline = Date.now() + 60_000;
    while (Date.now() < devDeadline) {
        stations = await client.getStations();
        devices = await client.getDevices();
        if (devices.length > 0 && stations.length > 0) break;
        await sleep(2_000);
    }
    if (stations.length === 0) {
        console.error("FATAL: session restored but zero stations returned");
        process.exit(1);
    }
    log(`stations: ${stations.map((s) => s.getName()).join(", ")}`);
    log(`devices: ${devices.map((d) => `${d.getName()} (${d.getModel()})`).join(", ")}`);

    const deviceBySerial = new Map(devices.map((d) => [d.getSerial(), d]));
    const state = loadState();
    fs.mkdirSync(INBOX_DIR, { recursive: true });

    const ordered = [
        ...STATION_ORDER.map((n) => stations.find((s) => s.getName() === n)).filter(Boolean),
        ...stations.filter((s) => !STATION_ORDER.includes(s.getName())),
    ];

    for (const station of ordered) {
        const name = station.getName();
        if (Date.now() - t0 > GLOBAL_STATION_BUDGET_MS) {
            log(`SWEEP station=${name} SKIP time budget (20 min) reached — remaining stations deferred to next run`);
            continue;
        }
        const result = await sweepStation({ station, state, deviceBySerial }).catch((e) => ({
            ok: false,
            reason: shortErr(e),
        }));
        if (result.ok) {
            console.log(`SWEEP station=${name} new=${result.newCount} thumbs=${result.thumbs} clips=${result.clips}`);
        } else {
            console.log(`SWEEP station=${name} FAIL ${result.reason}`);
        }
        try {
            station.close?.();
        } catch {
            /* ignore */
        }
        await sleep(STATION_GAP_MS);
    }

    console.log("SWEEP DONE");
    try {
        client.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

async function sweepStation({ station, state, deviceBySerial }) {
    const name = station.getName();
    const stState = stationState(state, name);

    // ---- connect (one retry after a 20 s settle) ---------------------------
    let conn = await ensureP2PConnected(station, CONNECT_TIMEOUT_MS);
    if (!conn.connected) {
        log(`${name}: connect failed (${conn.error ?? "unknown"}) — settle ${CONNECT_SETTLE_MS / 1000}s, one retry`);
        try {
            station.close?.();
        } catch {
            /* ignore */
        }
        await sleep(CONNECT_SETTLE_MS);
        conn = await ensureP2PConnected(station, CONNECT_TIMEOUT_MS);
        if (!conn.connected) return { ok: false, reason: `P2P connect failed: ${conn.error ?? "unknown"}` };
    }
    log(`${name}: P2P connected`);

    // ---- latest-event info ---------------------------------------------------
    const channel = new StationChannel(client, station);
    let latest;
    try {
        latest = await channel.latestInfo();
    } catch (e) {
        return { ok: false, reason: `latest-info failed: ${shortErr(e)}` };
    }
    log(`${name}: latest-info answered for ${latest.length} device(s)`);

    let newCount = 0;
    let thumbs = 0;
    let dirty = false;
    let maxEventMs = stState.watermarkMs ?? 0;

    for (const entry of latest) {
        const deviceObj = entry.device_sn ? deviceBySerial.get(entry.device_sn) : undefined;
        const deviceName = deviceObj?.getName() ?? null;
        if (!deviceName) {
            log(`${name}: latest-info entry for an unknown device — skipped`);
            continue;
        }
        const cropPath = entry.crop_local_path || entry.crop_cloud_path || null;
        const eventCount = typeof entry.event_count === "number" ? entry.event_count : null;
        const storedDev = stState.devices[deviceName] ?? null;
        if (!cropPath) {
            log(`${name}: ${deviceName}: no snapshot path in latest-info (event_count=${eventCount})`);
            continue;
        }
        if (storedDev?.cropPath === cropPath) {
            if (storedDev.eventCount !== eventCount) {
                storedDev.eventCount = eventCount;
                dirty = true;
            }
            log(`${name}: ${deviceName}: no new event (event_count=${eventCount})`);
            continue;
        }

        // ---- new latest event for this device --------------------------------
        const digits = parsePathStamp(cropPath);
        const eventMs = digits ? wallStampToMs(digits) : null;
        const countDelta = storedDev && eventCount !== null && typeof storedDev.eventCount === "number" ? eventCount - storedDev.eventCount : null;
        log(
            `${name}: ${deviceName}: NEW event ${digits ? fmtLocal(eventMs) : "(unstamped path)"} ` +
                `(event_count=${eventCount}${countDelta !== null ? `, delta=${countDelta}` : ""})`,
        );
        const bundleName = `${slugify(name)}-${slugify(deviceName)}-${digits ?? `count${eventCount ?? "x"}`}`;
        const bundleDir = path.join(INBOX_DIR, bundleName);

        if (fs.existsSync(path.join(bundleDir, "record.json"))) {
            // Already delivered by an earlier run whose state write was lost.
            log(`${name}: ${deviceName}: bundle ${bundleName} already in inbox — marking seen without re-download`);
        } else {
            fs.mkdirSync(bundleDir, { recursive: true });
            const bundle = {
                recordId: bundleName,
                station: name,
                device: deviceName,
                model: deviceObj?.getModel() ?? null,
                source: "latest-info",
                startUtc: eventMs !== null ? new Date(eventMs).toISOString() : null,
                endUtc: eventMs !== null ? new Date(eventMs).toISOString() : null,
                startMs: eventMs,
                endMs: eventMs,
                startLocal: eventMs !== null ? fmtLocal(eventMs) : null,
                endLocal: eventMs !== null ? fmtLocal(eventMs) : null,
                durationSec: null,
                triggerType: null,
                triggerName: null,
                videoType: null,
                videoName: null,
                personFlagged: null, // latest-info carries no classification; GG judges the snapshot
                eventCount,
                countDelta,
                thumbFile: null,
                thumbBytes: null,
                thumbError: null,
                clipFile: null,
                clipBytes: null,
                clipError: null,
                clipSkipped:
                    "clips are not reachable on current firmware: the event-database row queries return nothing (see RELAY-BUILD.md); only the newest event snapshot per device is exposed",
                sweptAt: new Date().toISOString(),
            };
            try {
                const buf = await channel.downloadImage(cropPath);
                const file = `thumb${sniffImage(buf)}`;
                fs.writeFileSync(path.join(bundleDir, file), buf);
                bundle.thumbFile = file;
                bundle.thumbBytes = buf.length;
                thumbs++;
            } catch (e) {
                bundle.thumbError = shortErr(e);
                log(`${name}: ${deviceName}: snapshot download failed: ${shortErr(e)}`);
            }
            // record.json last: a bundle dir containing record.json is complete
            fs.writeFileSync(path.join(bundleDir, "record.json"), JSON.stringify(bundle, null, 2));
            newCount++;
        }

        // state for this device advances only now (bundle fully written)
        stState.devices[deviceName] = { cropPath, eventCount };
        dirty = true;
        if (eventMs !== null && eventMs > maxEventMs) maxEventMs = eventMs;
    }

    if (maxEventMs > (stState.watermarkMs ?? 0)) stState.watermarkMs = maxEventMs;
    if (dirty) {
        saveState(state);
        log(`${name}: state saved (watermark=${stState.watermarkMs === null ? "none" : new Date(stState.watermarkMs).toISOString()})`);
    } else {
        log(`${name}: no changes`);
    }
    return { ok: true, newCount, thumbs, clips: 0 };
}

main().catch((e) => {
    console.error(`FATAL: ${shortErr(e)}`);
    try {
        client?.close();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
