#!/usr/bin/env node
/**
 * liveness.mjs — livestream liveness probes (Stage 2, Oct 13, 2026).
 *
 * WHY: a camera that records no events is ambiguous — it may be
 * LIVE-QUIET (healthy, watching an empty scene), UNREACHABLE (dead /
 * out of range / wedged), or DISABLED (switched off at the account
 * level, like the Living Room by design). Event counts cannot separate
 * these. Suvamsh's directive: settle it by opening the live feed.
 *
 * WHAT: for each target camera, restore the stored guest session
 * (passwordless, same gate as the sweep), read the device's enabled
 * state, connect over P2P, start a livestream via the vendored client,
 * capture ~5 s, and decode one frame with ffmpeg:
 *   - isEnabled() === false          → DISABLED (no stream attempted;
 *                                      a disabled camera returns 0 bytes
 *                                      anyway — proven on Living Room)
 *   - P2P connect fails              → UNREACHABLE / "p2p-connect"
 *   - stream never starts            → UNREACHABLE / "stream-no-start"
 *   - stream starts but sends 0 B    → UNREACHABLE / "stream-no-data"
 *   - bytes flow but won't decode    → UNREACHABLE / "stream-undecodable"
 *   - a frame decodes                → LIVE-QUIET
 * The classification is recorded in state.json health[device]
 * (lastLiveness + lastProbeAt, via health.mjs) — metadata only in the
 * data repo. Frames are written to a scratch dir (workflow artifacts);
 * the ONLY frame retained in the data repo is a camera's first-ever
 * LIVE-QUIET frame under health-frames/, as first-look evidence.
 *
 * TARGETING / BATTERY DISCIPLINE: in auto mode a camera is probed only
 * when it has had no event for >24h (or none ever recorded) AND its
 * last probe is >11h old (≤ ~2 probes/camera/day while healthy); a
 * camera classified DISABLED is re-checked at most weekly. At most 3
 * cameras are probed per auto run. LIVENESS_TARGETS (comma-separated
 * device names) forces specific cameras (manual dispatch / first run);
 * forced probes ignore the due checks but never the classification.
 *
 * Runs in GitHub Actions (P2P cannot leave GG's VM). Logs never contain
 * serials or session material: cameras are referred to by name only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deviceHealth, recordLiveness } from "./health.mjs";

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR ? path.resolve(process.env.RELAY_DATA_DIR) : path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const FRAMES_DIR = path.join(DATA_DIR, "health-frames");
const SCRATCH_DIR = process.env.LIVENESS_SCRATCH_DIR
    ? path.resolve(process.env.LIVENESS_SCRATCH_DIR)
    : path.join(os.tmpdir(), "liveness-frames");
const DEVICE_TZ = "America/Los_Angeles";

const QUIET_MS = 24 * 60 * 60 * 1000; // no event for >24h → probe candidate
const PROBE_INTERVAL_MS = 11 * 60 * 60 * 1000; // ≤ ~2 probes/camera/day while healthy
const DISABLED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000; // disabled state re-check at most weekly
const MAX_AUTO_PROBES = 3;
const CONNECT_TIMEOUT_MS = 90_000;
const CONNECT_SETTLE_MS = 20_000;
const STREAM_WINDOW_MS = 60_000; // per attempt; two attempts (battery wake on second ask)
const STREAM_CAPTURE_MS = 5_000; // capture this long after the start event
const STREAM_MAX_BYTES = 6 * 1024 * 1024;
const JOB_WATCHDOG_MS = 25 * 60_000;

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);
const slugify = (name) =>
    String(name ?? "device")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "device";

// device-local wall stamp -> epoch ms (mirrors sweep.mjs)
function tzOffsetMs(timeZone, utcMs) {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}
function wallStampToMs(digits) {
    const guess = Date.UTC(+digits.slice(0, 4), +digits.slice(4, 6) - 1, +digits.slice(6, 8), +digits.slice(8, 10), +digits.slice(10, 12), +digits.slice(12, 14));
    let utc = guess - tzOffsetMs(DEVICE_TZ, guess);
    utc = guess - tzOffsetMs(DEVICE_TZ, utc);
    return utc;
}
function parsePathStamp(p) {
    const m = String(p ?? "").match(/(\d{14})/);
    return m ? m[1] : null;
}
function expiryToMs(value) {
    if (value === undefined || value === null || value === 0 || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : null;
    if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return expiryToMs(n);
        const p = Date.parse(value);
        return Number.isNaN(p) ? null : p;
    }
    return null;
}

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
        const onError = (_st, err) => { lastError = err instanceof Error ? err.message : String(err); };
        const deadline = setTimeout(() => finish(station.isConnected(), lastError ?? `no P2P connection within ${timeoutMs}ms`), timeoutMs);
        const poller = setInterval(() => { if (station.isConnected()) finish(true, null); }, 1_000);
        station.on("connect", onConnect);
        station.on("connection error", onError);
        if (station.isConnected()) { finish(true, null); return; }
        Promise.resolve().then(() => station.connect()).catch((e) => { lastError = e instanceof Error ? e.message : String(e); });
    });
}

let client = null;
/** One livestream attempt: resolves { started, video: Buffer, metadata }. */
function harvestLivestream(deviceSN, windowMs) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let meta = null;
        let started = false;
        let done = false;
        const finish = (extra = {}) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(captureTimer);
            client.off("station livestream start", onStart);
            client.stopStationLivestream(deviceSN).catch(() => {});
            resolve({ started, video: Buffer.concat(chunks), metadata: meta, ...extra });
        };
        let captureTimer = null;
        const onStart = (_station, device, metadata, videoStream, audioStream) => {
            if (device?.getSerial?.() !== deviceSN || started) return;
            started = true;
            meta = metadata ?? null;
            videoStream?.on("data", (c) => {
                chunks.push(c);
                total += c.length;
                if (total >= STREAM_MAX_BYTES) finish({ cappedBytes: true });
            });
            videoStream?.on("error", (e) => finish({ streamErr: shortErr(e) }));
            audioStream?.resume?.();
            captureTimer = setTimeout(() => finish({}), STREAM_CAPTURE_MS);
        };
        const timer = setTimeout(() => finish({ timedOut: true }), windowMs);
        client.on("station livestream start", onStart);
        client.startStationLivestream(deviceSN).catch((e) => finish({ err: shortErr(e) }));
    });
}

