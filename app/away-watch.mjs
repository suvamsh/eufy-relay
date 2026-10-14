#!/usr/bin/env node
/**
 * away-watch.mjs — Stage 5: the v2 away-mode indoor watch chain link
 * (design: files/Away-mode-indoor-watch-v2-design.md §3.1-3.2, REVISED —
 * continuous stream analysis, NOT sampling).
 *
 * One link:
 *   1. Restores the stored GUEST session (same offline gate as the
 *      sweep/listener; a re-auth challenge prints AWAY-WATCH SESSION:
 *      FAIL, marks the heartbeat sessionOk=false, exits 3, never
 *      chains — the blocker ping owns re-auth).
 *   2. Reads the Living Room camera's account-level enabled state —
 *      the away signal (design §2). DISARMED: refresh away-state.json,
 *      write a disarmed-standby heartbeat, exit 0 WITHOUT opening a
 *      stream and WITHOUT chaining. The chain exists only while armed.
 *   3. ARMED: refresh away-state.json (armed, this link as source),
 *      load the person detector (SSD-MobileNet v1 via
 *      person-detect.mjs; a detector self-check runs one inference on a
 *      black frame — a link that cannot detect says so in its heartbeat
 *      and keeps the stream up for the camera-native backstop, it does
 *      NOT pretend to watch), P2P-connect to the camera's station, and
 *      hold the LIVESTREAM: ffmpeg writes rolling ~30 s full-res TS
 *      ring segments (~12 min retained) while a downscaled 300x300 @
 *      6 fps analysis feed runs the motion gate + person classifier.
 *   4. On a person-class trigger, the -30 s / +30 s ring window is cut
 *      to incident.mp4 and pushed as a CRITICAL priority bundle
 *      (source "away-watch", clipFile null — clip-intake leaves it in
 *      the bundle; the judging loops view incident.mp4 directly) for
 *      the fast-lane judge. The detector is a hint generator; GG judges
 *      every segment (design §3.2).
 *   5. Heartbeat away-watch-state.json in the data repo (5-min sync).
 *      The fast-lane judge is the dead-man's switch: heartbeat stale
 *      >10 min while armed + no active run -> relaunch + report the
 *      gap (design §3.1). Stream supervision mirrors the listener's
 *      push-down rule: a stream that stays down >15 min ends the link
 *      early and chains a fresh one.
 *   6. Armed state is re-read every ~5 min (fresh cloud device list).
 *      DISARM mid-link: stop the stream, refresh away-state.json
 *      (disarmed, this link as source), heartbeat disarmed-standdown,
 *      exit 0 WITHOUT chaining.
 *   7. Self-chaining while armed: ~15 min before the window ends the
 *      link dispatches its successor (workflow_dispatch; the
 *      eufy-away-watch concurrency group holds it pending until this
 *      link exits; ~2 min link overlap by design §3.1).
 *
 * Video only: the ring carries no audio in this build (the livestream's
 * audio is a separate elementary stream with its own timing; A/V sync
 * in evidence segments is not worth the skew risk — the camera-native
 * event clips pulled by the listener/sweep pipeline are unaffected).
 *
 * Logs never contain serials or session material; the camera is
 * referred to by name.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPersonDetector, FrameAnalyzer, spawnLivePipeline, ANALYSIS_FPS } from "./person-detect.mjs";

const execFileP = promisify(execFile);

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR ? path.resolve(process.env.RELAY_DATA_DIR) : path.join(ROOT, "data");
const INBOX_DIR = path.join(DATA_DIR, "inbox");
const HEARTBEAT_FILE = path.join(DATA_DIR, "away-watch-state.json");
const AWAY_FILE = path.join(DATA_DIR, "away-state.json");
const CAMERA_NAME = "Living Room";
const DEVICE_TZ = "America/Los_Angeles";
const REPO = process.env.GH_REPO || "suvamsh/muse-security-guard";
const MODEL_PATH = process.env.AWAY_WATCH_MODEL || path.join(HERE, "models", "ssd_mobilenet_v1_12.onnx");
const RING_DIR = process.env.AWAY_WATCH_RING_DIR || path.join(os.tmpdir(), "away-watch-ring");

const WATCH_MINUTES = Math.max(5, Number(process.env.WATCH_MINUTES || 320) || 320);
const CHAIN_ENABLED = process.env.AWAY_WATCH_CHAIN !== "false";
const CHAIN_LEAD_MS = 15 * 60_000;
const HEARTBEAT_SYNC_MS = 5 * 60_000;
const ARMED_RECHECK_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 90_000;
const CONNECT_SETTLE_MS = 20_000;
const STREAM_START_TIMEOUT_MS = 90_000;
const STREAM_RESTART_SETTLE_MS = 10_000;
const STREAM_DOWN_LIMIT_MS = 15 * 60_000;
const STREAM_STALL_MS = 90_000; // pipeline alive but no bytes for this long = stalled
const POST_ROLL_TIMEOUT_MS = 100_000;

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

// --- timezone helpers (mirror listener.mjs) --------------------------------
function tzOffsetMs(timeZone, utcMs) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}
function msToWallDigits(ms) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: DEVICE_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return `${parts.year}${parts.month}${parts.day}${parts.hour === "24" ? "00" : parts.hour}${parts.minute}${parts.second}`;
}
const fmtLocal = (ms) => {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: DEVICE_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second} PT`;
};
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

// --- data-repo sync (mirror listener.mjs) -----------------------------------
function gitEnv() {
    const env = { ...process.env };
    const keyFile = process.env.DATA_SSH_KEY_FILE;
    if (keyFile && fs.existsSync(keyFile)) env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    return env;
}
async function git(args, { quiet = false } = {}) {
    try {
        const { stdout } = await execFileP("git", ["-C", DATA_DIR, ...args], { env: gitEnv(), maxBuffer: 32 * 1024 * 1024 });
        return stdout.trim();
    } catch (e) {
        if (!quiet) log(`git ${args[0]} failed: ${shortErr(e.stderr?.toString?.() ?? e)}`);
        throw e;
    }
}
let gitChain = Promise.resolve();
function syncData(message) {
    const run = async () => {
        const status = await git(["status", "--porcelain"], { quiet: true }).catch(() => "");
        if (status) {
            await git(["add", "-A"]);
            await git(["commit", "-m", message]);
        }
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                await git(["fetch", "origin", "main"], { quiet: true });
                await git(["merge", "origin/main", "-X", "theirs", "--no-edit"], { quiet: true }).catch(async (e) => {
                    await git(["merge", "--abort"], { quiet: true }).catch(() => {});
                    throw e;
                });
                await git(["push", "origin", "HEAD:main"]);
                return true;
            } catch (e) {
                log(`data sync attempt ${attempt} failed (${shortErr(e)}) — retrying`);
                await sleep(3_000 * attempt);
            }
        }
        log(`data sync FAILED after retries: ${message} (files remain in the runner checkout)`);
        return false;
    };
    gitChain = gitChain.then(run, run);
    return gitChain;
}

// --- heartbeat ---------------------------------------------------------------
const heartbeat = {
    kind: "eufy-away-watch-heartbeat",
    version: 1,
    linkId: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "starting", // starting | armed-watching | armed-stream-down | armed-detector-down | disarmed-standby | disarmed-standdown | ending | failed
    armed: null,
    streamActive: false,
    detectorOk: null,
    framesAnalyzed: 0,
    motionFrames: 0,
    personTriggers: 0,
    incidentsWritten: 0,
    lastTriggerAt: null,
    lastPersonConfidence: null,
    sessionExpiresAt: null,
    sessionOk: true,
    note: null,
};
function writeHeartbeatFile() {
    heartbeat.updatedAt = new Date().toISOString();
    const tmp = `${HEARTBEAT_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(heartbeat, null, 2));
    fs.renameSync(tmp, HEARTBEAT_FILE);
}
async function syncHeartbeat(message) {
    writeHeartbeatFile();
    return syncData(message);
}

// --- away-state.json (same contract as away-state.mjs) -----------------------
function readAwayState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(AWAY_FILE, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}
async function refreshAwayState(armed, source, note = null) {
    const prev = readAwayState();
    const nowIso = new Date().toISOString();
    const flipped = !prev || prev.armed !== armed;
    const state = {
        kind: "eufy-away-state",
        version: 1,
        armed,
        cameraEnabled: armed,
        sinceUtc: flipped ? nowIso : prev.sinceUtc ?? nowIso,
        updatedAt: nowIso,
        source,
        sessionOk: heartbeat.sessionOk,
        sessionExpiresAt: heartbeat.sessionExpiresAt,
        note,
    };
    const tmp = `${AWAY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, AWAY_FILE);
    await syncData(`away-state ${armed ? "ARMED" : "disarmed"} (${source})`);
    return state;
}

// --- P2P connect (mirror listener.mjs) ---------------------------------------
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

// --- chaining ------------------------------------------------------------------
let chainDispatched = false;
async function dispatchSuccessor(reason) {
    if (!CHAIN_ENABLED) {
        log(`chain: disabled (AWAY_WATCH_CHAIN=false) — not dispatching a successor (${reason})`);
        return;
    }
    if (chainDispatched) return;
    chainDispatched = true;
    try {
        await execFileP("gh", ["workflow", "run", "away-watch.yml", "--repo", REPO], { env: { ...process.env }, maxBuffer: 1024 * 1024 });
        log(`chain: successor link dispatched (${reason}) — it stays PENDING in the eufy-away-watch concurrency group until this link exits`);
    } catch (e) {
        chainDispatched = false;
        log(`chain: successor dispatch FAILED (${reason}): ${shortErr(e)} — the fast-lane dead-man's switch is the backstop`);
    }
}

// --- main ----------------------------------------------------------------------
let client = null;
let sessionFailed = false;
const watchUntilMs = t0 + WATCH_MINUTES * 60_000;
const chainAtMs = watchUntilMs - CHAIN_LEAD_MS;

const watchdog = setTimeout(
    () => {
        console.error(`${stamp()} WATCHDOG: overall budget exceeded — exiting (dead-man's switch will relaunch if the chain broke)`);
        try {
            client?.close();
        } catch {
            /* ignore */
        }
        process.exit(0);
    },
    (WATCH_MINUTES + 20) * 60_000,
);
watchdog.unref?.();

