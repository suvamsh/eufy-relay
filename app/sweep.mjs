#!/usr/bin/env node
/**
 * sweep.mjs — production Eufy relay sweep (runs in GitHub Actions).
 *
 * One run:
 *   1. Restores the stored GUEST session passwordlessly (no login is ever
 *      attempted here — no password exists in this environment; the vendored
 *      client's session-reuse patch accepts the stored session as-is).
 *   2. For each station (staggered, in STATION_ORDER): connects over P2P
 *      (one retry after a 20 s settle), queries the station's on-device event
 *      database (databaseQueryByDate, per device-local day) from that
 *      station's watermark in the data repo's state.json to now, and for
 *      every NEW record downloads the thumbnail (always) and the clip
 *      (person-flagged records, or Backyard / Sideyard / Living Room /
 *      Front Door devices; clips are capped at 60 MB).
 *   3. Writes one bundle per new record into the data repo checkout:
 *      inbox/<stationSlug>-<recordId>/{record.json, thumb.*, clip.mp4}.
 *   4. Advances a station's watermark + seen record IDs in state.json ONLY
 *      after that station's bundles are fully written. A station that fails
 *      keeps its old watermark; the sweep continues with the next station.
 *
 * Hardening (from the probe's Porch count timeout): every DB operation
 * (count, query, downloads) gets ONE retry; on a timeout the retry is
 * preceded by a databaseQueryLatestInfo warm-up call that re-proves the
 * station's DB channel.
 *
 * Time handling mirrors harness/pull-p2p-24h.mjs: the client parses device
 * timestamps as runner-local (UTC in Actions), so a parsed Date's UTC
 * components ARE the device wall time (America/Los_Angeles); they are
 * reinterpreted as such to obtain true epoch instants.
 *
 * Logs never contain station/device serials or session material: stations
 * and devices are referred to by name only.
 */
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
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
const CLIP_DEVICE_NAMES = new Set(["Backyard", "Sideyard", "Living Room", "Front Door"]);
const FIRST_WINDOW_MS = 24 * 3600_000; // first run per station: last 24 h
const MAX_WINDOW_MS = 7 * 24 * 3600_000; // never query further back than 7 d
const MAX_CLIP_BYTES = 60 * 1024 * 1024; // skip clips larger than 60 MB
const MAX_SEEN_IDS = 500; // per station, most recent kept
const GLOBAL_STATION_BUDGET_MS = 20 * 60_000; // abort NEW station work after 20 min
const HARD_WATCHDOG_MS = 28 * 60_000;
const CONNECT_TIMEOUT_MS = 90_000;
const CONNECT_SETTLE_MS = 20_000;
const COUNT_TIMEOUT_MS = 35_000;
const QUERY_TIMEOUT_MS = 50_000;
const QUERY_SETTLE_MS = 4_000;
const WARMUP_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 30_000;
const CLIP_START_TIMEOUT_MS = 30_000;
const CLIP_TOTAL_TIMEOUT_MS = 150_000;
const STATION_GAP_MS = 5_000;

