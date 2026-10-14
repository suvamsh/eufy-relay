#!/usr/bin/env node
/**
 * away-state.mjs — Stage 5 arm/disarm detector (v2 away-mode indoor
 * watch). The Living Room camera's account-level enabled state IS the
 * away signal (design §2: no manual mode, no calendar/location
 * triggers): Suvamsh turns that camera on only when the household is
 * away, so `Device.isEnabled()` on it is ground truth.
 *
 * One run: restore the stored guest session (same offline gate as the
 * sweep/listener — a re-auth challenge prints AWAY-STATE SESSION: FAIL
 * and exits 3), read the Living Room device's enabled state from the
 * cloud device list, and write `away-state.json` at the data-repo root:
 *
 *   { kind, version, armed, cameraEnabled, sinceUtc, updatedAt,
 *     source, sessionOk, sessionExpiresAt, note }
 *
 * `sinceUtc` is preserved across runs while `armed` is unchanged and
 * reset when it flips. Writers (last-writer-wins via the merge-based
 * sync; the file is tiny and every writer reads before writing):
 * this checker, the away-watch links, and nothing else.
 *
 * ARM PATH: when a run finds armed=true and no away-watch.yml run is
 * active (in_progress/queued), it dispatches the watch chain itself —
 * arming latency is then bounded by how often this checker runs (the
 * GG fast-lane judge dispatches it whenever away-state.json is stale;
 * its own 2-hourly schedule is only a safety net).
 *
 * Logs never contain serials or session material; the camera is
 * referred to by name.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <root>/app
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR ? path.resolve(process.env.RELAY_DATA_DIR) : path.join(ROOT, "data");
const AWAY_FILE = path.join(DATA_DIR, "away-state.json");
const CAMERA_NAME = "Living Room";
const REPO = process.env.GH_REPO || "suvamsh/muse-security-guard";

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 240);

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
// data-repo sync (merge-based; mirrors listener.mjs)
// ---------------------------------------------------------------------------
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
async function syncData(message) {
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
    log(`data sync FAILED after retries: ${message}`);
    return false;
}

// ---------------------------------------------------------------------------
// away-state.json read/write (preserve sinceUtc across unchanged states)
// ---------------------------------------------------------------------------
function readAwayState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(AWAY_FILE, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}
export function computeAwayState(prev, { armed, sessionOk = true, sessionExpiresAt = null, note = null, source }) {
    const nowIso = new Date().toISOString();
    const flipped = !prev || prev.armed !== armed;
    return {
        kind: "eufy-away-state",
        version: 1,
        armed,
        cameraEnabled: armed,
        sinceUtc: flipped ? nowIso : prev.sinceUtc ?? nowIso,
        updatedAt: nowIso,
        source,
        sessionOk,
        sessionExpiresAt,
        note,
    };
}
function writeAwayState(state) {
    const tmp = `${AWAY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, AWAY_FILE);
}

async function awayWatchActive() {
    try {
        const { stdout } = await execFileP("gh", ["run", "list", "--repo", REPO, "--workflow", "away-watch.yml", "--limit", "3", "--json", "status"], { env: { ...process.env }, maxBuffer: 1024 * 1024 });
        const runs = JSON.parse(stdout || "[]");
        return runs.some((r) => r.status === "in_progress" || r.status === "queued");
    } catch (e) {
        log(`away-watch run check failed (${shortErr(e)}) — assuming inactive`);
        return false;
    }
}

const watchdog = setTimeout(() => {
    console.error(`${stamp()} WATCHDOG: job budget exceeded — exiting`);
    process.exit(0);
}, 8 * 60_000);
watchdog.unref?.();

async function main() {
    if (!USERNAME) {
        console.error("FATAL: EUFY_USERNAME is not set (Actions secret missing) — refusing to start");
        process.exit(1);
    }
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    } catch {
        console.error("AWAY-STATE SESSION: FAIL no stored session file — cannot run session-only check");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("AWAY-STATE SESSION: FAIL stored legacy token missing/expired — session-only check refused");
        process.exit(1);
    }
    const sessionExpiresAt = new Date(legacyExpiryMs).toISOString();
    log(`session gate ok: legacy token expires ${sessionExpiresAt}`);

    const { EufySecurity } = await import(VENDOR_ENTRY);
    const client = await EufySecurity.initialize({
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
    let challengeSeen = null;
    client.on("tfa request", () => {
        challengeSeen ??= "verify_code";
    });
    client.on("captcha request", () => {
        challengeSeen ??= "captcha";
    });
    await client.connect();
    if (challengeSeen) {
        const prev = readAwayState();
        writeAwayState(computeAwayState(prev, { armed: prev?.armed ?? false, sessionOk: false, sessionExpiresAt, note: `re-auth challenge (${challengeSeen}) — armed state unverified, last known preserved`, source: "away-state check" }));
        await syncData("away-state session failure");
        console.error(`AWAY-STATE SESSION: FAIL server requested re-authentication (${challengeSeen}) — session-only check aborted`);
        process.exit(3);
    }
    log("cloud connected (session-only)");

    let devices = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        devices = await client.getDevices().catch(() => []);
        if (devices.length > 0) break;
        await sleep(2_000);
    }
    const camera = devices.find((d) => d.getName() === CAMERA_NAME);
    if (!camera) {
        console.error(`FATAL: ${CAMERA_NAME} not in device list (${devices.map((d) => d.getName()).join(", ") || "none"})`);
        process.exit(1);
    }
    let enabled = null;
    try {
        const v = camera.isEnabled();
        enabled = v === true || v === 1 ? true : v === false || v === 0 ? false : null;
    } catch (e) {
        log(`isEnabled() threw (${shortErr(e)})`);
    }
    if (enabled === null) {
        console.error("FATAL: could not read the camera's enabled state — refusing to guess the away state");
        process.exit(1);
    }
    const armed = enabled;
    const prev = readAwayState();
    const state = computeAwayState(prev, { armed, sessionOk: true, sessionExpiresAt, source: "away-state check" });
    writeAwayState(state);
    await syncData(`away-state ${armed ? "ARMED" : "disarmed"} (check)`);
    log(`AWAY STATE: ${armed ? "ARMED" : "disarmed"} (camera enabled=${enabled}, since ${state.sinceUtc})`);

    if (armed) {
        if (await awayWatchActive()) {
            log("away-watch chain already active — no dispatch needed");
        } else {
            try {
                await execFileP("gh", ["workflow", "run", "away-watch.yml", "--repo", REPO], { env: { ...process.env }, maxBuffer: 1024 * 1024 });
                log("away-watch chain dispatched (armed, no active watch run)");
            } catch (e) {
                log(`away-watch dispatch FAILED (${shortErr(e)}) — the fast-lane dead-man's switch is the backstop`);
            }
        }
    }
    try {
        client.close();
    } catch {
        /* ignore */
    }
    console.log("AWAY-STATE DONE");
    process.exit(0);
}

main().catch((e) => {
    console.error(`FATAL: ${shortErr(e)}`);
    process.exit(1);
});