async function readEnabledFresh() {
    const devices = await client.getDevices().catch(() => []);
    const cam = devices.find((d) => d.getName() === CAMERA_NAME);
    if (!cam) return null;
    try {
        const v = cam.isEnabled();
        return v === true || v === 1 ? true : v === false || v === 0 ? false : null;
    } catch {
        return null;
    }
}

async function main() {
    if (!USERNAME) {
        console.error("FATAL: EUFY_USERNAME is not set (Actions secret missing) — refusing to start");
        process.exit(1);
    }
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    } catch {
        console.error("AWAY-WATCH SESSION: FAIL no stored session file — cannot run session-only watch");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("AWAY-WATCH SESSION: FAIL stored legacy token missing/expired — session-only watch refused");
        process.exit(1);
    }
    heartbeat.sessionExpiresAt = new Date(legacyExpiryMs).toISOString();
    log(`session gate ok: legacy token expires ${heartbeat.sessionExpiresAt}`);

    const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ff.error || ff.status !== 0) {
        console.error("FATAL: ffmpeg not available on this runner — cannot run the stream pipeline");
        process.exit(1);
    }

    const { EufySecurity } = await import(VENDOR_ENTRY);
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
    try {
        client.setLoggingLevel?.("all", 4);
    } catch {
        /* best-effort */
    }
    const onChallenge = (kind) => {
        if (sessionFailed) return;
        sessionFailed = true;
        heartbeat.sessionOk = false;
        heartbeat.state = "failed";
        heartbeat.note = `re-auth challenge (${kind}) at ${new Date().toISOString()}`;
        console.error(`AWAY-WATCH SESSION: FAIL server requested re-authentication (${kind}) — aborting; NOT chaining (the blocker ping owns this)`);
        syncHeartbeat(`away-watch session failed ${heartbeat.linkId}`).finally(() => process.exit(3));
        setTimeout(() => process.exit(3), 15_000).unref?.();
    };
    client.on("tfa request", () => onChallenge("verify_code"));
    client.on("captcha request", () => onChallenge("captcha"));

    await client.connect();
    if (sessionFailed) return;
    log("cloud connected (session-only)");

    let devices = [];
    const devDeadline = Date.now() + 60_000;
    while (Date.now() < devDeadline) {
        devices = await client.getDevices().catch(() => []);
        if (devices.length > 0) break;
        await sleep(2_000);
    }
    const camera = devices.find((d) => d.getName() === CAMERA_NAME);
    if (!camera) {
        console.error(`FATAL: ${CAMERA_NAME} not in device list (${devices.map((d) => d.getName()).join(", ") || "none"})`);
        process.exit(1);
    }
    const stations = await client.getStations().catch(() => []);
    const station = stations.find((s) => s.getSerial() === camera.getStationSerial());
    if (!station) {
        console.error(`FATAL: station for ${CAMERA_NAME} not resolvable`);
        process.exit(1);
    }
    const deviceSN = camera.getSerial();

    // ---- the arm check -------------------------------------------------------
    let enabled = null;
    try {
        const v = camera.isEnabled();
        enabled = v === true || v === 1 ? true : v === false || v === 0 ? false : null;
    } catch (e) {
        log(`isEnabled() threw (${shortErr(e)})`);
    }
    if (enabled === null) {
        console.error("FATAL: could not read the camera's enabled state — refusing to guess; not opening a stream");
        process.exit(1);
    }
    heartbeat.armed = enabled;
    if (!enabled) {
        await refreshAwayState(false, "away-watch link start");
        heartbeat.state = "disarmed-standby";
        heartbeat.note = "camera disabled at link start — chain does not run while disarmed";
        await syncHeartbeat(`away-watch disarmed standby ${heartbeat.linkId}`);
        log("AWAY WATCH: DISARMED — exiting without opening a stream (no chain while disarmed)");
        try {
            client.close();
        } catch {
            /* ignore */
        }
        process.exit(0);
    }
    await refreshAwayState(true, "away-watch link");
    log(`AWAY WATCH: ARMED — link ${heartbeat.linkId} holding the ${CAMERA_NAME} livestream for ${WATCH_MINUTES} min`);

    // ---- detector -------------------------------------------------------------
    let detectorOk = false;
    let detector = null;
    try {
        detector = await createPersonDetector({ modelPath: MODEL_PATH, log });
        const black = Buffer.alloc(300 * 300 * 3, 0);
        await detector.detect(black); // self-check: the model loads and runs
        detectorOk = true;
        log("detector self-check ok (SSD-MobileNet v1 loaded; black frame classified without error)");
    } catch (e) {
        heartbeat.note = `detector unavailable (${shortErr(e)}) — stream held for the camera-native backstop; NO person analysis this link`;
        log(`DETECTOR DOWN: ${shortErr(e)} — continuing stream-only (heartbeat will say armed-detector-down)`);
    }
    heartbeat.detectorOk = detectorOk;

    // ---- incident queue (serialized; the analyzer never blocks on cuts) -------
    const incidentQueue = [];
    let incidentChain = Promise.resolve();
    const analyzerHolder = { analyzer: null };
    function enqueueIncident(trigger) {
        heartbeat.personTriggers++;
        heartbeat.lastTriggerAt = new Date(trigger.atMs).toISOString();
        heartbeat.lastPersonConfidence = trigger.confidence;
        incidentQueue.push(trigger);
        incidentChain = incidentChain.then(() => processIncident(incidentQueue.shift())).catch((e) => log(`incident processing error: ${shortErr(e)}`));
    }
    async function processIncident(trigger) {
        if (!trigger) return;
        const ring = pipelineHolder.pipeline?.ring;
        if (!ring) {
            log("incident: no live ring at trigger time — segment not cut (stream was down)");
            return;
        }
        const fromMs = trigger.atMs - 30_000;
        const toMs = trigger.atMs + 30_000;
        // wait for the post-roll to land in the ring
        const waitDeadline = Date.now() + POST_ROLL_TIMEOUT_MS;
        while (Date.now() < waitDeadline) {
            ring.poll();
            if (ring.covers(fromMs, toMs)) break;
            if (Date.now() >= toMs + 35_000) break; // segment containing toMs should be closed by now
            await sleep(2_000);
        }
        const stampDigits = msToWallDigits(trigger.atMs);
        const bundleName = `${slugify(CAMERA_NAME)}-${slugify(CAMERA_NAME)}-${stampDigits}`;
        if (fs.existsSync(path.join(INBOX_DIR, bundleName, "record.json"))) {
            log(`incident: bundle ${bundleName} already in inbox — dedupe skip`);
            return;
        }
        const bundleDir = path.join(INBOX_DIR, bundleName);
        fs.mkdirSync(bundleDir, { recursive: true });
        try {
            const cutRes = await ring.cut(fromMs, toMs, path.join(bundleDir, "incident.mp4"));
            const relSec = Math.max(0, (trigger.atMs - fromMs) / 1000);
            spawnSync("ffmpeg", ["-v", "error", "-ss", String(relSec), "-i", path.join(bundleDir, "incident.mp4"), "-frames:v", "1", "-q:v", "3", "-y", path.join(bundleDir, "thumb.jpg")], { encoding: "utf8" });
            const bundle = {
                recordId: bundleName,
                station: CAMERA_NAME,
                device: CAMERA_NAME,
                model: camera.getModel() ?? null,
                source: "away-watch",
                priority: true,
                critical: true,
                startUtc: new Date(fromMs).toISOString(),
                endUtc: new Date(toMs).toISOString(),
                startMs: fromMs,
                endMs: toMs,
                startLocal: fmtLocal(trigger.atMs),
                endLocal: fmtLocal(toMs),
                durationSec: Math.round(cutRes.durationSec),
                triggerType: "away-watch-person",
                triggerName: "Away-watch detector: person-class trigger on the held livestream (GG judges the segment)",
                videoType: null,
                videoName: null,
                personFlagged: null, // detector output is a hint, never the verdict
                eventCount: null,
                countDelta: null,
                thumbFile: fs.existsSync(path.join(bundleDir, "thumb.jpg")) ? "thumb.jpg" : null,
                thumbBytes: fs.existsSync(path.join(bundleDir, "thumb.jpg")) ? fs.statSync(path.join(bundleDir, "thumb.jpg")).size : null,
                thumbError: null,
                clipFile: null, // incident.mp4 stays in the bundle; clip-intake skips clipFile-less bundles by design
                incidentFile: "incident.mp4",
                clipPreDecoded: true,
                clipBytes: fs.statSync(path.join(bundleDir, "incident.mp4")).size,
                clipError: null,
                clipSkipped: null,
                detector: {
                    model: "ssd_mobilenet_v1_12",
                    triggerUtc: new Date(trigger.atMs).toISOString(),
                    confidence: trigger.confidence,
                    hits: trigger.hits,
                    analysisFps: ANALYSIS_FPS,
                    segmentSegments: cutRes.segments,
                },
                sweptAt: new Date().toISOString(),
            };
            fs.writeFileSync(path.join(bundleDir, "record.json"), JSON.stringify(bundle, null, 2)); // last: bundle complete
            heartbeat.incidentsWritten++;
            await syncData(`away-watch incident ${bundleName}`);
            log(`incident: CRITICAL priority bundle ${bundleName} committed (trigger confidence ${trigger.confidence.toFixed(2)}, segment ${cutRes.durationSec.toFixed(1)}s)`);
        } catch (e) {
            log(`incident: segment cut FAILED for trigger ${new Date(trigger.atMs).toISOString()}: ${shortErr(e)} — the camera-native pipeline backstops this window`);
            try {
                fs.rmSync(bundleDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
    }

    // ---- stream management ------------------------------------------------------
    const pipelineHolder = { pipeline: null };
    let streamDownSince = null;
    let stopping = false;

    async function startStreamOnce() {
        let conn = await ensureP2PConnected(station);
        if (!conn.connected) {
            log(`P2P connect failed (${conn.error ?? "unknown"}) — settle, one retry`);
            try {
                station.close?.();
            } catch {
                /* ignore */
            }
            await sleep(CONNECT_SETTLE_MS);
            conn = await ensureP2PConnected(station);
        }
        if (!conn.connected) throw new Error(`P2P connect failed: ${conn.error ?? "unknown"}`);
        const started = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                client.off("station livestream start", onStart);
                resolve(v);
            };
            const onStart = (_st, device, metadata, videoStream, audioStream) => {
                if (device?.getSerial?.() !== deviceSN) return;
                try {
                    audioStream?.resume?.(); // drained; the ring is video-only by design
                } catch {
                    /* ignore */
                }
                finish({ metadata, videoStream });
            };
            const timer = setTimeout(() => finish(null), STREAM_START_TIMEOUT_MS);
            client.on("station livestream start", onStart);
            client.startStationLivestream(deviceSN).catch((e) => finish(null) ?? log(`startStationLivestream threw: ${shortErr(e)}`));
        });
        if (!started) throw new Error("livestream never started (90s window)");
        fs.rmSync(RING_DIR, { recursive: true, force: true });
        const analyzer = new FrameAnalyzer({
            detector: detector ?? {
                async personInFrame() {
                    return { people: [], dets: [] };
                },
            },
            log,
            onTrigger: (t) => enqueueIncident(t),
        });
        analyzerHolder.analyzer = analyzer;
        const pipeline = spawnLivePipeline({ videoStream: started.videoStream, codec: started.metadata?.videoCodec, ringDir: RING_DIR, analyzer, log });
        pipelineHolder.pipeline = pipeline;
        log(`stream up: codec=${started.metadata?.videoCodec} ${started.metadata?.videoWidth}x${started.metadata?.videoHeight} — ring + analysis running`);
        return pipeline;
    }

    async function ensureStream() {
        if (pipelineHolder.pipeline) return;
        try {
            await startStreamOnce();
            streamDownSince = null;
            heartbeat.streamActive = true;
            heartbeat.state = detectorOk ? "armed-watching" : "armed-detector-down";
        } catch (e) {
            if (streamDownSince === null) streamDownSince = Date.now();
            heartbeat.streamActive = false;
            heartbeat.state = "armed-stream-down";
            heartbeat.note = `stream down since ${new Date(streamDownSince).toISOString()}: ${shortErr(e)}`;
            log(`STREAM DOWN: ${shortErr(e)} — will retry; camera-native backstop covers events meanwhile`);
            try {
                await client.stopStationLivestream(deviceSN);
            } catch {
                /* ignore */
            }
        }
    }

    await ensureStream();

    // ---- hold the link -----------------------------------------------------------
    let lastHeartbeatSync = Date.now();
    let lastArmedCheck = Date.now();
    let lastBytes = 0;
    let lastBytesAt = Date.now();
    while (Date.now() < watchUntilMs) {
        await sleep(30_000);
        if (sessionFailed) return;
        const pipeline = pipelineHolder.pipeline;
        if (pipeline) {
            const b = pipeline.bytesIn();
            if (b !== lastBytes) {
                lastBytes = b;
                lastBytesAt = Date.now();
            }
            const exited = await Promise.race([pipeline.exited.then(() => true), Promise.resolve(false)]);
            if (exited || Date.now() - lastBytesAt > STREAM_STALL_MS) {
                log(exited ? "stream pipeline exited — restarting" : "stream stalled (no bytes) — restarting");
                try {
                    await pipeline.stop();
                } catch {
                    /* ignore */
                }
                pipelineHolder.pipeline = null;
                try {
                    await client.stopStationLivestream(deviceSN);
                } catch {
                    /* ignore */
                }
                if (streamDownSince === null) streamDownSince = Date.now();
                heartbeat.streamActive = false;
                heartbeat.state = "armed-stream-down";
                await sleep(STREAM_RESTART_SETTLE_MS);
                await ensureStream();
            } else {
                pipeline.ring.poll();
                pipeline.ring.prune(Date.now());
            }
        } else {
            await ensureStream();
        }
        if (analyzerHolder.analyzer) {
            heartbeat.framesAnalyzed = analyzerHolder.analyzer.stats.frames;
            heartbeat.motionFrames = analyzerHolder.analyzer.stats.motionFrames;
        }
        writeHeartbeatFile();
        if (Date.now() - lastHeartbeatSync >= HEARTBEAT_SYNC_MS) {
            lastHeartbeatSync = Date.now();
            await syncData(`away-watch heartbeat ${heartbeat.linkId}`);
            log(`heartbeat: state=${heartbeat.state} stream=${heartbeat.streamActive} frames=${heartbeat.framesAnalyzed} motion=${heartbeat.motionFrames} triggers=${heartbeat.personTriggers} incidents=${heartbeat.incidentsWritten}`);
        }
        if (streamDownSince !== null && Date.now() - streamDownSince > STREAM_DOWN_LIMIT_MS) {
            heartbeat.note = `stream down > ${STREAM_DOWN_LIMIT_MS / 60_000} min — link ended early, fresh link chained`;
            log("STREAM DOWN LIMIT: ending this link early and chaining a fresh one");
            await dispatchSuccessor("stream down limit");
            heartbeat.state = "ending";
            await syncHeartbeat(`away-watch link end (stream down) ${heartbeat.linkId}`);
            stopping = true;
            try {
                await pipelineHolder.pipeline?.stop();
            } catch {
                /* ignore */
            }
            try {
                client.close();
            } catch {
                /* ignore */
            }
            process.exit(0);
        }
        if (Date.now() - lastArmedCheck >= ARMED_RECHECK_MS) {
            lastArmedCheck = Date.now();
            const nowEnabled = await readEnabledFresh();
            if (nowEnabled === false) {
                log("DISARM detected mid-link (camera disabled) — standing down");
                stopping = true;
                try {
                    await pipelineHolder.pipeline?.stop();
                } catch {
                    /* ignore */
                }
                try {
                    await client.stopStationLivestream(deviceSN);
                } catch {
                    /* ignore */
                }
                await refreshAwayState(false, "away-watch standdown");
                heartbeat.state = "disarmed-standdown";
                heartbeat.armed = false;
                heartbeat.streamActive = false;
                await syncHeartbeat(`away-watch disarmed standdown ${heartbeat.linkId}`);
                try {
                    client.close();
                } catch {
                    /* ignore */
                }
                process.exit(0);
            }
            if (nowEnabled === true) await refreshAwayState(true, "away-watch link");
        }
        if (Date.now() >= chainAtMs && !chainDispatched) {
            const nowEnabled = await readEnabledFresh();
            if (nowEnabled === false) continue; // the recheck above will stand the link down
            await dispatchSuccessor("scheduled handoff");
        }
    }

    // window over: drain incidents, hand off, exit
    await Promise.race([incidentChain, sleep(60_000)]);
    await dispatchSuccessor("watch window complete");
    heartbeat.state = "ending";
    await syncHeartbeat(`away-watch link end ${heartbeat.linkId}`);
    log(`AWAY-WATCH LINK DOWN: linkId=${heartbeat.linkId} frames=${heartbeat.framesAnalyzed} triggers=${heartbeat.personTriggers} incidents=${heartbeat.incidentsWritten}`);
    stopping = true;
    try {
        await pipelineHolder.pipeline?.stop();
    } catch {
        /* ignore */
    }
    try {
        client.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
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