const TRIGGER_NAMES = { 0: "MOTION1", 1: "MOTION2", 2: "MOTION3", 4: "PERSON", 8: "RING", 16: "SENSOR", 32: "UNKNOWN", 64: "MISSED_RING", 128: "ANSWER_RING" };
const VIDEO_NAMES = { 1000: "RECEIVED_RING", 1001: "MISSED_RING", 1002: "MOTION", 1003: "PERSON", 1004: "PET", 1005: "CRYING", 1006: "SOUND", 65536: "PUTDOWN_PACKAGE", 131072: "TAKE_PACKAGE", 262144: "DETECT_PACKAGE", 524288: "RECEIVED_RING_ACK", 1048576: "RECEIVED_RING_MISS", 2097152: "RECEIVED_CAR_GUARD" };
const PERSON_VIDEO_TYPES = new Set([1003, 65536, 131072, 262144]);

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
const sanitizeId = (id) => String(id ?? "unknown").replace(/[^A-Za-z0-9_-]+/g, "_");

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
/** Parsed client Date -> true epoch ms, treating UTC components as device wall time. */
function deviceTimeMs(parsed) {
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return null;
    const guess = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds());
    let utc = guess - tzOffsetMs(DEVICE_TZ, guess);
    utc = guess - tzOffsetMs(DEVICE_TZ, utc); // refine once
    return utc;
}
/** Device-local calendar days (as UTC-midnight Dates) spanning [sinceMs, untilMs]. */
function deviceLocalDays(sinceMs, untilMs) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: DEVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayOf = (ms) => {
        const parts = {};
        for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
        return Date.UTC(+parts.year, +parts.month - 1, +parts.day);
    };
    const first = dayOf(sinceMs);
    const last = dayOf(untilMs);
    const days = [];
    for (let d = first; d <= last && days.length < 9; d += 24 * 3600_000) days.push(new Date(d));
    return days;
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
    state.stations[name] ??= { watermarkMs: null, seenRecordIds: [] };
    const st = state.stations[name];
    if (!Array.isArray(st.seenRecordIds)) st.seenRecordIds = [];
    if (st.watermarkMs !== null && typeof st.watermarkMs !== "number") st.watermarkMs = null;
    return st;
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
// per-station DB channel: pending-map correlation over client events,
// with warm-up + single retry on timeouts (probe hardening)
// ---------------------------------------------------------------------------
class StationChannel {
    constructor(client, station) {
        this.client = client;
        this.station = station;
        this.serial = station.getSerial();
        this.name = station.getName();
        this.pendingCollects = new Map(); // eventName -> {batches, returnCode, resolve, reject, timer, settleTimer, settleMs}
        this.pendingImages = new Map(); // filePath -> {resolve, reject, timer}
        this.pendingDownloads = new Map(); // deviceSerial -> {...}
        this.wire();
    }

    wire() {
        for (const eventName of ["station database count by date", "station database query by date"]) {
            this.client.on(eventName, (station, returnCode, data) => {
                if (station?.getSerial?.() !== this.serial) return;
                const pending = this.pendingCollects.get(eventName);
                if (!pending) return;
                if (returnCode !== 0 && pending.batches.length === 0) {
                    this.settleCollect(eventName, new Error(`database command returned code ${returnCode}`));
                    return;
                }
                pending.returnCode = returnCode;
                if (Array.isArray(data)) pending.batches.push(...data);
                if (pending.settleTimer) clearTimeout(pending.settleTimer);
                pending.settleTimer = setTimeout(() => this.settleCollect(eventName, null), pending.settleMs);
            });
        }
        this.client.on("station image download", (station, file, image) => {
            const pending = this.pendingImages.get(file);
            if (!pending) return;
            this.pendingImages.delete(file);
            clearTimeout(pending.timer);
            pending.resolve(image);
        });
        this.client.on("station download start", (station, device, metadata, videoStream, audioStream) => {
            const serial = device?.getSerial?.();
            const pending = serial ? this.pendingDownloads.get(serial) : undefined;
            if (audioStream) audioStream.pipe(new Writable({ write(_c, _e, cb) { cb(); } })); // always drain audio
            if (!pending) {
                videoStream?.resume();
                return;
            }
            pending.started = true;
            pending.videoStream = videoStream;
            videoStream.on("data", (chunk) => {
                pending.bytes += chunk.length;
                if (pending.bytes > MAX_CLIP_BYTES && !pending.oversize) {
                    pending.oversize = true;
                    void this.client.cancelStationDownload(serial).catch(() => {});
                    this.failDownload(serial, new Error(`clip exceeds ${MAX_CLIP_BYTES} bytes — download aborted (skip)`));
                }
            });
            videoStream.on("error", (err) => this.failDownload(serial, err));
            videoStream.pipe(pending.fileStream);
        });
        this.client.on("station download finish", (station, device) => {
            const serial = device?.getSerial?.();
            const pending = serial ? this.pendingDownloads.get(serial) : undefined;
            if (!pending) return;
            this.pendingDownloads.delete(serial);
            clearTimeout(pending.timer);
            pending.fileStream.end(() => {
                try {
                    fs.renameSync(pending.tmpPath, pending.finalPath);
                } catch {
                    pending.finalPath = pending.tmpPath;
                }
                pending.resolve({ file: path.basename(pending.finalPath), bytes: pending.bytes });
            });
        });
    }

