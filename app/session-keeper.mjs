#!/usr/bin/env node
/**
 * session-keeper.mjs — the fleet's session writer (Session permanence,
 * Oct 13, 2026; design + mechanics in RELAY-BUILD.md "Session permanence").
 *
 * Why this exists: Eufy issues both session tokens at login with a
 * server-set ~30-day expiry and offers NO refresh flow (the vendored
 * client's only "renewal" is a forced password re-login). Nothing
 * rotates on its own, so permanence = a designated writer that renews
 * by real login BEFORE expiry and keeps the canonical copy in the
 * private data repo (session/persistent.json), where every fleet job
 * already restores from (session-restore.mjs). The Actions secret
 * EUFY_PERSISTENT_JSON stays forever as the bootstrap/fallback.
 *
 * Single-writer discipline: ONLY this job ever writes session/ in the
 * data repo or performs a login. Every other job is a read-only
 * consumer. A renewed copy is persisted ONLY after it has been
 * shape-validated AND proven online; the previous canonical copy is
 * kept as session/persistent.prev.json (last-good) so a bad write can
 * never brick the fleet — consumers fall back data-repo -> prev is not
 * automatic, but GG can restore it with one git command, and the
 * Actions secret remains as the third line of defense.
 *
 * Modes (env SESSION_KEEPER_MODE):
 *   auto (default)  verify the best copy online; renew by login when
 *                   it is expired, expiring (<72h), or fails online
 *                   verification — if the password secret exists.
 *   prove           restore-from-data-repo ONLY (secret copy ignored)
 *                   + online verify; never logs in, never writes.
 *                   Prints SESSION KEEPER: PROVE OK / FAIL.
 *   force-login     perform a login now (proof of the renewal path;
 *                   requires the password secret).
 *
 * Credential rules: the guest password is read ONLY from
 * process.env.EUFY_GUEST_PASSWORD of this run (an Actions secret set
 * once by Suvamsh). It is never logged, never written, never taken
 * from argv. If Eufy answers a renewal login with a 2FA/captcha
 * challenge, the keeper prints SESSION KEEPER: CHALLENGE <kind> and
 * exits 4 WITHOUT persisting anything — the human-assist path (the
 * blocker ping's domain) owns that case, exactly as before.
 *
 * Exit codes: 0 healthy/refreshed · 3 renewal needed but no password
 * secret · 4 challenge during renewal login · 5 prove-mode failure ·
 * 1 other failure.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseSessionCopy, classifySession, chooseSessionSource, isoOrNull } from "./session-lib.mjs";

const execFileP = promisify(execFile);
const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const SCRATCH_DIR = path.join(HERE, "persistent-data-keeper");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");
const DATA_DIR = process.env.RELAY_DATA_DIR || path.resolve(ROOT, "data");
const SESSION_DIR = path.join(DATA_DIR, "session");
const CANONICAL_FILE = path.join(SESSION_DIR, "persistent.json");
const PREV_FILE = path.join(SESSION_DIR, "persistent.prev.json");
const STATE_FILE = path.join(SESSION_DIR, "session-state.json");
const MODE = (process.env.SESSION_KEEPER_MODE || "auto").toLowerCase();

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => String(e?.message ?? e).slice(0, 200);

const watchdog = setTimeout(() => {
    console.error("SESSION KEEPER: FAIL watchdog timeout (12 min)");
    process.exit(1);
}, 12 * 60_000);
watchdog.unref?.();

function readIfExists(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
}

function writeFileAtomic(file, text, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// git plumbing (mirror listener.mjs: serialized, merge-based sync)
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
async function syncSessionDir(message) {
    const status = await git(["status", "--porcelain", "--", "session/"], { quiet: true }).catch(() => "");
    if (status) {
        await git(["add", "--", "session/"]);
        await git(["commit", "-m", message, "--", "session/"]);
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
    return false;
}

function writeSessionState(source, shape) {
    const state = {
        kind: "eufy-session-state",
        version: 1,
        updatedAt: new Date().toISOString(),
        source, // "keeper-seed" | "keeper-login"
        legacyExpiresAt: isoOrNull(shape.legacyExpiryMs),
        megaExpiresAt: isoOrNull(shape.megaExpiryMs),
        sessionOk: true,
    };
    writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n", 0o644);
}

/** Persist a validated copy as the canonical one (prev kept as last-good). */
async function persistCanonical(text, shape, source) {
    const existing = readIfExists(CANONICAL_FILE);
    if (existing && existing !== text) writeFileAtomic(PREV_FILE, existing);
    writeFileAtomic(CANONICAL_FILE, text);
    writeSessionState(source, shape);
    const ok = await syncSessionDir(`session keeper: ${source} ${new Date().toISOString()}`);
    if (!ok) throw new Error("could not push the renewed session copy to the data repo after retries");
}

