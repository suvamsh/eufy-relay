#!/usr/bin/env node
/**
 * diag2.mjs — TEMPORARY diagnostic #2 for the relay.
 *
 * Established (sweeps 38322895407 / 38324139181 + diag 38324474756 +
 * upstream bropat issue #963 on the same client version): on current
 * firmware, databaseQueryByDate never answers and databaseQueryLocal
 * answers rc=0 with zero records, while databaseCountByDate and
 * databaseQueryLatestInfo DO answer. Issue #963 also reports
 * station.downloadImage works on a latest-info crop path.
 *
 * This script verifies, on WifiBridge + Porch:
 *   D1 latest-info values: event_count + crop_local_path per device
 *   D2 downloadImage(crop_local_path): bytes received? image magic?
 *   D3 startDownload with the snapshot's sibling .mp4 path (one guess):
 *      does any download start/finish/data arrive within 25 s?
 * Logs contain no serials (last 4 only) and no session material.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.EUFY_USERNAME || "";
const COUNTRY = "US";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const VENDOR_ENTRY = path.join(ROOT, "vendor", "eufy-security-client", "build", "index.js");
const TARGETS = ["WifiBridge", "Porch"];

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last4 = (s) => {
    const v = String(s ?? "");
    return v.length > 4 ? `****${v.slice(-4)}` : "****";
};
const shortErr = (e) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

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
        const onError = (_st, err) => {
            lastError = err instanceof Error ? err.message : String(err);
        };
        const deadline = setTimeout(() => finish(station.isConnected(), lastError ?? "timeout"), timeoutMs);
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

let client = null;

async function main() {
    if (!USERNAME) {
        console.error("FATAL: EUFY_USERNAME not set");
        process.exit(1);
    }
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(PERSISTENT_FILE, "utf8"));
    } catch {
        console.error("FATAL: no stored session file");
        process.exit(1);
    }
    const legacyExpiryMs = expiryToMs(stored.cloud_token_expiration);
    if (!stored.cloud_token || legacyExpiryMs === null || legacyExpiryMs <= Date.now() + 60_000) {
        console.error("FATAL: stored legacy token missing/expired");
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
        logging: { level: 4 },
    });
    try {
        client.setLoggingLevel?.("all", 4);
    } catch {
        /* ignore */
    }
    client.on("tfa request", () => {
        challengeSeen ??= "verify_code";
    });
    client.on("captcha request", () => {
        challengeSeen ??= "captcha";
    });
    await client.connect();
    if (challengeSeen) {
        console.error(`FATAL: re-auth requested (${challengeSeen})`);
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
    const deviceBySerial = new Map(devices.map((d) => [d.getSerial(), d]));

    for (const name of TARGETS) {
        const station = stations.find((s) => s.getName() === name);
        if (!station) {
            log(`DIAG2 ${name}: station not found`);
            continue;
        }
        const serial = station.getSerial();
        const conn = await ensureP2PConnected(station);
        if (!conn.connected) {
            log(`DIAG2 ${name}: P2P connect FAILED (${conn.error})`);
            continue;
        }
        log(`DIAG2 ${name}: P2P connected`);

        // ---- D1: latest-info values --------------------------------------
        const latest = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                client.off("station database query latest", handler);
                resolve(null);
            }, 30_000);
            const handler = (st, rc, data) => {
                if (st?.getSerial?.() !== serial) return;
                clearTimeout(timer);
                client.off("station database query latest", handler);
                resolve({ rc, data });
            };
            client.on("station database query latest", handler);
            try {
                station.databaseQueryLatestInfo();
            } catch (e) {
                clearTimeout(timer);
                client.off("station database query latest", handler);
                resolve({ error: shortErr(e) });
            }
        });
        if (!latest || latest.error || !Array.isArray(latest.data)) {
            log(`DIAG2 ${name}: D1 latest-info FAILED (${latest?.error ?? "no response in 30s"})`);
            try {
                station.close?.();
            } catch {
                /* ignore */
            }
            continue;
        }
        for (const entry of latest.data) {
            const dev = deviceBySerial.get(entry.device_sn);
            const cropPath = entry.crop_local_path || entry.crop_cloud_path || null;
            log(
                `DIAG2 ${name}: D1 device=${dev?.getName() ?? last4(entry.device_sn)} event_count=${entry.event_count} ` +
                    `crop_${entry.crop_local_path ? "local" : "cloud"}_path=${cropPath}`,
            );
            if (!cropPath) continue;

            // ---- D2: downloadImage(crop path) ------------------------------
            try {
                const image = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        client.off("station image download", handler);
                        reject(new Error("timeout 30s"));
                    }, 30_000);
                    const handler = (st, file, img) => {
                        if (file !== cropPath) return;
                        clearTimeout(timer);
                        client.off("station image download", handler);
                        resolve(img);
                    };
                    client.on("station image download", handler);
                    station.downloadImage(cropPath);
                });
                const buf = Buffer.isBuffer(image) ? image : image?.data ? Buffer.from(image.data) : null;
                const magic = buf && buf.length >= 3 ? `ff d8 ff=${buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff}` : "n/a";
                log(`DIAG2 ${name}: D2 downloadImage OK bytes=${buf?.length ?? 0} jpegMagic=${magic} type=${image?.type?.mime ?? "-"}/${image?.type?.ext ?? "-"}`);
            } catch (e) {
                log(`DIAG2 ${name}: D2 downloadImage FAILED (${shortErr(e)})`);
            }

            // ---- D3: startDownload sibling .mp4 guess ----------------------
            const deviceObj = dev;
            if (deviceObj && /_snapshot\.jpg$/i.test(cropPath)) {
                const candidate = cropPath.replace(/_snapshot\.jpg$/i, ".mp4");
                log(`DIAG2 ${name}: D3 trying startDownload candidate=${candidate}`);
                const outcome = await new Promise((resolve) => {
                    let bytes = 0;
                    let started = false;
                    const timer = setTimeout(() => {
                        cleanup();
                        resolve(started ? `started, ${bytes} bytes, no finish in 25s` : "no start event in 25s");
                    }, 25_000);
                    const onStart = (st, device, _meta, videoStream) => {
                        if (device?.getSerial?.() !== entry.device_sn) return;
                        started = true;
                        videoStream?.on("data", (c) => {
                            bytes += c.length;
                        });
                        videoStream?.resume();
                    };
                    const onFinish = (st, device) => {
                        if (device?.getSerial?.() !== entry.device_sn) return;
                        cleanup();
                        resolve(`finished, ${bytes} bytes`);
                    };
                    const cleanup = () => {
                        clearTimeout(timer);
                        client.off("station download start", onStart);
                        client.off("station download finish", onFinish);
                    };
                    client.on("station download start", onStart);
                    client.on("station download finish", onFinish);
                    station.startDownload(deviceObj, candidate, 0).catch((e) => {
                        cleanup();
                        resolve(`startDownload threw: ${shortErr(e)}`);
                    });
                });
                log(`DIAG2 ${name}: D3 result: ${outcome}`);
                try {
                    await client.cancelStationDownload(entry.device_sn).catch(() => {});
                } catch {
                    /* ignore */
                }
            }
        }

        try {
            station.close?.();
        } catch {
            /* ignore */
        }
        await sleep(3_000);
    }

    console.log("DIAG2 DONE");
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
