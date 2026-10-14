#!/usr/bin/env node
/**
 * listener.mjs — Stage 1 of the security-guard program: the Eufy PUSH
 * LISTENER (runs in GitHub Actions as a long-lived, self-chaining job).
 *
 * One link of the chain:
 *   1. Restores the stored GUEST session passwordlessly (same offline
 *      gate as sweep.mjs — no password exists here, no login attempted;
 *      a re-auth challenge aborts the link with LISTENER SESSION: FAIL).
 *   2. Connects to Eufy cloud; the vendored client auto-registers FCM
 *      push on connect ("push connect" event; proven by Experiments
 *      A / A-peer, Oct 12–13, 2026 — see video-hunt/LIVE-RESULTS.md).
 *   3. Holds the connection for LISTEN_MINUTES (default 320 ≈ 5 h 20 m).
 *      Every "push message" is handled SERIALLY: the message carries
 *      the event's exact on-device file_path + its cipher, so the
 *      event's snapshot AND clip are pulled over P2P immediately and
 *      written as a bundle in the data repo inbox — same naming and
 *      record.json shape as the sweep's v4 bundles, plus
 *      source: "push" and priority: true. Each bundle is committed +
 *      pushed to the data repo as soon as it lands, where the GG-side
 *      fast-lane judge cron picks it up within minutes.
 *   4. Maintains listener-state.json (heartbeat) in the data repo:
 *      written at link start, re-synced every 5 minutes and after every
 *      handled event. The dead-man's switch lives GG-side: heartbeat
 *      stale > ~30 min → a fresh link is dispatched (see
 *      RELAY-BUILD.md "Stage 1 — push listener").
 *   5. Self-chaining: ~15 min before the listen window ends, the link
 *      dispatches its successor via `gh workflow run listener.yml`
 *      (workflow_dispatch is exempt from GitHub's token recursion
 *      guard). The workflow's concurrency group (eufy-listener,
 *      cancel-in-progress: false) holds the successor PENDING until
 *      this link exits, so links never pile up; the boot gap at each
 *      handoff (~2–3 min) is backstopped by the hourly sweep, which
 *      still sees every event via latest-info/enumeration.
 *
 * Dedupe contract (with the sweep + both review loops):
 *   - Bundle name is a pure function of (station, device, event stamp)
 *     — identical for the same event whoever captures it first.
 *   - The listener NEVER touches state.json, so the sweep still
 *     advances its own watermarks from latest-info; if the sweep later
 *     reaches an event the listener already bundled, the sweep's
 *     inbox-exists check skips re-delivery while the bundle sits in the
 *     inbox, and if a review loop already purged it, the sweep writes
 *     it once more and the review loops dedupe by (device, startLocal)
 *     against review-log.md — an event is never judged twice.
 *   - Within a link, a handled-bundle set + the inbox-exists check
 *     absorb duplicate pushes (an event typically pushes twice: first
 *     without file_path, then with it).
 *
 * In-scope pushes: messages carrying a usable media path, plus Front
 * Door events whose snapshot is constructed (see handlePush). Lock /
 * fingerprint messages (they carry person_name and no media) are
 * counted, never bundled. Pushes with no file_path for the SoloCam
 * family are counted and left to the sweep (the follow-up push for the
 * same event carries the path — Experiment A-peer).
 *
 * Logs never contain serials or session material: stations/devices are
 * referred to by name; push message contents are logged as type +
 * content string only (Eufy's own notification text, e.g. "Someone has
 * been spotted").
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ImageAttribution } from "./image-channel.mjs";
import { shiftStamp } from "./enum-paths.mjs";

const execFileP = promisify(execFile);

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_DIR = path.join(ROOT, "vendor", "eufy-security-client");
const VENDOR_ENTRY = path.join(VENDOR_DIR, "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR ? path.resolve(process.env.RELAY_DATA_DIR) : path.join(ROOT, "data");
const INBOX_DIR = path.join(DATA_DIR, "inbox");
const HEARTBEAT_FILE = path.join(DATA_DIR, "listener-state.json");
const DEVICE_TZ = "America/Los_Angeles";
const REPO = process.env.GH_REPO || "suvamsh/eufy-relay";

const LISTEN_MINUTES = Math.max(5, Number(process.env.LISTEN_MINUTES || 320) || 320);
const CHAIN_ENABLED = process.env.LISTENER_CHAIN !== "false";
const CHAIN_LEAD_MS = 15 * 60_000; // dispatch the successor this long before the window ends
const HEARTBEAT_SYNC_MS = 5 * 60_000; // heartbeat commit cadence (dead-man threshold is ~30 min)
const PUSH_DOWN_LIMIT_MS = 10 * 60_000; // push down this long -> end link early, chain a fresh one
const PUSH_REREGISTER_MS = 20 * 60_000; // heal a stolen push registration (see reregisterPush)
const CONNECT_TIMEOUT_MS = 90_000;
const CONNECT_SETTLE_MS = 20_000;
const IMAGE_TIMEOUT_MS = 30_000;
const FD_PROBE_TIMEOUT_MS = 6_000; // Front Door constructed-path probe cap per stamp
// clip bounds — same values as sweep v4
const CLIP_START_CAP_MS = 20_000;
const CLIP_TOTAL_CAP_MS = 40_000;
// Station -> cipher id fallback for startStationDownload when a push
// message carries no cipher of its own (Experiment O map; the push
// message's own cipher wins — A-peer carried 220 for Porch).
const CIPHER_BY_STATION = {
    Porch: 220,
    "Living Room": 107,
};
const CLIP_NO_CIPHER_REASON = {
    WifiBridge:
        "Front Door (doorbell via WifiBridge): no clip path/cipher combination worked in Experiment O (15 trials, all silent) — snapshots only for this family",
};
// Front Door constructed snapshot probe: event stamp ± seconds (the
// snapshot's finalized stamp can sit a few seconds off the push's
// event_session — exp-r3 recovered 20261013122529 exactly, and sweep
// v4.1 measured a ~4–5 s finalization lead on the SoloCam family).
const FD_PROBE_OFFSETS = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8, -10, 10];

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
// timezone helpers (mirror sweep.mjs)
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
/** Device-local wall time (14-digit stamp) -> epoch ms. */
function wallStampToMs(digits) {
    const y = +digits.slice(0, 4);
    const mo = +digits.slice(4, 6);
    const d = +digits.slice(6, 8);
    const h = +digits.slice(8, 10);
    const mi = +digits.slice(10, 12);
    const s = +digits.slice(12, 14);
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let utc = guess - tzOffsetMs(DEVICE_TZ, guess);
    utc = guess - tzOffsetMs(DEVICE_TZ, utc);
    return utc;
}
/** Epoch ms -> device-local 14-digit stamp. */
function msToWallDigits(ms) {
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
    return `${parts.year}${parts.month}${parts.day}${parts.hour === "24" ? "00" : parts.hour}${parts.minute}${parts.second}`;
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
/** First 14-digit timestamp embedded in an on-device path. */
function parsePathStamp(p) {
    const m = String(p ?? "").match(/(\d{14})/);
    return m ? m[1] : null;
}
/** Clip path for a snapshot path (SoloCam/indoor family only; sweep v4 rule). */
function clipPathForSnapshot(snapshotPath) {
    if (typeof snapshotPath !== "string") return null;
    if (/_snapshot\.jpg$/.test(snapshotPath)) return snapshotPath.replace(/_snapshot\.jpg$/, ".zxvideo");
    return null;
}
function snapshotPathForClip(clipPath) {
    if (typeof clipPath !== "string") return null;
    if (/\.zxvideo$/.test(clipPath)) return clipPath.replace(/\.zxvideo$/, "_snapshot.jpg");
    return null;
}

// ---------------------------------------------------------------------------
// session gate (mirror sweep.mjs)
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
// image sniffing (mirror sweep.mjs)
// ---------------------------------------------------------------------------
function sniffImage(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
    if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) return ".gif";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
    return ".jpg";
}