    settleCollect(eventName, err) {
        const pending = this.pendingCollects.get(eventName);
        if (!pending) return;
        this.pendingCollects.delete(eventName);
        clearTimeout(pending.timer);
        if (pending.settleTimer) clearTimeout(pending.settleTimer);
        if (err) pending.reject(err);
        else pending.resolve({ returnCode: pending.returnCode, records: pending.batches });
    }

    /** Accumulating collect for one DB command; send() issues the command. */
    collect(eventName, send, timeoutMs, settleMs) {
        if (this.pendingCollects.has(eventName)) {
            return Promise.reject(new Error(`a "${eventName}" collect is already outstanding for ${this.name}`));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pendingCollects.get(eventName);
                if (pending && (pending.batches.length > 0 || pending.returnCode !== null)) {
                    this.settleCollect(eventName, null); // partial data beats a timeout
                } else {
                    this.settleCollect(eventName, new Error(`timeout after ${timeoutMs}ms waiting for "${eventName}"`));
                }
            }, timeoutMs);
            this.pendingCollects.set(eventName, { batches: [], returnCode: null, resolve, reject, timer, settleTimer: null, settleMs });
            try {
                send();
            } catch (e) {
                this.settleCollect(eventName, e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    /** Latest-info warm-up: re-proves the station's DB channel. Never throws. */
    async warmup() {
        try {
            const p = new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.client.off("station database query latest", handler);
                    resolve(false);
                }, WARMUP_TIMEOUT_MS);
                const handler = (station, _rc, _data) => {
                    if (station?.getSerial?.() !== this.serial) return;
                    clearTimeout(timer);
                    this.client.off("station database query latest", handler);
                    resolve(true);
                };
                this.client.on("station database query latest", handler);
            });
            this.station.databaseQueryLatestInfo();
            const ok = await p;
            log(`  ${this.name}: warm-up latest-info ${ok ? "answered" : "no answer"}`);
            return ok;
        } catch (e) {
            log(`  ${this.name}: warm-up failed (${shortErr(e)})`);
            return false;
        }
    }

    /** Run fn(); on timeout, warm up and retry exactly once. */
    async withRetry(label, fn) {
        try {
            return await fn();
        } catch (e) {
            if (!isTimeoutErr(e)) throw e;
            log(`  ${this.name}: ${label} timed out — warm-up + one retry`);
            await this.warmup();
            return await fn();
        }
    }

    async countByDate(firstDay, lastDay) {
        return this.withRetry("count", () =>
            this.collect(
                "station database count by date",
                () => this.station.databaseCountByDate(firstDay, lastDay),
                COUNT_TIMEOUT_MS,
                2_000,
            ),
        );
    }

    async queryByDate(serials, firstDay, lastDay) {
        const merged = [];
        const seen = new Set();
        for (let d = firstDay.getTime(); d <= lastDay.getTime(); d += 24 * 3600_000) {
            const day = new Date(d);
            const res = await this.withRetry(`query ${day.toISOString().slice(0, 10)}`, () =>
                this.collect(
                    "station database query by date",
                    () => this.station.databaseQueryByDate(serials, day, day, 0, 0, 0),
                    QUERY_TIMEOUT_MS,
                    QUERY_SETTLE_MS,
                ),
            );
            for (const r of res.records ?? []) {
                const key = `${r.record_id}|${r.device_sn}|${r.start_time?.getTime?.() ?? r.start_time}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    merged.push(r);
                }
            }
        }
        return merged;
    }

    async downloadThumbnail(record) {
        if (!record.thumbPath) throw new Error("record has no thumb_path");
        const attempt = async () => {
            if (this.pendingImages.has(record.thumbPath)) throw new Error("thumbnail download already outstanding");
            const p = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingImages.delete(record.thumbPath);
                    reject(new Error(`timeout after ${IMAGE_TIMEOUT_MS}ms waiting for thumbnail`));
                }, IMAGE_TIMEOUT_MS);
                this.pendingImages.set(record.thumbPath, { resolve, reject, timer });
            });
            try {
                this.station.downloadImage(record.thumbPath);
            } catch (e) {
                const pending = this.pendingImages.get(record.thumbPath);
                if (pending) {
                    this.pendingImages.delete(record.thumbPath);
                    clearTimeout(pending.timer);
                }
                throw e;
            }
            const image = await p;
            const buf = Buffer.isBuffer(image) ? image : image?.data ? Buffer.from(image.data) : null;
            if (!buf || buf.length === 0) throw new Error("thumbnail download returned no image data");
            return buf;
        };
        try {
            return await attempt();
        } catch (e) {
            if (!isTimeoutErr(e)) throw e;
            log(`  ${this.name}: thumbnail timed out — warm-up + one retry`);
            await this.warmup();
            return await attempt();
        }
    }

    failDownload(serial, err) {
        const pending = this.pendingDownloads.get(serial);
        if (!pending) return;
        this.pendingDownloads.delete(serial);
        clearTimeout(pending.timer);
        try {
            pending.fileStream.destroy();
        } catch {
            /* ignore */
        }
        try {
            fs.unlinkSync(pending.tmpPath);
        } catch {
            /* ignore */
        }
        pending.reject(err instanceof Error ? err : new Error(String(err)));
    }

    async downloadClip(record, bundleDir) {
        if (!record.storagePath) throw new Error("record has no storage_path");
        if (!record.deviceSn) throw new Error("record has no device serial");
        const serial = record.deviceSn;
        const attempt = async () => {
            if (this.pendingDownloads.has(serial)) throw new Error("a clip download is already outstanding for this device");
            const finalPath = path.join(bundleDir, "clip.mp4");
            const tmpPath = `${finalPath}.part`;
            const fileStream = fs.createWriteStream(tmpPath);
            const done = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    void this.client.cancelStationDownload(serial).catch(() => {});
                    this.failDownload(serial, new Error(`timeout after ${CLIP_TOTAL_TIMEOUT_MS}ms downloading clip`));
                }, CLIP_TOTAL_TIMEOUT_MS);
                this.pendingDownloads.set(serial, {
                    resolve,
                    reject,
                    timer,
                    fileStream,
                    tmpPath,
                    finalPath,
                    bytes: 0,
                    started: false,
                    oversize: false,
                });
            });
            // start-timeout guard: if no "download start" arrives, fail fast
            const startDeadline = setTimeout(() => {
                const pending = this.pendingDownloads.get(serial);
                if (pending && !pending.started) {
                    void this.client.cancelStationDownload(serial).catch(() => {});
                    this.failDownload(serial, new Error(`timeout after ${CLIP_START_TIMEOUT_MS}ms waiting for clip download to start`));
                }
            }, CLIP_START_TIMEOUT_MS);
            startDeadline.unref?.();
            try {
                await this.client.startStationDownload(serial, record.storagePath, record.cipherId ?? 0);
            } catch (e) {
                clearTimeout(startDeadline);
                this.failDownload(serial, e instanceof Error ? e : new Error(String(e)));
            }
            try {
                return await done;
            } finally {
                clearTimeout(startDeadline);
            }
        };
        try {
            return await attempt();
        } catch (e) {
            // Retry once only when nothing was transferred (a stalled start is
            // the battery-sleep failure mode); a mid-transfer failure or an
            // oversize skip is final.
            const pendingGone = !this.pendingDownloads.has(serial);
            if (!pendingGone || /exceeds/.test(e.message)) throw e;
            log(`  ${this.name}: clip download failed before transfer (${shortErr(e)}) — warm-up + one retry`);
            await this.warmup();
            return await attempt();
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

    // station processing order: STATION_ORDER first, extras appended
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
        const result = await sweepStation({ station, devices, deviceBySerial, state }).catch((e) => ({
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

async function sweepStation({ station, devices, deviceBySerial, state }) {
    const name = station.getName();
    const serial = station.getSerial();
    const stState = stationState(state, name);
    const nowMs = Date.now();
    let sinceMs = stState.watermarkMs ?? nowMs - FIRST_WINDOW_MS;
    if (nowMs - sinceMs > MAX_WINDOW_MS) {
        log(`${name}: watermark is older than 7 d — clamping window start`);
        sinceMs = nowMs - MAX_WINDOW_MS;
    }
    const untilMs = nowMs;
    log(`${name}: window ${new Date(sinceMs).toISOString()} -> ${new Date(untilMs).toISOString()} (watermark ${stState.watermarkMs === null ? "none (first run)" : new Date(stState.watermarkMs).toISOString()}, seen=${stState.seenRecordIds.length})`);

    const stDevices = devices.filter((d) => d.getStationSerial() === serial);
    const serials = stDevices.map((d) => d.getSerial());
    if (serials.length === 0) return { ok: false, reason: "no devices known for this station" };

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

    const channel = new StationChannel(client, station);
    const days = deviceLocalDays(sinceMs, untilMs);
    const firstDay = days[0];
    const lastDay = days[days.length - 1];

    // ---- count (informational cross-check; hardened with warm-up+retry) ---
    try {
        const c = await channel.countByDate(firstDay, lastDay);
        const total = (c.records ?? []).reduce((acc, r) => acc + (typeof r.count === "number" ? r.count : 0), 0);
        log(`${name}: db count for window days = ${total}`);
    } catch (e) {
        log(`${name}: count failed after retry (${shortErr(e)}) — proceeding to query`);
    }

    // ---- query --------------------------------------------------------------
    let rawRecords;
    try {
        rawRecords = await channel.queryByDate(serials, firstDay, lastDay);
    } catch (e) {
        return { ok: false, reason: `database query failed: ${shortErr(e)}` };
    }
    log(`${name}: query returned ${rawRecords.length} records`);

    // normalize + window filter
    const records = [];
    for (const r of rawRecords) {
        const startMs = deviceTimeMs(r.start_time);
        const endMs = deviceTimeMs(r.end_time) ?? startMs;
        if (startMs === null || endMs === null) continue;
        const deviceObj = r.device_sn ? deviceBySerial.get(r.device_sn) : undefined;
        const deviceName = deviceObj?.getName() ?? (serials.length === 1 ? stDevices[0].getName() : null);
        const personFlagged = r.trigger_type === 4 || PERSON_VIDEO_TYPES.has(r.video_type);
        records.push({
            recordId: r.record_id ?? `t${startMs}-${deviceName ?? "unknown"}`,
            deviceSn: r.device_sn ?? null,
            deviceName,
            deviceModel: deviceObj?.getModel() ?? null,
            startMs,
            endMs,
            storagePath: r.storage_path || null,
            thumbPath: r.thumb_path || null,
            cipherId: r.cipher_id ?? null,
            folderSize: typeof r.folder_size === "number" ? r.folder_size : null,
            frameNum: r.frame_num ?? null,
            triggerType: r.trigger_type ?? null,
            videoType: r.video_type ?? null,
            storageCloud: r.storage_cloud ?? null,
            personFlagged,
        });
    }
    records.sort((a, b) => a.startMs - b.startMs);
    const candidates = records.filter((r) => r.endMs > sinceMs && r.startMs <= untilMs + 60_000);
    const seenSet = new Set(stState.seenRecordIds.map(String));
    const newRecords = candidates.filter((r) => !seenSet.has(String(r.recordId)));
    log(`${name}: ${candidates.length} in window, ${newRecords.length} new`);

    // ---- bundles ------------------------------------------------------------
    let thumbs = 0;
    let clips = 0;
    for (const rec of newRecords) {
        const bundleDir = path.join(INBOX_DIR, `${slugify(name)}-${sanitizeId(rec.recordId)}`);
        fs.mkdirSync(bundleDir, { recursive: true });
        const bundle = {
            recordId: rec.recordId,
            station: name,
            device: rec.deviceName,
            model: rec.deviceModel,
            startUtc: new Date(rec.startMs).toISOString(),
            endUtc: new Date(rec.endMs).toISOString(),
            startMs: rec.startMs,
            endMs: rec.endMs,
            startLocal: fmtLocal(rec.startMs),
            endLocal: fmtLocal(rec.endMs),
            durationSec: Math.max(0, Math.round((rec.endMs - rec.startMs) / 1000)),
            triggerType: rec.triggerType,
            triggerName: TRIGGER_NAMES[rec.triggerType] ?? null,
            videoType: rec.videoType,
            videoName: VIDEO_NAMES[rec.videoType] ?? null,
            personFlagged: rec.personFlagged,
            folderSize: rec.folderSize,
            frameNum: rec.frameNum,
            storageCloud: rec.storageCloud,
            thumbFile: null,
            thumbBytes: null,
            thumbError: null,
            clipFile: null,
            clipBytes: null,
            clipError: null,
            clipSkipped: null,
            sweptAt: new Date().toISOString(),
        };

        // thumbnail — always attempted
        if (rec.thumbPath) {
            try {
                const buf = await channel.downloadThumbnail(rec);
                const file = `thumb${sniffImage(buf)}`;
                fs.writeFileSync(path.join(bundleDir, file), buf);
                bundle.thumbFile = file;
                bundle.thumbBytes = buf.length;
                thumbs++;
            } catch (e) {
                bundle.thumbError = shortErr(e);
                log(`${name}: thumbnail failed for record ${rec.recordId}: ${shortErr(e)}`);
            }
        } else {
            bundle.thumbError = "record carries no thumb_path";
        }

        // clip — person-flagged, or an always-clip device
        const wantClip = rec.personFlagged || (rec.deviceName !== null && CLIP_DEVICE_NAMES.has(rec.deviceName));
        if (!wantClip) {
            bundle.clipSkipped = "not person-flagged and device not in always-clip set";
        } else if (!rec.storagePath) {
            bundle.clipError = "record carries no storage_path";
        } else if (rec.folderSize !== null && rec.folderSize > MAX_CLIP_BYTES) {
            bundle.clipSkipped = `folder_size ${rec.folderSize} exceeds ${MAX_CLIP_BYTES} bytes`;
        } else {
            try {
                const got = await channel.downloadClip(rec, bundleDir);
                bundle.clipFile = got.file;
                bundle.clipBytes = got.bytes;
                clips++;
            } catch (e) {
                bundle.clipError = shortErr(e);
                log(`${name}: clip failed for record ${rec.recordId}: ${shortErr(e)}`);
            }
        }

        // record.json last: a bundle dir containing record.json is complete
        fs.writeFileSync(path.join(bundleDir, "record.json"), JSON.stringify(bundle, null, 2));
    }

    // ---- state advance (only now: every bundle for this station is written)
    let maxEnd = stState.watermarkMs ?? 0;
    for (const r of candidates) if (r.endMs > maxEnd) maxEnd = r.endMs;
    if (maxEnd > untilMs + 5 * 60_000) maxEnd = untilMs + 5 * 60_000; // clock-skew clamp
    if (stState.watermarkMs === null || maxEnd > stState.watermarkMs) stState.watermarkMs = maxEnd;
    for (const r of newRecords) {
        const id = String(r.recordId);
        if (!stState.seenRecordIds.map(String).includes(id)) stState.seenRecordIds.push(r.recordId);
    }
    if (stState.seenRecordIds.length > MAX_SEEN_IDS) {
        stState.seenRecordIds = stState.seenRecordIds.slice(-MAX_SEEN_IDS);
    }
    saveState(state);
    log(`${name}: state advanced (watermark=${new Date(stState.watermarkMs).toISOString()}, seen=${stState.seenRecordIds.length})`);

    return { ok: true, newCount: newRecords.length, thumbs, clips };
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
