/**
 * latest-info.mjs — the wake ladder for databaseQueryLatestInfo.
 *
 * WHY THIS EXISTS (dark-camera investigation, Oct 15, 2026; probe runs
 * 38692543287 Porch / 38692568670 Backyard, write-up in RELAY-BUILD.md
 * "Dark cameras"): a cold SoloCam's database service does not answer
 * latest-info when the P2P session opens. It wakes SLOWLY while the
 * session prods it — Porch answered an ask sent ~105 s after connect,
 * Backyard (zero lifetime events, always cold) an ask sent ~196 s
 * after connect, answered 21 s later. Asks sent while cold are dropped,
 * not queued; once awake, answers take ~1-20 s. Battery (97-100%) and
 * Wi-Fi (RSSI -50..-62) were healthy in both probes, P2P connect /
 * livestream / image download / push all work while cold — only the
 * database query path sleeps. Warm cameras (recent event traffic, the
 * mains-powered Living Room, the hub-attached Front Door) answer the
 * first ask in <1 s, which is why the failures cluster on quiet
 * battery cameras and in the evening when Porch's event traffic stops.
 *
 * The old behaviour (ask 45 s, settle 10 s, ask 45 s — a ~100 s window
 * from connect) sits just inside the observed wake distribution, so a
 * cold camera fails most sweeps and goes "dark" despite being alive.
 *
 * V4.4 — THE WAKE IS THE LIVESTREAM, NOT THE CLOCK (Oct 15, 2026;
 * stream-early probe run 38693797658, Sideyard): the first Sideyard
 * probe (38693266733) left it ambiguous whether the database service
 * woke because ~250 s had passed or because a livestream had just
 * run. The stream-early variant settled it: baseline ask timed out
 * (cold, +5→50 s), a ~6 s livestream ran at +54→60 s, and the very
 * next ask — at +64 s post-connect, far inside the 100-250 s
 * time-based wake range — was ANSWERED in 288 ms. Starting a
 * livestream wakes the camera's database service.
 *
 * THE LADDER (v4.4): keep the classic first pair EXACTLY as before
 * (45 s ask, 10 s settle, 45 s ask). If both asks time out and the
 * caller supplied a wake nudge, fire it ONCE (the sweep nudges with a
 * ~6 s livestream start/stop), settle briefly (3 s), and ask again —
 * a nudged camera answers in well under a second in both probes.
 * If that ask still times out (nudge failed to start, or the camera
 * is colder than any probe), keep asking on the same connection —
 * 30 s asks, 15 s settles — until the wake window (270 s from the
 * first ask) or a caller-supplied deadline (the sweep passes its
 * global station budget minus a reserve) runs out. Only stations
 * that keep timing out pay the extra time; a warm station never
 * notices, and the nudge costs ~6 s of stream only on stations that
 * already failed the classic pair twice.
 *
 * askOnce(timeoutMs) must reject with an error whose message matches
 * /timed out|timeout/i on timeout (the sweep's latestInfoOnce does);
 * any other rejection aborts the ladder immediately, as before.
 */

export const LATEST_FIRST_TIMEOUT_MS = 45_000;
export const LATEST_RETRY_TIMEOUT_MS = 45_000;
export const LATEST_FIRST_SETTLE_MS = 10_000;
export const LATEST_WAKE_TIMEOUT_MS = 30_000;
export const LATEST_WAKE_SETTLE_MS = 15_000;
export const LATEST_WAKE_WINDOW_MS = 270_000;
export const LATEST_NUDGE_SETTLE_MS = 3_000;

const DEFAULT_CONFIG = {
    firstTimeoutMs: LATEST_FIRST_TIMEOUT_MS,
    retryTimeoutMs: LATEST_RETRY_TIMEOUT_MS,
    firstSettleMs: LATEST_FIRST_SETTLE_MS,
    wakeTimeoutMs: LATEST_WAKE_TIMEOUT_MS,
    wakeSettleMs: LATEST_WAKE_SETTLE_MS,
    wakeWindowMs: LATEST_WAKE_WINDOW_MS,
    nudgeSettleMs: LATEST_NUDGE_SETTLE_MS,
};

const isTimeoutErr = (e) => /timed out|timeout/i.test(e instanceof Error ? e.message : String(e));

/**
 * Run askOnce through the wake ladder.
 *
 * @param {(timeoutMs: number) => Promise<any>} askOnce one latest-info ask
 * @param {object} [opts]
 * @param {number} [opts.deadlineMs] absolute epoch-ms cap for the ladder
 *   (asks 1-2, the classic pair, always run regardless)
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(msg: string) => void} [opts.log]
 * @param {string} [opts.label] station name used in log lines
 * @param {() => Promise<boolean>} [opts.wakeNudge] v4.4: fired ONCE
 *   after the classic pair both time out; resolves true when the
 *   nudge actually engaged (the sweep's livestream start). A nudge
 *   that throws or returns false just falls back to the plain ladder.
 * @param {object} [opts.config] timing overrides (tests)
 */
export async function wakeLadderLatestInfo(askOnce, opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now ?? (() => Date.now());
    const log = opts.log ?? (() => {});
    const label = opts.label ?? "station";
    const startedAt = now();
    const deadline = Math.min(startedAt + cfg.wakeWindowMs, opts.deadlineMs ?? Number.POSITIVE_INFINITY);
    const timeoutFor = (n) => (n === 1 ? cfg.firstTimeoutMs : n === 2 ? cfg.retryTimeoutMs : cfg.wakeTimeoutMs);

    let attempt = 0;
    let lastErr = null;
    let nudged = false;
    for (;;) {
        attempt++;
        try {
            return await askOnce(timeoutFor(attempt));
        } catch (e) {
            if (!isTimeoutErr(e)) throw e;
            lastErr = e;
            let settle = attempt === 1 ? cfg.firstSettleMs : cfg.wakeSettleMs;
            // v4.4: after the classic pair both time out, fire the wake
            // nudge once (a livestream start provably wakes the database
            // service), then ask again after only a short settle
            if (attempt === 2 && !nudged && typeof opts.wakeNudge === "function") {
                nudged = true;
                let engaged = false;
                try {
                    engaged = await opts.wakeNudge();
                } catch {
                    engaged = false;
                }
                if (engaged) {
                    settle = cfg.nudgeSettleMs;
                    log(`  ${label}: wake nudge engaged after 2 silent asks — settle ${cfg.nudgeSettleMs / 1000}s, asking again`);
                } else {
                    log(`  ${label}: wake nudge did not engage after 2 silent asks — continuing the plain wake ladder`);
                }
            }
            // the classic pair (asks 1-2) always runs; the deadline only
            // truncates the wake ladder beyond it
            if (attempt >= 2 && now() + settle + timeoutFor(attempt + 1) > deadline) break;
            if (attempt === 1) {
                log(`  ${label}: latest-info timed out — settle ${cfg.firstSettleMs / 1000}s, one retry`);
            } else if (!nudged || attempt > 2) {
                log(`  ${label}: latest-info still silent after ask #${attempt} — wake ladder: settle ${settle / 1000}s, asking again (cold camera database services take 100-220s to wake unaided)`);
            }
            await sleep(settle);
        }
    }
    throw lastErr;
}
