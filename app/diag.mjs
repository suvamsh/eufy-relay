#!/usr/bin/env node
/**
 * diag.mjs — TEMPORARY diagnostic for the relay sweep query semantics.
 *
 * Run 38322895407: databaseQueryByDate never answered (all stations).
 * Run 38324139181: databaseQueryLocal answered instantly but with ZERO
 * records on stations whose databaseCountByDate reports 1 / 58 / 44.
 *
 * This script connects to WifiBridge + Porch and, with a PATIENT listener
 * (batches logged as they arrive, long windows, no early settle), tries
 * several query variants to find which one returns the records the count
 * says exist. Logs contain no serials (last 4 only) and no paths.
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
const DEVICE_TZ = "America/Los_Angeles";
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

function deviceLocalDays(sinceMs, untilMs) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: DEVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayOf = (ms) => {
        const parts = {};
        for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
        return Date.UTC(+parts.year, +parts.month - 1, +parts.day);
    };
    const days = [];
    for (let d = dayOf(sinceMs); d <= dayOf(untilMs) && days.length < 9; d += 24 * 3600_000) days.push(new Date(d));
    return days;
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
    log(`stations: ${stations.map((s) => s.getName()).join(", ")}`);

    const nowMs = Date.now();
    const days = deviceLocalDays(nowMs - 24 * 3600_000, nowMs);
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    const lastDayPlus1 = new Date(lastDay.getTime() + 24 * 3600_000);
    log(`window days (device-local): ${days.map((d) => d.toISOString().slice(0, 10)).join(", ")}`);

    for (const name of TARGETS) {
        const station = stations.find((s) => s.getName() === name);
        if (!station) {
            log(`DIAG ${name}: station not found`);
            continue;
        }
        const serial = station.getSerial();
        const stDevices = devices.filter((d) => d.getStationSerial() === serial);
        const serials = stDevices.map((d) => d.getSerial());
        log(`DIAG ${name}: devices=${stDevices.map((d) => d.getName()).join(",")}`);

        const conn = await ensureP2PConnected(station);
        if (!conn.connected) {
            log(`DIAG ${name}: P2P connect FAILED (${conn.error})`);
            continue;
        }
        log(`DIAG ${name}: P2P connected`);

        // patient event tap for this station
        const tap = { batches: [] };
        const tapHandler = (eventName) => (st, rc, data) => {
            if (st?.getSerial?.() !== serial) return;
            const batch = Array.isArray(data) ? data : [];
            tap.batches.push({ eventName, rc, len: batch.length, at: Date.now() });
            log(`DIAG ${name}: EVENT ${eventName} rc=${rc} batch=${batch.length} at +${((Date.now() - t0) / 1000).toFixed(1)}s`);
            if (batch.length > 0 && eventName.includes("query")) {
                const r = batch[0];
                const h = r.history ?? r;
                log(
                    `DIAG ${name}: first record keys=[${Object.keys(r).join(",")}] historyKeys=[${h && typeof h === "object" ? Object.keys(h).join(",") : "-"}] ` +
                        `record_id=${r.record_id} device=${last4(r.device_sn)} start=${h?.start_time instanceof Date ? h.start_time.toISOString() : h?.start_time} end=${h?.end_time instanceof Date ? h.end_time.toISOString() : h?.end_time} ` +
                        `trigger=${h?.trigger_type} video=${h?.video_type} folder=${h?.folder_size} pics=${Array.isArray(r.picture) ? r.picture.length : "-"}`,
                );
            }
            if (eventName.includes("count")) {
                log(`DIAG ${name}: count detail=${JSON.stringify((data ?? []).map((c) => ({ day: c.day instanceof Date ? c.day.toISOString().slice(0, 10) : String(c.day), count: c.count })))}`);
            }
        };
        const tapped = ["station database count by date", "station database query local", "station database query by date", "station database query latest"];
        const handlers = new Map(tapped.map((e) => [e, tapHandler(e)]));
        for (const [e, h] of handlers) client.on(e, h);

        const runExp = async (label, send, waitMs = 45_000) => {
            tap.batches = [];
            const startCount = 0;
            try {
                send();
            } catch (e) {
                log(`DIAG ${name}: ${label} SEND ERROR ${shortErr(e)}`);
                return;
            }
            // wait: conclude early if records arrived and 8s of silence follow
            const deadline = Date.now() + waitMs;
            let lastBatchAt = Date.now();
            let lastSeen = 0;
            while (Date.now() < deadline) {
                await sleep(1_000);
                if (tap.batches.length !== lastSeen) {
                    lastSeen = tap.batches.length;
                    lastBatchAt = Date.now();
                }
                const total = tap.batches.reduce((a, b) => a + b.len, 0);
                if (total > 0 && Date.now() - lastBatchAt > 8_000) break;
            }
            const total = tap.batches.reduce((a, b) => a + b.len, 0);
            log(`DIAG ${name}: ${label} -> batches=${tap.batches.length} totalRecords=${total}`);
            await sleep(2_000);
            void startCount;
        };

        await runExp("E1 countByDate(first,last)", () => station.databaseCountByDate(firstDay, lastDay), 30_000);
        await runExp("E2 queryLocal(serials, firstDay, lastDay, 0,0,0)", () => station.databaseQueryLocal(serials, firstDay, lastDay, 0, 0, 0), 60_000);
        await runExp("E3 queryLocal(serials, now-24h, now, 0,0,0)", () => station.databaseQueryLocal(serials, new Date(nowMs - 24 * 3600_000), new Date(nowMs), 0, 0, 0), 60_000);
        await runExp("E4 queryLocal(serials, firstDay, lastDay+1, 0,0,0)", () => station.databaseQueryLocal(serials, firstDay, lastDayPlus1, 0, 0, 0), 60_000);
        if (name === "WifiBridge") {
            await runExp("E5 queryLocal([stationSerial], firstDay, lastDay, 0,0,0)", () => station.databaseQueryLocal([serial], firstDay, lastDay, 0, 0, 0), 60_000);
            await runExp("E6 queryByDate(serials, firstDay, firstDay, 0,0,0)", () => station.databaseQueryByDate(serials, firstDay, firstDay, 0, 0, 0), 60_000);
            await runExp("E7 queryLocal(serials, firstDay, lastDay, 0,0,1 LOCAL)", () => station.databaseQueryLocal(serials, firstDay, lastDay, 0, 0, 1), 60_000);
        }

        for (const [e, h] of handlers) client.off(e, h);
        try {
            station.close?.();
        } catch {
            /* ignore */
        }
        await sleep(3_000);
    }

    console.log("DIAG DONE");
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
