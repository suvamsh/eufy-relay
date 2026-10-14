#!/usr/bin/env node
/**
 * health.test.mjs — offline unit sanity for Stage 2 health bookkeeping
 * (no camera, no session). Run: node app/health.test.mjs
 * Covers the dark-camera rule (failure streak / >6h silence / healthy),
 * the marker re-raise throttle, and liveness recording.
 */
import assert from "node:assert";
import {
    defaultHealth,
    deviceHealth,
    recordContactOk,
    recordContactFail,
    evaluateDark,
    shouldWriteMarker,
    recordLiveness,
    DARK_RERAISE_MS,
} from "./health.mjs";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// --- defaults + get-or-create ---------------------------------------------
const state = {};
const h = deviceHealth(state, "Backyard", "Backyard");
assert.equal(h.station, "Backyard");
assert.equal(h.lastEventStamp, null);
assert.equal(deviceHealth(state, "Backyard"), h, "get-or-create returns the same record");

// --- healthy device: contact ok, fresh success → not dark -------------------
recordContactOk(h, iso(T0), "20261013050000");
assert.equal(h.lastEventStamp, "20261013050000");
assert.equal(evaluateDark(h, T0 + 60_000).dark, false);
// an older stamp never rewinds lastEventStamp
recordContactOk(h, iso(T0 + 60_000), "20261013040000");
assert.equal(h.lastEventStamp, "20261013050000");

// --- >6h silence after a success → dark --------------------------------------
// (last success was recorded at T0 + 60s by the rewind check above)
const lastOk = T0 + 60_000;
assert.equal(evaluateDark(h, lastOk + 6 * 3600_000).dark, false, "exactly 6h is not yet dark");
const silent = evaluateDark(h, lastOk + 6 * 3600_000 + 1);
assert.equal(silent.dark, true);
assert.match(silent.reason, />6h/);

// --- failure streak: 2 is not dark, 3 is --------------------------------------
const h2 = defaultHealth("Sideyard", "Sideyard");
recordContactFail(h2, iso(T0), "latest-info-timeout");
recordContactFail(h2, iso(T0 + 900_000), "latest-info-timeout");
assert.equal(h2.consecutiveLatestInfoTimeouts, 2);
assert.equal(evaluateDark(h2, T0 + 900_000).dark, false, "two failures: not dark yet");
recordContactFail(h2, iso(T0 + 1_800_000), "latest-info-timeout");
assert.equal(h2.consecutiveFailedContacts, 3);
assert.equal(evaluateDark(h2, T0 + 1_800_000).dark, true, "three consecutive failures: dark");

// --- connect failures count as failed contacts but not as latest-info timeouts
const h3 = defaultHealth("Porch", "Porch");
recordContactFail(h3, iso(T0), "p2p-connect");
assert.equal(h3.consecutiveFailedContacts, 1);
assert.equal(h3.consecutiveLatestInfoTimeouts, 0);
assert.equal(h3.lastContactFailKind, "p2p-connect");

// --- a success resets both streaks and clears dark ----------------------------
h2.dark = true;
h2.darkSince = iso(T0);
recordContactOk(h2, iso(T0 + 2_700_000), null);
assert.equal(h2.consecutiveFailedContacts, 0);
assert.equal(h2.consecutiveLatestInfoTimeouts, 0);
assert.equal(h2.dark, false);
assert.equal(h2.darkSince, null);
assert.equal(evaluateDark(h2, T0 + 2_700_000).dark, false);

// --- never-contacted device with <3 failures: not dark (no back-fill) ---------
const h4 = defaultHealth("Living Room", "Living Room");
assert.equal(evaluateDark(h4, T0 + 30 * 24 * 3600_000).dark, false);

// --- marker throttle ------------------------------------------------------------
const h5 = defaultHealth("Backyard", "Backyard");
assert.equal(shouldWriteMarker(h5, T0, false), true, "never raised: write");
assert.equal(shouldWriteMarker(h5, T0, true), false, "marker present: don't rewrite");
h5.darkAlertLastRaisedAt = iso(T0);
assert.equal(shouldWriteMarker(h5, T0 + 3600_000, false), false, "raised 1h ago: throttled");
assert.equal(shouldWriteMarker(h5, T0 + DARK_RERAISE_MS + 1, false), true, "raised >24h ago: re-raise");

// --- liveness recording -----------------------------------------------------------
recordLiveness(h5, iso(T0), { classification: "LIVE-QUIET", bytes: 12345 });
assert.equal(h5.lastProbeAt, iso(T0));
assert.equal(h5.lastLiveness.classification, "LIVE-QUIET");
assert.equal(h5.lastLiveness.failurePattern, null);
recordLiveness(h5, iso(T0 + 1000), { classification: "UNREACHABLE", failurePattern: "p2p-connect", bytes: 0 });
assert.equal(h5.lastLiveness.failurePattern, "p2p-connect");

console.log("health.test: all assertions passed");
