#!/usr/bin/env node
/**
 * enum-paths.test.mjs — offline unit-style sanity for sweep v3's pure
 * helpers (no camera, no session). Run: node app/enum-paths.test.mjs
 * Covers the stamp-arithmetic rollovers (minute/hour/day/month/year/leap)
 * and path build/parse edge cases incl. cross-month directory rebuilds
 * and rejection of the Front Door's non-enumerable scheme.
 */
import assert from "node:assert";
import { shiftStamp, parseEnumTemplate, buildEnumPath, stampToWallMs, wallMsToStamp } from "./enum-paths.mjs";

// --- shiftStamp rollovers ---------------------------------------------------
assert.equal(shiftStamp("20261012230611", 1), "20261012230612");
assert.equal(shiftStamp("20261012230611", -1), "20261012230610");
assert.equal(shiftStamp("20261012230600", -1), "20261012230559"); // minute
assert.equal(shiftStamp("20261012230000", -1), "20261012225959"); // hour
assert.equal(shiftStamp("20261012000000", -1), "20261011235959"); // day
assert.equal(shiftStamp("20261001000000", -1), "20260930235959"); // month
assert.equal(shiftStamp("20270101000000", -1), "20261231235959"); // year
assert.equal(shiftStamp("20240301000000", -1), "20240229235959"); // leap day
assert.equal(shiftStamp("20261012235959", 1), "20261013000000"); // day, forward
assert.equal(shiftStamp("20261012230611", 3600), "20261013000611"); // +1h over midnight
assert.equal(shiftStamp("20261012230611", 0), "20261012230611"); // identity
assert.equal(wallMsToStamp(stampToWallMs("20261012230611")), "20261012230611"); // roundtrip

// --- template parse / build ---------------------------------------------------
const porchPath = "/media/mmcblk0p1/Camera00/event/202610/20261012/20261012164047_snapshot.jpg";
const t = parseEnumTemplate(porchPath);
assert.ok(t, "porch snapshot path must be enumerable");
assert.equal(t.stamp, "20261012164047");
assert.equal(buildEnumPath(t, "20261012164047"), porchPath); // identity roundtrip
assert.equal(
    buildEnumPath(t, "20261012185900"),
    "/media/mmcblk0p1/Camera00/event/202610/20261012/20261012185900_snapshot.jpg",
);
assert.equal(
    buildEnumPath(t, "20261101000001"), // cross-month: dirs rebuilt from target stamp
    "/media/mmcblk0p1/Camera00/event/202611/20261101/20261101000001_snapshot.jpg",
);
assert.equal(
    buildEnumPath(t, shiftStamp(t.stamp, -1)),
    "/media/mmcblk0p1/Camera00/event/202610/20261012/20261012164046_snapshot.jpg",
);

// --- non-enumerable schemes are rejected --------------------------------------
assert.equal(parseEnumTemplate("/media/mmcblk0p1/video/20261012203445_c00.jpg"), null); // Front Door
assert.equal(parseEnumTemplate("/media/mmcblk0p1/Camera00/event/202610/20261012/20261012164047.mp4"), null);
assert.equal(parseEnumTemplate(""), null);
assert.equal(parseEnumTemplate(null), null);

console.log("enum-paths.test: all assertions passed");