// ---------------------------------------------------------------------------
// client helpers
// ---------------------------------------------------------------------------
async function makeClient({ password, persistentDir }) {
    const { EufySecurity } = await import(VENDOR_ENTRY);
    const client = await EufySecurity.initialize({
        username: USERNAME,
        password,
        country: COUNTRY,
        language: "en",
        trustedDeviceName: "gg-watcher",
        persistentDir,
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
    return client;
}

/**
 * Connect a client and report the outcome without ever hanging:
 * { connected:true, devices } | { connected:false, challenge } |
 * { connected:false, error }.
 */
async function tryConnect(client, timeoutMs = 120_000) {
    let challenge = null;
    let connError = null;
    let connected = false;
    client.on("tfa request", () => (challenge ??= "verify_code"));
    client.on("captcha request", () => (challenge ??= "captcha"));
    client.on("connection error", (e) => (connError ??= e));
    client.on("connect", () => (connected = true));
    const deadline = Date.now() + timeoutMs;
    try {
        await client.connect();
    } catch (e) {
        connError ??= e;
    }
    while (!connected && !challenge && !connError && Date.now() < deadline) await sleep(500);
    if (!connected) return { connected: false, challenge, error: connError };
    let devices = 0;
    const devDeadline = Date.now() + 30_000;
    while (Date.now() < devDeadline) {
        const list = await client.getDevices().catch(() => []);
        if (list.length > 0) {
            devices = list.length;
            break;
        }
        await sleep(2_000);
    }
    return { connected: true, devices };
}

/** Session-only online verification of the copy in the working file. */
async function verifyWorkingCopy() {
    const client = await makeClient({ password: "", persistentDir: PERSISTENT_DIR });
    try {
        return await tryConnect(client);
    } finally {
        try {
            client.close();
        } catch {
            /* ignore */
        }
    }
}

/**
 * Seed transform for a renewal login: drop BOTH stored sessions from
 * the scratch seed so the client performs GENUINE logins on both
 * backends instead of reusing whichever half happens to still be valid.
 *
 * Why (found Oct 15, 2026): both client halves skip re-login while
 * their stored session looks valid, each behind a different gate —
 * MegaTransition.loginMega() early-returns "ok" when
 * MegaHTTPApi.hasValidSession() is true (no mega.login(), no session
 * re-export), and HTTPApi.login() skips its password POST while its
 * token is present and unexpired. A keeper "renewal" therefore renews
 * only the half whose gate happens to trip: the first armed
 * force-login (run 38783559217) renewed legacy only — its token had
 * been invalidated by the load-time login_hash gate after drifting
 * through password-less fleet writes — and carried mega over
 * byte-identical (still expiring 2026-11-11, mid Hawaii trip, a lapse
 * classifySession counts as "expired" for the WHOLE copy: the restore
 * gate would reject it despite a valid legacy token). Stripping mega
 * alone then renewed mega only, because the first run had rewritten
 * login_hash from the keeper's own password config, so the legacy gate
 * no longer tripped (run 38784104881, caught by the renew() guard).
 * Deleting `megaApi` + the legacy `cloud_token` /
 * `cloud_token_expiration` / `httpApi` keys from the SCRATCH seed only
 * (the canonical copy is never touched) leaves no reusable session on
 * either backend: loginMega() runs estimateDomain + keyExchange +
 * mega.login(), HTTPApi performs its login POST, and both tokens come
 * back fresh ~30-day issues, exported into the scratch persistent.json.
 * Identity fields (openudid, login_hash, serial_number, country) stay,
 * so Eufy still sees the same known device. If either login draws a
 * 2FA/captcha challenge, the existing challenge path persists nothing —
 * the fleet keeps the previous canonical copy.
 */
function stripStoredSessions(seedText) {
    try {
        const obj = JSON.parse(seedText);
        if (obj && typeof obj === "object") {
            delete obj.megaApi;
            delete obj.cloud_token;
            delete obj.cloud_token_expiration;
            delete obj.httpApi;
            return JSON.stringify(obj);
        }
    } catch {
        /* unparseable seed: return it untouched; shape validation downstream decides */
    }
    return seedText;
}

/**
 * Full renewal login in a scratch persistent dir seeded with the best
 * existing copy (carrying the client identity — openudid, keys — so
 * Eufy sees the same "device" it already knows), with both stored
 * sessions stripped (see stripStoredSessions) so BOTH tokens are
 * genuinely re-issued. On success the scratch persistent.json is a
 * fresh validated copy; on challenge or failure NOTHING is persisted
 * anywhere.
 */
async function renewalLogin(seedText) {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    try {
        fs.chmodSync(SCRATCH_DIR, 0o700);
    } catch {
        /* best effort */
    }
    if (seedText) writeFileAtomic(path.join(SCRATCH_DIR, "persistent.json"), stripStoredSessions(seedText));

    const password = process.env.EUFY_GUEST_PASSWORD;
    const client = await makeClient({ password, persistentDir: SCRATCH_DIR });
    let result;
    try {
        result = await tryConnect(client, 180_000);
    } finally {
        try {
            client.close();
        } catch {
            /* ignore */
        }
    }
    if (!result.connected) {
        fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
        return result;
    }
    const freshText = readIfExists(path.join(SCRATCH_DIR, "persistent.json"));
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
    if (!freshText) return { connected: false, error: new Error("login connected but the client wrote no session file") };
    const { shape } = parseSessionCopy(freshText);
    if (!shape.ok) return { connected: false, error: new Error(`fresh session failed shape validation: ${shape.problems.join("; ")}`) };
    return { connected: true, devices: result.devices, freshText, shape };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    if (!USERNAME) {
        console.error("SESSION KEEPER: FAIL EUFY_USERNAME is not set (Actions secret missing)");
        process.exit(1);
    }
    const canonicalText = readIfExists(CANONICAL_FILE);
    const bootstrapText = readIfExists(PERSISTENT_FILE);
    log(`mode=${MODE} canonicalCopy=${canonicalText ? "present" : "absent"} bootstrapCopy=${bootstrapText ? "present" : "absent"}`);

    // ---- PROVE: data-repo copy alone must restore + verify online --------
    if (MODE === "prove") {
        const { shape } = parseSessionCopy(canonicalText ?? "");
        const classification = classifySession(shape);
        if (!canonicalText || classification === "invalid" || classification === "expired") {
            console.error(`SESSION KEEPER: PROVE FAIL data-repo copy is ${!canonicalText ? "absent" : classification}`);
            process.exit(5);
        }
        writeFileAtomic(PERSISTENT_FILE, canonicalText);
        const res = await verifyWorkingCopy();
        if (!res.connected) {
            console.error(`SESSION KEEPER: PROVE FAIL online verify did not connect (${res.challenge ? `challenge ${res.challenge}` : shortErr(res.error)})`);
            process.exit(5);
        }
        console.log(
            `SESSION KEEPER: PROVE OK restored from data-repo copy only (secret unused), devices=${res.devices}, ` +
                `legacyExpires=${isoOrNull(shape.legacyExpiryMs)} megaExpires=${isoOrNull(shape.megaExpiryMs)}`,
        );
        process.exit(0);
    }

    const candidates = [
        { source: "data-repo", text: canonicalText },
        { source: "actions-secret", text: bootstrapText },
    ];
    const pick = MODE === "force-login" ? null : chooseSessionSource(candidates);

    // ---- RENEWAL path -----------------------------------------------------
    async function renew(reason) {
        if (!process.env.EUFY_GUEST_PASSWORD) {
            console.error(`SESSION KEEPER: FAIL renewal needed (${reason}) but EUFY_GUEST_PASSWORD is not set — the blocker flow owns this`);
            process.exit(3);
        }
        log(`renewing by full login (${reason})`);
        const seed = pick?.text ?? canonicalText ?? bootstrapText;
        const res = await renewalLogin(seed);
        if (!res.connected) {
            if (res.challenge) {
                console.error(`SESSION KEEPER: CHALLENGE ${res.challenge} — renewal login requires a human; nothing persisted`);
                process.exit(4);
            }
            console.error(`SESSION KEEPER: FAIL renewal login did not connect: ${shortErr(res.error)}`);
            process.exit(1);
        }
        const classification = classifySession(res.shape);
        if (classification !== "usable") {
            console.error(`SESSION KEEPER: FAIL fresh login produced a ${classification} session — refusing to persist it`);
            process.exit(1);
        }
        // Regression guard (Oct 15, 2026): a renewal that leaves either
        // token's expiry at/behind the seed's is not a renewal — refuse
        // to persist it, so a silent half-renewal (the mega-skip bug)
        // can never become the canonical copy unnoticed.
        if (seed) {
            const { shape: seedShape } = parseSessionCopy(seed);
            if (seedShape.ok) {
                const stale = [];
                if (res.shape.legacyExpiryMs <= seedShape.legacyExpiryMs) stale.push("legacy");
                if (res.shape.megaExpiryMs <= seedShape.megaExpiryMs) stale.push("mega");
                if (stale.length > 0) {
                    console.error(
                        `SESSION KEEPER: FAIL renewal did not advance ${stale.join(" + ")} expiry — refusing to persist a half-renewed session`,
                    );
                    process.exit(1);
                }
            }
        }
        writeFileAtomic(PERSISTENT_FILE, res.freshText);
        await persistCanonical(res.freshText, res.shape, "keeper-login");
        console.log(
            `SESSION KEEPER: REFRESHED devices=${res.devices} legacyExpires=${isoOrNull(res.shape.legacyExpiryMs)} ` +
                `megaExpires=${isoOrNull(res.shape.megaExpiryMs)} (canonical copy persisted to the data repo)`,
        );
        process.exit(0);
    }

    if (MODE === "force-login") await renew("forced by dispatch");

    if (!pick) await renew("no usable session copy anywhere");

    // Candidate exists: install it as the working copy and verify online.
    writeFileAtomic(PERSISTENT_FILE, pick.text);
    const res = await verifyWorkingCopy();
    if (!res.connected) {
        await renew(`online verify failed (${res.challenge ? `challenge ${res.challenge}` : shortErr(res.error)})`);
    }
    if (pick.classification === "expiring") {
        if (process.env.EUFY_GUEST_PASSWORD) {
            await renew("inside the 72h renew margin (proactive)");
        }
        console.log(
            `SESSION KEEPER: OK source=${pick.source} (expiring — renewal deferred, no password secret) devices=${res.devices} ` +
                `legacyExpires=${isoOrNull(pick.shape.legacyExpiryMs)} megaExpires=${isoOrNull(pick.shape.megaExpiryMs)}`,
        );
        process.exit(0);
    }
    // Healthy. Seed the canonical copy if we won on the bootstrap secret.
    if (pick.source === "actions-secret") {
        await persistCanonical(pick.text, pick.shape, "keeper-seed");
        log("canonical copy seeded into the data repo from the bootstrap secret copy");
    }
    console.log(
        `SESSION KEEPER: OK source=${pick.source} devices=${res.devices} ` +
            `legacyExpires=${isoOrNull(pick.shape.legacyExpiryMs)} megaExpires=${isoOrNull(pick.shape.megaExpiryMs)}`,
    );
    process.exit(0);
}

main().catch((e) => {
    console.error(`SESSION KEEPER: FAIL ${shortErr(e)}`);
    process.exit(1);
});
