#!/usr/bin/env node
/**
 * probe-latest-info.mjs — controlled experiment for the SoloCam
 * "dark camera" failures (Oct 14-15, 2026): all three battery SoloCams
 * intermittently stop answering databaseQueryLatestInfo (P2P command
 * 10013) for hours in the evening while P2P connect, livestream,
 * image downloads and push all keep working.
 *
 * One run targets ONE station (env PROBE_TARGET) and walks a recipe
 * ladder against it, logging precise send/answer timings for every
 * attempt so the transcript shows WHICH ingredient (if any) wakes the
 * camera's database service:
 *
 *   0. connect (the vendored client auto-sends one latest-info query
 *      on connect — every response is timestamped, solicited or not)
 *   1. baseline   — latest-info exactly as the sweep asks (45 s)
 *   2. wait       — idle 60 s on the same connection, then ask (45 s)
 *   3. count      — databaseCountByDate for today, then ask (45 s)
 *   4. stream     — ~6 s livestream start/stop, then ask (45 s)
 *   5. retry      — ask every ~25 s, up to 6 times (20 s timeout each)
 *   6. reconnect  — close, 20 s settle, reconnect, ask (45 s)
 *   7. control    — downloadImage of a known snapshot path (Porch only,
 *      env PROBE_CONTROL_PATH): does the image path answer while the
 *      database path stays silent?
 *
 * Device metadata logged: battery / power / wifi related properties
 * only (names + values; never serials, never session material).
 *
 * Safety: EUFY_NO_PUSH=1 is set by the workflow (this probe must never
 * register push — the listener is the fleet's only registrant). The
 * session is restored by app/session-restore.mjs in the workflow,
 * exactly like production. Nothing is written to the data repo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const TARGET = process.env.PROBE_TARGET || "";
const CONTROL_PATH = process.env.PROBE_CONTROL_PATH || "";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_DIR = path.join(ROOT, "vendor", "eufy-security-client");
const VENDOR_ENTRY = path.join(VENDOR_DIR, "build", "index.js");

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
const results = {};
const note = (k, v) => {
    results[k] = v;
    log(`RESULT ${k} = ${v}`);
};

let client = null;

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

function ensureP2PConnected(station, timeoutMs = 90_000) {
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
        const onError = (_s, err) => {
            lastError = err instanceof Error ? err.message : String(err);
        };
        const deadline = setTimeout(() => finish(station.isConnected(), lastError ?? "no P2P connection within timeout"), timeoutMs);
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

// one outstanding latest-info ask at a time, mirroring sweep.mjs semantics
function makeAsker(station, stationSerial) {
    let pending = null;
    let responseCount = 0;
    client.on("station database query latest", (st, returnCode, data) => {
        if (st?.getSerial?.() !== stationSerial) return;
        responseCount++;
        log(`  [event] latest-info response #${responseCount} rc=${returnCode} devices=${Array.isArray(data) ? data.length : "?"} at ${stamp()}${pending ? "" : " (no ask outstanding — e.g. the connect-time auto-query)"}`);
        if (pending) {
            const p = pending;
            pending = null;
            clearTimeout(p.timer);
            if (returnCode !== 0) p.resolve({ ok: false, reason: `rc=${returnCode}` });
            else p.resolve({ ok: true, data });
        }
    });
    return {
        ask(timeoutMs) {
            if (pending) return Promise.resolve({ ok: false, reason: "ask already outstanding" });
            const sentAt = Date.now();
            const p = new Promise((resolve) => {
                const timer = setTimeout(() => {
                    pending = null;
                    resolve({ ok: false, reason: `timeout after ${timeoutMs}ms` });
                }, timeoutMs);
                pending = { resolve, timer };
            });
            try {
                station.databaseQueryLatestInfo();
            } catch (e) {
                if (pending) {
                    clearTimeout(pending.timer);
                    pending = null;
                }
                return Promise.resolve({ ok: false, reason: `send threw: ${shortErr(e)}` });
            }
            return p.then((r) => ({ ...r, latencyMs: Date.now() - sentAt }));
        },
    };
}

async function main() {
    if (!USERNAME) throw new Error("EUFY_USERNAME not set");
    if (!TARGET) throw new Error("PROBE_TARGET not set");
    const stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    const expMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || expMs === null || expMs <= Date.now() + 60_000) throw new Error("stored session missing/expired — probe refused");
    log(`session gate ok; target=${TARGET}`);

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
    await client.connect();
    log("cloud connected");

    let stations = [];
    let devices = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        stations = await client.getStations();
        devices = await client.getDevices();
        if (stations.length && devices.length) break;
        await sleep(2_000);
    }
    const station = stations.find((s) => s.getName() === TARGET);
    if (!station) throw new Error(`station ${TARGET} not found`);
    const device = devices.find((d) => d.getStationSerial() === station.getSerial());
    log(`station found; device=${device?.getName() ?? "?"} model=${device?.getModel() ?? "?"}`);

    // metadata: battery / power / wifi properties only
    try {
        const props = device?.getProperties?.() ?? {};
        for (const [k, v] of Object.entries(props)) {
            if (/batt|power|charge|solar|wifi|rssi|signal|temp/i.test(k)) {
                const val = v && typeof v === "object" ? (v.value ?? JSON.stringify(v).slice(0, 60)) : v;
                log(`  prop ${k} = ${String(val).slice(0, 60)}`);
            }
        }
    } catch (e) {
        log(`  props unavailable: ${shortErr(e)}`);
    }
    try {
        log(`  device enabled=${device?.isEnabled?.()}`);
    } catch {
        /* ignore */
    }

    const asker = makeAsker(station, station.getSerial());

    // ---- connect ------------------------------------------------------------
    const conn = await ensureP2PConnected(station);
    if (!conn.connected) {
        note("connect", `FAIL ${conn.error ?? ""}`);
        return;
    }
    note("connect", "ok");
    const connectedAt = Date.now();

    // ---- 1. baseline ---------------------------------------------------------
    let r = await asker.ask(45_000);
    note("baseline", r.ok ? `ANSWER latency=${r.latencyMs}ms devices=${r.data?.length}` : `FAIL ${r.reason}`);
    if (r.ok) {
        log(`baseline answered ${((Date.now() - connectedAt) / 1000).toFixed(1)}s after connect`);
        return;
    }

    // ---- 2. wait 60 s, ask again ---------------------------------------------
    log("recipe wait: idling 60s on the same connection…");
    await sleep(60_000);
    r = await asker.ask(45_000);
    note("wait60", r.ok ? `ANSWER latency=${r.latencyMs}ms` : `FAIL ${r.reason}`);
    if (r.ok) return;

    // ---- 3. count-by-date first ----------------------------------------------
    const countResp = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                resolve({ ok: false, reason: "timeout after 45000ms" });
            }
        }, 45_000);
        const sentAt = Date.now();
        client.on("station database count by date", function onCount(st, rc, data) {
            if (st?.getSerial?.() !== station.getSerial()) return;
            client.off("station database count by date", onCount);
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ ok: rc === 0, reason: `rc=${rc}`, latencyMs: Date.now() - sentAt, data });
        });
        try {
            const now = new Date();
            station.databaseCountByDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()), now);
        } catch (e) {
            clearTimeout(timer);
            resolve({ ok: false, reason: `send threw: ${shortErr(e)}` });
        }
    });
    note("countByDate", countResp.ok ? `ANSWER latency=${countResp.latencyMs}ms rows=${Array.isArray(countResp.data) ? countResp.data.length : "?"}` : `FAIL ${countResp.reason}`);
    r = await asker.ask(45_000);
    note("afterCount", r.ok ? `ANSWER latency=${r.latencyMs}ms` : `FAIL ${r.reason}`);
    if (r.ok) return;

    // ---- 4. livestream wake ----------------------------------------------------
    const deviceSN = device?.getSerial?.();
    let streamBytes = 0;
    let streamStarted = false;
    if (deviceSN) {
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try {
                    client.stopStationLivestream(deviceSN).catch(() => {});
                } catch {
                    /* ignore */
                }
                resolve();
            };
            const onStart = (st, dev, _meta, videoStream, audioStream) => {
                if (st?.getSerial?.() !== station.getSerial() || dev?.getSerial?.() !== deviceSN) {
                    videoStream?.resume?.();
                    audioStream?.resume?.();
                    return;
                }
                streamStarted = true;
                videoStream?.on("data", (c) => {
                    streamBytes += c.length;
                });
                videoStream?.on("error", () => {});
                audioStream?.resume?.();
                setTimeout(finish, 6_000);
            };
            client.on("station livestream start", onStart);
            setTimeout(() => {
                client.off("station livestream start", onStart);
                finish();
            }, 30_000);
            Promise.resolve()
                .then(() => client.startStationLivestream(deviceSN))
                .catch((e) => log(`  livestream start threw: ${shortErr(e)}`));
        });
    }
    note("livestream", streamStarted ? `STARTED bytes=${streamBytes}` : "NO START in 30s");
    await sleep(3_000);
    r = await asker.ask(45_000);
    note("afterStream", r.ok ? `ANSWER latency=${r.latencyMs}ms` : `FAIL ${r.reason}`);
    if (r.ok) return;

    // ---- 5. persistent retries --------------------------------------------------
    for (let i = 1; i <= 6; i++) {
        r = await asker.ask(20_000);
        note(`retry${i}`, r.ok ? `ANSWER latency=${r.latencyMs}ms` : `FAIL ${r.reason}`);
        if (r.ok) return;
        await sleep(5_000);
    }

    // ---- 6. reconnect -------------------------------------------------------------
    try {
        station.close?.();
    } catch {
        /* ignore */
    }
    await sleep(20_000);
    const conn2 = await ensureP2PConnected(station);
    note("reconnect", conn2.connected ? "ok" : `FAIL ${conn2.error ?? ""}`);
    if (conn2.connected) {
        r = await asker.ask(45_000);
        note("afterReconnect", r.ok ? `ANSWER latency=${r.latencyMs}ms` : `FAIL ${r.reason}`);
        if (r.ok) return;
    }

    // ---- 7. control: image download ----------------------------------------------
    if (CONTROL_PATH) {
        const img = await new Promise((resolve) => {
            let done = false;
            const sentAt = Date.now();
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve({ ok: false, reason: "timeout after 30000ms" });
                }
            }, 30_000);
            const onImg = (st, file, image) => {
                if (st?.getSerial?.() !== station.getSerial() || file !== CONTROL_PATH) return;
                if (done) return;
                done = true;
                clearTimeout(timer);
                client.off("station image download", onImg);
                const len = image?.length ?? image?.data?.length ?? 0;
                resolve({ ok: len > 0, reason: `bytes=${len}`, latencyMs: Date.now() - sentAt });
            };
            client.on("station image download", onImg);
            try {
                station.downloadImage(CONTROL_PATH);
            } catch (e) {
                clearTimeout(timer);
                resolve({ ok: false, reason: `send threw: ${shortErr(e)}` });
            }
        });
        note("controlImage", img.ok ? `ANSWER latency=${img.latencyMs}ms ${img.reason}` : `FAIL ${img.reason}`);
    }

    log(`SUMMARY target=${TARGET} ${JSON.stringify(results)}`);
}

main()
    .catch((e) => {
        console.error(`FATAL: ${shortErr(e)}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await client?.close();
        } catch {
            /* ignore */
        }
        setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
    });