// ---------------------------------------------------------------------------
// git plumbing for the data repo (serialized; merge-based sync so a
// concurrent sweep commit never wedges the listener: conflicts resolve
// toward upstream for shared files, our new bundle files are unique
// paths and survive; the weekly history reset keeps merges from
// accumulating)
// ---------------------------------------------------------------------------
function gitEnv() {
    const env = { ...process.env };
    const keyFile = process.env.DATA_SSH_KEY_FILE;
    if (keyFile && fs.existsSync(keyFile)) {
        env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
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
        log(`data sync FAILED after retries: ${message} (files remain in the runner checkout; the sweep backstops the events)`);
        return false;
    };
    gitChain = gitChain.then(run, run);
    return gitChain;
}

// ---------------------------------------------------------------------------
// heartbeat (listener-state.json in the data repo)
// ---------------------------------------------------------------------------
const heartbeat = {
    kind: "eufy-listener-heartbeat",
    version: 1,
    linkId: new Date().toISOString(),
    runId: process.env.GITHUB_RUN_ID || null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "starting", // starting | listening | ending | failed
    pushConnected: false,
    lastPushAt: null,
    lastPushConnectedAt: null,
    pushesReceived: 0,
    pushesHandled: 0,
    pushesSkipped: 0,
    bundlesWritten: 0,
    pushReregistrations: 0,
    lastEvent: null, // { device, stamp, at }
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

// ---------------------------------------------------------------------------
// P2P connect (mirror sweep.mjs ensureP2PConnected)
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
// v4 converter capture hooks (same capture-only vendored patch as the
// sweep; armed only while a clip download runs — downloads are serial)
// ---------------------------------------------------------------------------
let activeClipCapture = null;
globalThis.__eufyCaptureFrame = (rec) => {
    if (activeClipCapture) activeClipCapture.frames.push(rec);
};
globalThis.__eufyCaptureRaw = (rec) => {
    if (activeClipCapture) activeClipCapture.rawFrames.push(rec);
};

// ---------------------------------------------------------------------------
// per-station channel: image + clip downloads over client events, with
// the v4.1 attribution rules (image-channel.mjs) — same contract as the
// sweep's StationChannel, minus latest-info (the listener never queries
// the event DB; pushes name the files directly)
// ---------------------------------------------------------------------------
class StationChannel {
    constructor(client, station) {
        this.client = client;
        this.station = station;
        this.serial = station.getSerial();
        this.name = station.getName();
        this.pendingImages = new ImageAttribution(this.serial);
        this.client.on("station image download", (station, file, image) => {
            this.pendingImages.route(station?.getSerial?.(), file, image);
        });
        this.pendingClip = null;
        this.client.on("station download start", (station, device, metadata, videoStream, audioStream) => {
            const pending = this.pendingClip;
            if (station?.getSerial?.() !== this.serial || !pending || device?.getSerial?.() !== pending.deviceSN) {
                try {
                    videoStream?.resume?.();
                } catch {
                    /* ignore */
                }
                try {
                    audioStream?.resume?.();
                } catch {
                    /* ignore */
                }
                return;
            }
            pending.started = true;
            clearTimeout(pending.startTimer);
            videoStream.on("data", (chunk) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                pending.bytes += buf.length;
                pending.hash.update(buf);
                pending.writeStream.write(buf);
            });
            videoStream.on("error", (e) => pending.fail(new Error(`clip video stream error: ${shortErr(e)}`)));
            if (audioStream?.resume) audioStream.resume();
        });
        this.client.on("station download finish", (station, device) => {
            const pending = this.pendingClip;
            if (station?.getSerial?.() !== this.serial || !pending || device?.getSerial?.() !== pending.deviceSN) return;
            pending.finishTimer = setTimeout(() => pending.succeed(), 750);
        });
    }

    async downloadImageOnce(filePath, timeoutMs = IMAGE_TIMEOUT_MS) {
        if (this.pendingImages.has(filePath)) throw new Error("an image download is already outstanding for this path");
        const p = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const entry = this.pendingImages.expire(filePath);
                if (entry) entry.reject(new Error(`timeout after ${timeoutMs}ms waiting for image download`));
            }, timeoutMs);
            this.pendingImages.register(filePath, { resolve, reject, timer });
        });
        try {
            this.station.downloadImage(filePath);
        } catch (e) {
            this.pendingImages.drop(filePath);
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

    /** Short-cap probe whose buffer IS the image (Front Door path hunt). */
    async probeImage(filePath, timeoutMs = FD_PROBE_TIMEOUT_MS) {
        return this.downloadImageOnce(filePath, timeoutMs);
    }

    async downloadClip({ deviceSN, clipPath, cipherId, destPath }) {
        if (this.pendingClip) throw new Error("a clip download is already outstanding on this station");
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(destPath);
            const pending = {
                deviceSN,
                started: false,
                bytes: 0,
                hash: crypto.createHash("sha256"),
                writeStream,
                startTimer: null,
                totalTimer: null,
                finishTimer: null,
                fail: null,
                succeed: null,
            };
            const capture = { frames: [], rawFrames: [] };
            activeClipCapture = capture;
            const cleanup = () => {
                clearTimeout(pending.startTimer);
                clearTimeout(pending.totalTimer);
                clearTimeout(pending.finishTimer);
                if (this.pendingClip === pending) this.pendingClip = null;
                if (activeClipCapture === capture) activeClipCapture = null;
            };
            pending.fail = (err) => {
                cleanup();
                try {
                    writeStream.destroy();
                } catch {
                    /* ignore */
                }
                try {
                    fs.unlinkSync(destPath);
                } catch {
                    /* ignore */
                }
                reject(err);
            };
            pending.succeed = () => {
                cleanup();
                writeStream.end(() => {
                    resolve({ bytes: pending.bytes, sha256: pending.hash.digest("hex"), capture });
                });
            };
            writeStream.on("error", (e) => pending.fail(new Error(`clip file write error: ${shortErr(e)}`)));
            pending.startTimer = setTimeout(() => {
                if (!pending.started) pending.fail(new Error(`no download start within ${CLIP_START_CAP_MS / 1000}s (wrong cipher or missing file)`));
            }, CLIP_START_CAP_MS);
            pending.totalTimer = setTimeout(() => pending.fail(new Error(`clip download exceeded ${CLIP_TOTAL_CAP_MS / 1000}s`)), CLIP_TOTAL_CAP_MS);
            this.pendingClip = pending;
            Promise.resolve(this.client.startStationDownload(deviceSN, clipPath, cipherId)).catch((e) =>
                pending.fail(new Error(`startStationDownload threw: ${shortErr(e)}`)),
            );
        });
    }
}