/** Decode one frame from the captured stream head. Returns {ok, framePath, codec, width, height} */
function extractFrame(videoBuf, codecHint, outBase) {
    const binPath = `${outBase}.bin`;
    fs.writeFileSync(binPath, videoBuf);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", binPath], { encoding: "utf8" });
    let info = null;
    try {
        const streams = JSON.parse(probe.stdout || "{}").streams;
        if (Array.isArray(streams) && streams[0]) info = streams[0];
    } catch { /* fall through */ }
    const formats = [];
    const hinted = /265|hevc/i.test(codecHint ?? "") ? "hevc" : /264|h264/i.test(codecHint ?? "") ? "h264" : null;
    if (hinted) formats.push(hinted);
    formats.push(null, "hevc", "h264"); // null = let ffmpeg probe the Annex-B stream itself
    const seen = new Set();
    for (const fmt of formats) {
        if (seen.has(fmt)) continue;
        seen.add(fmt);
        for (const frameSel of ["30", "0"]) {
            const outPath = `${outBase}.jpg`;
            const args = ["-v", "error"];
            if (fmt) args.push("-f", fmt);
            args.push("-i", binPath, "-vf", `select='eq(n\\,${frameSel})'`, "-frames:v", "1", "-q:v", "3", "-y", outPath);
            const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
            if (r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 3_000) {
                return { ok: true, framePath: outPath, codec: info?.codec_name ?? fmt ?? "unknown", width: info?.width ?? null, height: info?.height ?? null };
            }
        }
    }
    return { ok: false, codec: info?.codec_name ?? null, width: info?.width ?? null, height: info?.height ?? null };
}

