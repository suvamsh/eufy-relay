/**
 * exp-push.mjs — push-delivery experiment listener (Oct 15, 2026 deep dive).
 *
 * A stripped, instrumented twin of app/listener.mjs: restores the stored
 * guest session exactly like production (session-only, no password),
 * registers FCM push on connect, and logs EVERY hop the production
 * listener cannot see:
 *   - the three account-binding calls made on every MCS socket connect
 *     (legacy registerPushToken, legacy checkPushToken, mega
 *     registerMegaPushToken) WITH their boolean results, captured by
 *     wrapping the vendored client's methods before connect;
 *   - every "push connect" / "push close" event, with the registration
 *     results that gated it;
 *   - every push message received (type/content/device/stamp/path);
 *   - the 20-minute production re-register cycle, replicated verbatim
 *     (close push service, 3 s, reopen), with the new binding results.
 * No bundles, no git, no data-repo writes: stdout + a JSONL file that the
 * workflow uploads as an artifact.
 *
 * Env: EXP_LABEL (A/B), EXP_MINUTES, EUFY_USERNAME. Session materialized
 * by the workflow (app/persistent-data/persistent.json via
 * session-restore.mjs), same as listener.yml.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");

const LABEL = process.env.EXP_LABEL || "A";
const EXP_MINUTES = Math.max(5, Number(process.env.EXP_MINUTES || 60) || 60);
const REREGISTER_MS = 20 * 60_000;
const OUT_FILE = path.join(ROOT, `exp-log-${LABEL}.jsonl`);

const t0 = Date.now();
const elapsed = () => Number(((Date.now() - t0) / 1000).toFixed(1));
function record(kind, data = {}) {
    const row = { t: new Date().toISOString(), elapsedS: elapsed(), label: LABEL, kind, ...data };
    console.log(`EXP[${LABEL}] ${JSON.stringify(row)}`);
    try {
        fs.appendFileSync(OUT_FILE, JSON.stringify(row) + "\n");
    } catch {
        /* stdout is the primary record */
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 200);

let pushesReceived = 0;
const regResults = []; // {at, fn, result} across the whole run

async function main() {
    // session gate — mirror listener.mjs: refuse unless a stored legacy
    // token exists and is unexpired.
    const stored = JSON.parse(fs.readFileSync(path.join(PERSISTENT_DIR, "persistent.json"), "utf8"));
    const expMs = stored.cloud_token_expiration ? new Date(stored.cloud_token_expiration).getTime() : null;
    record("boot", { legacyExpiresAt: stored.cloud_token_expiration ?? null, megaExpiryNote: "see session-state", expMinutes: EXP_MINUTES });
    if (!stored.cloud_token || !expMs || expMs <= Date.now() + 60_000) {
        record("session-fail", { why: "stored legacy token missing/expired" });
        process.exit(1);
    }

    const { EufySecurity } = await import(VENDOR_ENTRY);
    const client = await EufySecurity.initialize({
        username: process.env.EUFY_USERNAME,
        password: "",
        country: "US",
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

    // ---- instrumentation: wrap the three binding calls BEFORE connect --
    const wrap = (obj, fn) => {
        if (!obj || typeof obj[fn] !== "function") {
            record("wrap-missing", { fn });
            return;
        }
        const orig = obj[fn].bind(obj);
        obj[fn] = async (...args) => {
            const started = Date.now();
            try {
                const result = await orig(...args);
                regResults.push({ elapsedS: elapsed(), fn, result: Boolean(result) });
                record("register", { fn, result: Boolean(result), ms: Date.now() - started });
                return result;
            } catch (e) {
                regResults.push({ elapsedS: elapsed(), fn, result: false, error: shortErr(e) });
                record("register", { fn, result: false, error: shortErr(e), ms: Date.now() - started });
                throw e;
            }
        };
    };
    wrap(client.api, "registerPushToken");
    wrap(client.api, "checkPushToken");
    if (client.megaTransition) wrap(client.megaTransition, "registerMegaPushToken");
    else record("wrap-missing", { fn: "megaTransition (no property)" });

    client.on("push connect", () => record("push-connect", { socketConnected: safeIsConnected(client) }));
    client.on("push close", () => record("push-close", {}));
    client.on("push message", (m) => {
        pushesReceived++;
        record("push", {
            n: pushesReceived,
            type: m?.type ?? null,
            content: m?.content ?? null,
            deviceSnLast4: m?.device_sn ? String(m.device_sn).slice(-4) : null,
            stationSnLast4: m?.station_sn ? String(m.station_sn).slice(-4) : null,
            eventTime: m?.event_time ?? null,
            hasPath: Boolean(m?.file_path),
            eventType: m?.event_type ?? null,
        });
    });
    client.on("tfa request", () => record("challenge", { kind: "verify_code" }));
    client.on("captcha request", () => record("challenge", { kind: "captcha" }));

    await client.connect();
    record("cloud-connected", {});
    await sleep(15_000);
    record("settled", { socketConnected: safeIsConnected(client), pushesReceived });

    // ---- production-identical 20-min re-register cycle ------------------
    const deadline = t0 + EXP_MINUTES * 60_000;
    let lastReregister = Date.now();
    while (Date.now() < deadline) {
        await sleep(30_000);
        record("status", { socketConnected: safeIsConnected(client), pushesReceived, registrations: regResults.length });
        if (Date.now() - lastReregister >= REREGISTER_MS) {
            lastReregister = Date.now();
            await reregister(client);
        }
    }
    record("done", { pushesReceived, registrations: regResults });
    try {
        client.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

function safeIsConnected(client) {
    try {
        return Boolean(client.isPushConnected());
    } catch {
        return null;
    }
}

async function reregister(client) {
    try {
        const ps = client?.getPushService?.();
        if (!ps) {
            record("reregister", { ok: false, why: "no push service" });
            return;
        }
        record("reregister", { phase: "closing" });
        try {
            ps.close();
        } catch {
            /* ignore */
        }
        await sleep(3_000);
        await ps.open();
        const deadline = Date.now() + 45_000;
        let ok = false;
        while (Date.now() < deadline) {
            if (safeIsConnected(client)) {
                ok = true;
                break;
            }
            await sleep(2_000);
        }
        record("reregister", { phase: "done", ok, recentResults: regResults.slice(-3) });
    } catch (e) {
        record("reregister", { ok: false, error: shortErr(e) });
    }
}

main().catch((e) => {
    record("fatal", { error: shortErr(e) });
    process.exit(1);
});