/**
 * Attempt the clip for one push bundle and record the outcome on the
 * bundle object (same fields/semantics as sweep v4's attachClip).
 * Never throws.
 */
async function attachClip({ channel, deviceSN, cipherId, clipPath, bundleDir, bundle, logPrefix, noCipherReason }) {
    if (cipherId === null || cipherId === undefined) {
        bundle.clipSkipped = noCipherReason ?? "no cipher id known for this station and the push carried none — clip not attempted (see RELAY-BUILD.md, sweep v4 cipher map)";
        return false;
    }
    if (!clipPath) {
        bundle.clipSkipped = "no clip path derivable from this event's snapshot path";
        return false;
    }
    bundle.clipCipherId = cipherId;
    try {
        const { bytes, sha256, capture } = await channel.downloadClip({
            deviceSN,
            clipPath,
            cipherId,
            destPath: path.join(bundleDir, "clip.zxvideo"),
        });
        bundle.clipFile = "clip.zxvideo";
        bundle.clipBytes = bytes;
        bundle.clipSha256 = sha256;
        bundle.clipError = null;
        bundle.clipSkipped = null;
        if (capture && capture.frames.length > 0) {
            fs.writeFileSync(path.join(bundleDir, "clip-frames.json"), JSON.stringify(capture, null, 2));
            bundle.clipFramesFile = "clip-frames.json";
            bundle.clipFrameCount = capture.frames.length;
            bundle.clipKeyedFrames = capture.rawFrames.length;
            const mapBytes = capture.frames.reduce((a, f) => a + (f.videoDataSize ?? 0), 0);
            bundle.clipFrameMapOk = mapBytes === bytes;
            if (!bundle.clipFrameMapOk) {
                log(`${logPrefix}: WARNING frame map sums to ${mapBytes} bytes vs clip ${bytes} bytes — sidecar may be unreliable`);
            }
        } else {
            bundle.clipFramesError = "no frame capture recorded for this download (vendored capture hook inactive)";
        }
        log(`${logPrefix}: clip fetched (${bytes} bytes, sha256 ${sha256.slice(0, 16)}…, frames=${capture?.frames.length ?? 0}, keyed=${capture?.rawFrames.length ?? 0})`);
        return true;
    } catch (e) {
        bundle.clipError = shortErr(e);
        bundle.clipSkipped = null;
        log(`${logPrefix}: clip fetch failed: ${shortErr(e)}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// self-chaining
// ---------------------------------------------------------------------------
let chainDispatched = false;
async function dispatchSuccessor(reason) {
    if (!CHAIN_ENABLED) {
        log(`chain: disabled (LISTENER_CHAIN=false) — not dispatching a successor (${reason})`);
        return;
    }
    if (chainDispatched) return;
    chainDispatched = true;
    try {
        await execFileP("gh", ["workflow", "run", "listener.yml", "--repo", REPO], { env: { ...process.env }, maxBuffer: 1024 * 1024 });
        log(`chain: successor link dispatched (${reason}) — it stays PENDING in the eufy-listener concurrency group until this link exits`);
    } catch (e) {
        chainDispatched = false; // a later tick may retry
        log(`chain: successor dispatch FAILED (${reason}): ${shortErr(e)} — the dead-man's switch is the backstop`);
    }
}

// ---------------------------------------------------------------------------
// push handling
// ---------------------------------------------------------------------------
let client = null;
const handledBundles = new Set(); // bundle names handled (or found present) by this link
const channelByStation = new Map(); // station serial -> StationChannel (live only during an event)
let stationBySerial = new Map();
let deviceBySerial = new Map();

async function refreshDeviceLists() {
    const stations = await client.getStations().catch(() => []);
    const devices = await client.getDevices().catch(() => []);
    if (stations.length) stationBySerial = new Map(stations.map((s) => [s.getSerial(), s]));
    if (devices.length) deviceBySerial = new Map(devices.map((d) => [d.getSerial(), d]));
    return devices.length > 0;
}

async function connectChannel(stationObj) {
    const serial = stationObj.getSerial();
    const existing = channelByStation.get(serial);
    if (existing && stationObj.isConnected()) return existing;
    let conn = await ensureP2PConnected(stationObj, CONNECT_TIMEOUT_MS);
    if (!conn.connected) {
        log(`${stationObj.getName()}: P2P connect failed (${conn.error ?? "unknown"}) — settle ${CONNECT_SETTLE_MS / 1000}s, one retry`);
        try {
            stationObj.close?.();
        } catch {
            /* ignore */
        }
        await sleep(CONNECT_SETTLE_MS);
        conn = await ensureP2PConnected(stationObj, CONNECT_TIMEOUT_MS);
        if (!conn.connected) return null;
    }
    const channel = new StationChannel(client, stationObj);
    channelByStation.set(serial, channel);
    return channel;
}

function disconnectStation(stationObj) {
    channelByStation.delete(stationObj.getSerial());
    try {
        stationObj.close?.();
    } catch {
        /* ignore */
    }
}

/**
 * Handle one push message. Serialized by the caller. Media plan:
 *  - file_path ends .zxvideo  -> clip path; snapshot is its _snapshot.jpg sibling
 *  - file_path ends .jpg      -> snapshot path; clip derived for the _snapshot family
 *  - no file_path, Front Door -> construct /media/mmcblk0p1/video/<stamp>_c00.jpg
 *    from the event stamp and probe a ±10 s window of finalized stamps
 *  - no file_path, other cams -> counted only (the event's follow-up push
 *    carries the path; the sweep backstops regardless)
 */
async function handlePush(m) {
    const receivedMs = Date.now();
    const receivedAt = new Date(receivedMs).toISOString();
    heartbeat.pushesReceived++;
    heartbeat.lastPushAt = receivedAt;

    const content = typeof m?.content === "string" ? m.content : "";
    const deviceSN = typeof m?.device_sn === "string" ? m.device_sn : null;

    // Lock / fingerprint notifications ride the same push channel but are
    // not camera events (they carry person_name, never a media path).
    if (m?.person_name || /lock|unlock|fingerprint/i.test(content)) {
        heartbeat.pushesSkipped++;
        log(`push: non-camera notification (${content || "lock event"}) — counted, no bundle`);
        return;
    }
    if (!deviceSN) {
        heartbeat.pushesSkipped++;
        log(`push: no device_sn (type=${m?.type}) — counted, no bundle`);
        return;
    }

    let device = deviceBySerial.get(deviceSN);
    if (!device) {
        await refreshDeviceLists();
        device = deviceBySerial.get(deviceSN);
    }
    if (!device) {
        heartbeat.pushesSkipped++;
        log(`push: unknown device (type=${m?.type}) — counted, no bundle`);
        return;
    }
    const stationObj = stationBySerial.get(device.getStationSerial());
    if (!stationObj) {
        heartbeat.pushesSkipped++;
        log(`push: station for ${device.getName()} not resolvable — counted, no bundle`);
        return;
    }
    const stationName = stationObj.getName();
    const deviceName = device.getName();

    // ---- media plan ------------------------------------------------------
    const fp = typeof m.file_path === "string" ? m.file_path : "";
    let clipPath = null;
    let snapshotPath = null;
    let frontDoorStamp = null;
    if (fp.endsWith(".zxvideo")) {
        clipPath = fp;
        snapshotPath = snapshotPathForClip(fp);
    } else if (/\.jpe?g$/i.test(fp)) {
        snapshotPath = fp;
        clipPath = clipPathForSnapshot(fp);
    } else if (stationName === "WifiBridge") {
        const sessionDigits = typeof m.event_session === "string" ? m.event_session.replace(/\D/g, "") : "";
        if (sessionDigits.length === 14) frontDoorStamp = sessionDigits;
        else if (typeof m.event_time === "number" && m.event_time > 0) frontDoorStamp = msToWallDigits(m.event_time);
    }
    if (!clipPath && !snapshotPath && !frontDoorStamp) {
        heartbeat.pushesSkipped++;
        log(`push: ${deviceName} event without a media path (push_count=${m.push_count ?? "?"}) — counted; the follow-up push or the sweep covers it`);
        return;
    }

    const stampDigits = parsePathStamp(snapshotPath || clipPath || "") || frontDoorStamp;
    if (!stampDigits) {
        heartbeat.pushesSkipped++;
        log(`push: ${deviceName} media path carries no event stamp — counted, no bundle`);
        return;
    }
    const eventMs = wallStampToMs(stampDigits);
    const bundleName = `${slugify(stationName)}-${slugify(deviceName)}-${stampDigits}`;
    if (handledBundles.has(bundleName)) {
        log(`push: ${deviceName} ${stampDigits} already handled by this link — dedupe skip`);
        return;
    }
    if (fs.existsSync(path.join(INBOX_DIR, bundleName, "record.json"))) {
        handledBundles.add(bundleName);
        log(`push: bundle ${bundleName} already in inbox (sweep or an earlier link) — dedupe skip`);
        return;
    }
    handledBundles.add(bundleName);

    log(`push: ${deviceName} event ${fmtLocal(eventMs)} (type=${m.event_type ?? m.type ?? "?"}, "${content}") — fetching media`);
    const channel = await connectChannel(stationObj);
    if (!channel) {
        heartbeat.note = `P2P connect failed for ${stationName} at ${receivedAt}; the sweep backstops the event`;
        log(`push: ${deviceName} ${stampDigits}: P2P connect failed — no bundle written; the sweep backstops this event`);
        handledBundles.delete(bundleName); // a later duplicate push may retry within this link
        return;
    }

    const bundleDir = path.join(INBOX_DIR, bundleName);
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundle = {
        recordId: bundleName,
        station: stationName,
        device: deviceName,
        model: device.getModel() ?? null,
        source: "push",
        priority: true,
        startUtc: new Date(eventMs).toISOString(),
        endUtc: new Date(eventMs).toISOString(),
        startMs: eventMs,
        endMs: eventMs,
        startLocal: fmtLocal(eventMs),
        endLocal: fmtLocal(eventMs),
        durationSec: null,
        triggerType: typeof m.event_type === "number" ? m.event_type : null,
        triggerName: content || null,
        videoType: null,
        videoName: null,
        personFlagged: null, // push text is a hint, not a classification; GG judges the media
        eventCount: null, // pushes carry no device counter
        countDelta: null,
        thumbFile: null,
        thumbBytes: null,
        thumbError: null,
        clipFile: null,
        clipBytes: null,
        clipSha256: null,
        clipCipherId: null,
        clipFramesFile: null,
        clipFrameCount: null,
        clipKeyedFrames: null,
        clipFrameMapOk: null,
        clipFramesError: null,
        clipError: null,
        clipSkipped: null,
        pushReceivedUtc: receivedAt,
        pushEventMs: typeof m.event_time === "number" ? m.event_time : null,
        pushLatencyMs: typeof m.event_time === "number" && m.event_time > 0 ? receivedMs - m.event_time : null,
        pushId: typeof m.unique_id === "string" ? m.unique_id : null,
        sweptAt: new Date().toISOString(),
    };

    try {
        if (snapshotPath) {
            const buf = await channel.downloadImage(snapshotPath);
            const file = `thumb${sniffImage(buf)}`;
            fs.writeFileSync(path.join(bundleDir, file), buf);
            bundle.thumbFile = file;
            bundle.thumbBytes = buf.length;
        } else if (frontDoorStamp) {
            // construct-and-probe the doorbell's /video/<stamp>_c00.jpg
            let found = null;
            for (const batchStart of [0, 6, 12]) {
                const batch = FD_PROBE_OFFSETS.slice(batchStart, batchStart + 6);
                const results = await Promise.all(
                    batch.map(async (off) => {
                        const candidateStamp = shiftStamp(frontDoorStamp, off);
                        const candidatePath = `/media/mmcblk0p1/video/${candidateStamp}_c00.jpg`;
                        try {
                            const buf = await channel.probeImage(candidatePath);
                            return { candidateStamp, buf };
                        } catch {
                            return null;
                        }
                    }),
                );
                found = results.find((r) => r?.buf) ?? null;
                if (found) break;
            }
            if (found) {
                const file = `thumb${sniffImage(found.buf)}`;
                fs.writeFileSync(path.join(bundleDir, file), found.buf);
                bundle.thumbFile = file;
                bundle.thumbBytes = found.buf.length;
                if (found.candidateStamp !== stampDigits) bundle.pushNote = `snapshot finalized at ${found.candidateStamp}, push event stamp ${stampDigits}`;
            } else {
                bundle.thumbError = "no Front Door snapshot found in the ±10s constructed-path window";
                log(`push: ${deviceName} ${stampDigits}: constructed-path probe found no snapshot`);
            }
        }
    } catch (e) {
        bundle.thumbError = shortErr(e);
        log(`push: ${deviceName} ${stampDigits}: snapshot download failed: ${shortErr(e)}`);
    }

    // clip: the push message's own cipher wins; station map is the fallback
    const cipherId = typeof m.cipher === "number" ? m.cipher : (CIPHER_BY_STATION[stationName] ?? null);
    await attachClip({
        channel,
        deviceSN,
        cipherId,
        clipPath,
        bundleDir,
        bundle,
        logPrefix: `push: ${deviceName} ${stampDigits}`,
        noCipherReason: CLIP_NO_CIPHER_REASON[stationName] ?? null,
    });

    // record.json last: a bundle dir containing record.json is complete
    bundle.sweptAt = new Date().toISOString();
    fs.writeFileSync(path.join(bundleDir, "record.json"), JSON.stringify(bundle, null, 2));
    heartbeat.pushesHandled++;
    heartbeat.bundlesWritten++;
    heartbeat.lastEvent = { device: deviceName, stamp: stampDigits, at: receivedAt };
    disconnectStation(stationObj);
    await syncHeartbeat(`push ${bundleName}`);
    log(`push: bundle ${bundleName} committed (thumb=${bundle.thumbFile ?? "none"}, clip=${bundle.clipFile ?? bundle.clipError ?? bundle.clipSkipped ?? "none"})`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
/**
 * Re-register this link's push token with Eufy cloud.
 *
 * Why: the account's push routing follows the MOST RECENT token
 * registration. In the vendored client, every cloud connect runs
 * registerPushNotifications -> PushNotificationService.open() ->
 * _open(false, true): fresh FCM credentials are force-minted and
 * eufysecurity binds the new token account-wide (registerPushToken,
 * legacy + mega backends). Any other process that connects with this
 * session therefore steals routing into itself, and when it exits the
 * pushes go to a dead token while this link's own socket stays up —
 * the zero-push failure of Oct 13, 2026 (see RELAY-BUILD.md, Stage 1
 * addendum). The relay's other jobs now run with EUFY_NO_PUSH=1
 * (vendored push-ownership patch in eufysecurity.js), but a stray
 * connect (a manual harness run, a future job) can still steal
 * routing. Closing and reopening the push service mints a fresh
 * token whose MCS connect re-runs the account binding, returning
 * routing to this live link. Invoked on a timer from the hold loop.
 */
async function reregisterPush(reason) {
    try {
        const ps = client?.getPushService?.();
        if (!ps) return false;
        log(`push re-register (${reason}): closing the push service to mint a fresh token + account binding`);
        try {
            ps.close();
        } catch {
            /* ignore */
        }
        await sleep(3_000);
        await ps.open();
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
            let connected = false;
            try {
                connected = Boolean(client.isPushConnected());
            } catch {
                /* keep waiting */
            }
            if (connected) {
                heartbeat.pushReregistrations++;
                heartbeat.pushConnected = true;
                heartbeat.lastPushConnectedAt = new Date().toISOString();
                log(`push re-register (${reason}): push reconnected — account routing re-bound to this link (total ${heartbeat.pushReregistrations})`);
                return true;
            }
            await sleep(2_000);
        }
        log(`push re-register (${reason}): push did not reconnect within 45s — the push-down logic will chain a fresh link if it stays down`);
        return false;
    } catch (e) {
        log(`push re-register (${reason}) failed: ${shortErr(e)}`);
        return false;
    }
}

let sessionFailed = false;
const listenUntilMs = t0 + LISTEN_MINUTES * 60_000;
const chainAtMs = listenUntilMs - CHAIN_LEAD_MS;

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
    (LISTEN_MINUTES + 20) * 60_000,
);
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
        console.error("LISTENER SESSION: FAIL no stored session file — cannot run session-only listener");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("LISTENER SESSION: FAIL stored legacy token missing/expired — session-only listener refused");
        process.exit(1);
    }
    heartbeat.sessionExpiresAt = new Date(legacyExpiryMs).toISOString();
    log(`session gate ok: legacy token expires ${heartbeat.sessionExpiresAt}`);

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
        logging: { level: 4 }, // Error only: client debug logs would dump raw payloads
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
        console.error(`LISTENER SESSION: FAIL server requested re-authentication (${kind}) — session-only listener aborting; NOT chaining (a successor would fail identically; the blocker ping owns this)`);
        syncHeartbeat(`listener session failed ${heartbeat.linkId}`).finally(() => process.exit(3));
        setTimeout(() => process.exit(3), 15_000).unref?.();
    };
    client.on("tfa request", () => onChallenge("verify_code"));
    client.on("captcha request", () => onChallenge("captcha"));

    let pushHandlerChain = Promise.resolve();
    client.on("push connect", () => {
        heartbeat.pushConnected = true;
        heartbeat.lastPushConnectedAt = new Date().toISOString();
        log("push connect (FCM registered)");
    });
    client.on("push close", () => {
        heartbeat.pushConnected = false;
        log("push close — monitoring for the reconnect window");
    });
    client.on("push message", (message) => {
        pushHandlerChain = pushHandlerChain
            .then(() => handlePush(message ?? {}))
            .catch((e) => log(`push handling error: ${shortErr(e)}`));
    });

    await client.connect();
    if (sessionFailed) return; // exit path already armed
    log("cloud connected (session-only)");

    const devDeadline = Date.now() + 60_000;
    while (Date.now() < devDeadline) {
        if (await refreshDeviceLists()) break;
        await sleep(2_000);
    }
    log(`devices: ${[...deviceBySerial.values()].map((d) => `${d.getName()} (${d.getModel()})`).join(", ") || "(none yet)"}`);

    // let push registration settle, then confirm it (Experiment A: the
    // "push connect" event fired ~15 s after connect on runners)
    await sleep(15_000);
    try {
        heartbeat.pushConnected = Boolean(client.isPushConnected());
    } catch {
        /* keep the event-driven value */
    }
    if (heartbeat.pushConnected) heartbeat.lastPushConnectedAt = new Date().toISOString();

    heartbeat.state = "listening";
    await syncHeartbeat(`listener link start ${heartbeat.linkId}`);
    log(`LISTENER LINK UP: linkId=${heartbeat.linkId} pushConnected=${heartbeat.pushConnected} listenMinutes=${LISTEN_MINUTES} chain=${CHAIN_ENABLED} until=${new Date(listenUntilMs).toISOString()}`);

    // ---- hold the link ----------------------------------------------------
    let lastHeartbeatSync = Date.now();
    let lastReregister = Date.now();
    let pushDownSince = heartbeat.pushConnected ? null : Date.now();
    while (Date.now() < listenUntilMs) {
        await sleep(30_000);
        if (sessionFailed) return;
        try {
            heartbeat.pushConnected = Boolean(client.isPushConnected());
        } catch {
            /* keep last known */
        }
        if (heartbeat.pushConnected) {
            heartbeat.lastPushConnectedAt = new Date().toISOString();
            pushDownSince = null;
        } else if (pushDownSince === null) {
            pushDownSince = Date.now();
            log("push appears disconnected — watching the reconnect window");
        }
        writeHeartbeatFile();
        if (Date.now() - lastHeartbeatSync >= HEARTBEAT_SYNC_MS) {
            lastHeartbeatSync = Date.now();
            await syncData(`listener heartbeat ${heartbeat.linkId}`);
            log(
                `heartbeat: pushConnected=${heartbeat.pushConnected} received=${heartbeat.pushesReceived} handled=${heartbeat.pushesHandled} skipped=${heartbeat.pushesSkipped} bundles=${heartbeat.bundlesWritten} rereg=${heartbeat.pushReregistrations}`,
            );
        }
        if (Date.now() - lastReregister >= PUSH_REREGISTER_MS) {
            lastReregister = Date.now();
            await reregisterPush("periodic heal");
        }
        if (pushDownSince !== null && Date.now() - pushDownSince > PUSH_DOWN_LIMIT_MS) {
            heartbeat.state = "failed";
            heartbeat.note = `push connection down > ${PUSH_DOWN_LIMIT_MS / 60_000} min at ${new Date().toISOString()} — link ended early, fresh link chained`;
            log("LISTENER PUSH DOWN: ending this link early and chaining a fresh one (a fresh registration is the fastest repair)");
            await dispatchSuccessor("push connection lost");
            await syncHeartbeat(`listener link failed (push down) ${heartbeat.linkId}`);
            try {
                client.close();
            } catch {
                /* ignore */
            }
            process.exit(0);
        }
        if (Date.now() >= chainAtMs && !chainDispatched) {
            await dispatchSuccessor("scheduled handoff");
        }
    }

    // window over: drain in-flight push handling briefly, then hand off
    await Promise.race([pushHandlerChain, sleep(60_000)]);
    await dispatchSuccessor("listen window complete");
    heartbeat.state = "ending";
    await syncHeartbeat(`listener link end ${heartbeat.linkId}`);
    log(`LISTENER LINK DOWN: linkId=${heartbeat.linkId} received=${heartbeat.pushesReceived} handled=${heartbeat.pushesHandled} bundles=${heartbeat.bundlesWritten}`);
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