function loadState() {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); // throws → caller aborts (never clobber)
    if (!parsed || typeof parsed !== "object") throw new Error("state.json has unexpected shape");
    return parsed;
}
function saveState(state) {
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

/** Newest known event stamp for a device: health record wins, else station state. */
function lastEventStampFor(state, deviceName) {
    const h = state.health?.[deviceName];
    if (h?.lastEventStamp) return h.lastEventStamp;
    for (const st of Object.values(state.stations ?? {})) {
        const dev = st?.devices?.[deviceName];
        const s = parsePathStamp(dev?.cropPath ?? null);
        if (s) return s;
    }
    return null;
}

async function probeDevice({ state, device, stationsBySerial }) {
    const name = device.getName();
    const stationForHealth = stationsBySerial.get(device.getStationSerial());
    const h = deviceHealth(state, name, stationForHealth?.getName() ?? null);
    const finish = (classification, failurePattern, bytes = 0) => {
        recordLiveness(h, new Date().toISOString(), { classification, failurePattern, bytes });
        log(`LIVENESS device=${name} classification=${classification}${failurePattern ? ` pattern=${failurePattern}` : ""} bytes=${bytes}`);
        return classification;
    };

    // 1) enabled state (cloud-side property; no camera wake-up)
    let enabled = null;
    try {
        const v = device.isEnabled();
        enabled = v === true || v === 1 ? true : v === false || v === 0 ? false : null;
    } catch (e) {
        log(`LIVENESS device=${name}: isEnabled() threw (${shortErr(e)}) — proceeding to stream test`);
    }
    if (enabled === false) return finish("DISABLED", "isEnabled=false");

    // 2) P2P connect (one retry after a settle — battery wake pattern)
    const station = stationsBySerial.get(device.getStationSerial());
    if (!station) return finish("UNREACHABLE", "station-not-listed");
    let conn = await ensureP2PConnected(station);
    if (!conn.connected) {
        log(`LIVENESS device=${name}: P2P connect failed (${conn.error ?? "unknown"}) — settle, one retry`);
        try { station.close?.(); } catch { /* ignore */ }
        await sleep(CONNECT_SETTLE_MS);
        conn = await ensureP2PConnected(station);
    }
    if (!conn.connected) return finish("UNREACHABLE", "p2p-connect");

    // 3) livestream: up to two attempts (battery cameras often answer only the second ask)
    const deviceSN = device.getSerial();
    let res = await harvestLivestream(deviceSN, STREAM_WINDOW_MS);
    if (!res.started || res.video.length === 0) {
        log(`LIVENESS device=${name}: attempt 1 ${res.started ? "started but 0 bytes" : "never started"} — settle, one retry`);
        await sleep(10_000);
        res = await harvestLivestream(deviceSN, STREAM_WINDOW_MS);
    }
    if (!res.started) return finish("UNREACHABLE", "stream-no-start", 0);
    if (res.video.length === 0) return finish("UNREACHABLE", "stream-no-data", 0);
    log(`LIVENESS device=${name}: stream flowed (${res.video.length} bytes, metadata=${JSON.stringify(res.metadata ?? null)})`);

    // 4) decode one frame
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    const outBase = path.join(SCRATCH_DIR, `live-${slugify(name)}`);
    const dec = extractFrame(res.video, res.metadata?.videoCodec ?? res.metadata?.codec ?? "", outBase);
    if (!dec.ok) return finish("UNREACHABLE", "stream-undecodable", res.video.length);
    log(`LIVENESS device=${name}: frame decoded (${dec.codec} ${dec.width ?? "?"}x${dec.height ?? "?"}) → ${path.basename(dec.framePath)}`);

    // Retain the frame in the data repo ONLY as first-look evidence for a
    // camera that has never recorded an event (Backyard/Sideyard today) —
    // cameras with event history already leave snapshots in the bundle
    // flow, and their probe frames stay scratch/artifact-only.
    const retained = path.join(FRAMES_DIR, `${slugify(name)}.jpg`);
    if (!lastEventStampFor(state, name) && !fs.existsSync(retained)) {
        fs.mkdirSync(FRAMES_DIR, { recursive: true });
        fs.copyFileSync(dec.framePath, retained);
        log(`LIVENESS device=${name}: first-look frame retained at health-frames/${slugify(name)}.jpg`);
    }
    return finish("LIVE-QUIET", null, res.video.length);
}

const watchdog = setTimeout(() => {
    console.error(`${stamp()} WATCHDOG: job budget exceeded — exiting`);
    try { client?.close(); } catch { /* ignore */ }
    console.log("LIVENESS DONE");
    process.exit(0);
}, JOB_WATCHDOG_MS);
watchdog.unref?.();

async function main() {
    if (!USERNAME) {
        console.error("FATAL: EUFY_USERNAME is not set (Actions secret missing) — refusing to start");
        process.exit(1);
    }
    const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ff.error || ff.status !== 0) {
        console.error("FATAL: ffmpeg not available on this runner — cannot decode probe frames");
        process.exit(1);
    }
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    } catch {
        console.error("FATAL: no stored session file — cannot run session-only probe");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("FATAL: stored legacy token missing/expired — session-only probe refused");
        process.exit(1);
    }
    log(`session gate ok: legacy token expires ${new Date(legacyExpiryMs).toISOString()}`);

    let state;
    try {
        state = loadState();
    } catch (e) {
        console.error(`FATAL: cannot read data state.json (${shortErr(e)}) — refusing to probe without health state`);
        process.exit(1);
    }

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
        logging: { level: 4 },
    });
    try { client.setLoggingLevel?.("all", 4); } catch { /* best-effort */ }
    client.on("tfa request", () => { challengeSeen ??= "verify_code"; });
    client.on("captcha request", () => { challengeSeen ??= "captcha"; });
    await client.connect();
    if (challengeSeen) {
        console.error(`FATAL: server requested re-authentication (${challengeSeen}) — session-only probe aborted`);
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
    if (devices.length === 0) {
        console.error("FATAL: session restored but zero devices returned");
        process.exit(1);
    }
    const stationsBySerial = new Map(stations.map((s) => [s.getSerial(), s]));
    const deviceByName = new Map(devices.map((d) => [d.getName(), d]));
    log(`devices: ${devices.map((d) => d.getName()).join(", ")}`);

    // ---- target selection ---------------------------------------------------
    const forced = (process.env.LIVENESS_TARGETS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const nowMs = Date.now();
    let targets = [];
    if (forced.length > 0) {
        for (const name of forced) {
            const d = deviceByName.get(name);
            if (!d) log(`LIVENESS target=${name}: not in device list — skipped`);
            else targets.push(d);
        }
        log(`LIVENESS forced targets: ${targets.map((d) => d.getName()).join(", ") || "(none)"}`);
    } else {
        for (const d of devices) {
            const name = d.getName();
            const h = state.health?.[name];
            const lastProbeMs = h?.lastProbeAt ? Date.parse(h.lastProbeAt) : null;
            if (h?.lastLiveness?.classification === "DISABLED" && lastProbeMs && nowMs - lastProbeMs < DISABLED_RECHECK_MS) {
                log(`LIVENESS device=${name}: DISABLED, re-check not due — skipped`);
                continue;
            }
            if (lastProbeMs && nowMs - lastProbeMs < PROBE_INTERVAL_MS) continue; // battery discipline
            const evStamp = lastEventStampFor(state, name);
            const evMs = evStamp ? wallStampToMs(evStamp) : null;
            if (evMs !== null && nowMs - evMs <= QUIET_MS) continue; // events flowing — no probe needed
            targets.push(d);
        }
        targets = targets.slice(0, MAX_AUTO_PROBES);
        log(`LIVENESS auto targets (event-quiet >24h, probe due): ${targets.map((d) => d.getName()).join(", ") || "(none)"}`);
    }

    for (const d of targets) {
        await probeDevice({ state, device: d, stationsBySerial }).catch((e) =>
            log(`LIVENESS device=${d.getName()} classification=UNREACHABLE pattern=probe-error (${shortErr(e)})`),
        );
        saveState(state); // persist each classification immediately
        const station = stationsBySerial.get(d.getStationSerial());
        try { station?.close?.(); } catch { /* ignore */ }
        await sleep(3_000);
    }

    console.log("LIVENESS DONE");
    try { client.close(); } catch { /* ignore */ }
    process.exit(0);
}

main().catch((e) => {
    console.error(`FATAL: ${shortErr(e)}`);
    try { client?.close(); } catch { /* ignore */ }
    process.exit(1);
});
