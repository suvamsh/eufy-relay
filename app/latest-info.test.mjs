#!/usr/bin/env node
/**
 * latest-info.test.mjs — offline unit sanity for the v4.3 wake ladder
 * (no camera, no session). Run: node app/latest-info.test.mjs
 * A scripted fake ask + fake clock reproduce the probe transcripts:
 * warm camera (answers ask #1), classic camera (answers ask #2),
 * cold SoloCam (silent until a late ask), never-waking camera
 * (ladder exhausts and throws), budget-capped ladder, and a
 * non-timeout error aborting immediately.
 */
import assert from "node:assert";
import { wakeLadderLatestInfo } from "./latest-info.mjs";

// fake clock: now() reads a counter; sleep(ms) advances it instantly;
// a scripted ask advances it by its timeout (on timeout) or by a
// scripted latency (on success)
function harness(script) {
    let nowMs = 1_000_000;
    const asks = [];
    const sleeps = [];
    const ask = async (timeoutMs) => {
        asks.push(timeoutMs);
        const step = script[asks.length - 1] ?? { type: "timeout" };
        if (step.type === "timeout") {
            nowMs += timeoutMs;
            throw new Error(`timeout after ${timeoutMs}ms waiting for latest-info`);
        }
        if (step.type === "error") {
            throw new Error(step.message);
        }
        nowMs += step.latencyMs ?? 1_000;
        return step.value ?? [{ device_sn: "x" }];
    };
    return {
        ask,
        asks,
        sleeps,
        opts: {
            sleep: async (ms) => {
                sleeps.push(ms);
                nowMs += ms;
            },
            now: () => nowMs,
            label: "TestCam",
        },
        elapsed: () => nowMs - 1_000_000,
    };
}

// --- warm camera: answers the first ask ------------------------------------
{
    const h = harness([{ type: "answer", latencyMs: 600 }]);
    const v = await wakeLadderLatestInfo(h.ask, h.opts);
    assert.equal(v.length, 1);
    assert.deepEqual(h.asks, [45_000], "warm camera: exactly one 45s ask");
    assert.deepEqual(h.sleeps, []);
}

// --- classic camera: first ask times out, retry answers ---------------------
{
    const h = harness([{ type: "timeout" }, { type: "answer", latencyMs: 1_100 }]);
    await wakeLadderLatestInfo(h.ask, h.opts);
    assert.deepEqual(h.asks, [45_000, 45_000], "classic pair keeps its 45s/45s shape");
    assert.deepEqual(h.sleeps, [10_000], "classic settle is 10s");
}

// --- cold SoloCam (the Porch probe shape): silent for 2 asks, answers #3 -----
{
    const h = harness([{ type: "timeout" }, { type: "timeout" }, { type: "answer", latencyMs: 4_800 }]);
    await wakeLadderLatestInfo(h.ask, h.opts);
    assert.deepEqual(h.asks, [45_000, 45_000, 30_000], "ladder asks shrink to 30s after the classic pair");
    assert.deepEqual(h.sleeps, [10_000, 15_000]);
}

// --- colder SoloCam (the Backyard probe shape): answers ask #5 ---------------
{
    const h = harness([
        { type: "timeout" },
        { type: "timeout" },
        { type: "timeout" },
        { type: "timeout" },
        { type: "answer", latencyMs: 20_800 },
    ]);
    await wakeLadderLatestInfo(h.ask, h.opts);
    assert.equal(h.asks.length, 5);
    assert.ok(h.elapsed() < 270_000, `answered inside the wake window (elapsed ${h.elapsed()}ms)`);
}

// --- never wakes: ladder exhausts inside the window and throws ---------------
{
    const h = harness([]);
    await assert.rejects(() => wakeLadderLatestInfo(h.ask, h.opts), /timeout after/);
    assert.ok(h.asks.length >= 4, `ladder made several asks (got ${h.asks.length})`);
    assert.ok(h.elapsed() <= 270_000 + 30_000, `ladder stayed bounded (elapsed ${h.elapsed()}ms)`);
}

// --- caller deadline truncates the ladder, classic pair still guaranteed -----
{
    const h = harness([]);
    const t0 = h.opts.now();
    await assert.rejects(() => wakeLadderLatestInfo(h.ask, { ...h.opts, deadlineMs: t0 + 120_000 }), /timeout after/);
    assert.equal(h.asks.length, 2, "deadline at +120s leaves exactly the classic pair");
}

// --- non-timeout error aborts immediately ------------------------------------
{
    const h = harness([{ type: "error", message: "latest-info returned code 3" }, { type: "answer" }]);
    await assert.rejects(() => wakeLadderLatestInfo(h.ask, h.opts), /returned code 3/);
    assert.equal(h.asks.length, 1, "no retry on a hard error");
    assert.deepEqual(h.sleeps, []);
}

console.log("latest-info.test.mjs: all assertions passed");
