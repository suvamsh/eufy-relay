#!/usr/bin/env node
/**
 * enum-paths.test.mjs — offline unit-style sanity for sweep v3's pure
 * helpers (no camera, no session). Run: node app/enum-paths.test.mjs
 * Covers the stamp-arithmetic rollovers (minute/hour/day/month/year/leap)
 * and path build/parse edge cases incl. cross-month directory rebuilds,
 * the Front Door family (enumerable since v4.2), and cluster windows.
 */
import assert from "node:assert";
import { shiftStamp, parseEnumTemplate, buildEnumPath, stampToWallMs, wallMsToStamp, clusterWindowStamps } from "./enum-paths.mjs";

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

// --- front-door family (enumerable since v4.2, snapshots only) ------------------
const fdPath = "/media/mmcblk0p1/video/20261012203445_c00.jpg";
const fd = parseEnumTemplate(fdPath);
assert.ok(fd, "front door snapshot path must be enumerable since v4.2");
assert.equal(fd.family, "front-door");
assert.equal(fd.stamp, "20261012203445");
assert.equal(buildEnumPath(fd, "20261012203445"), fdPath); // identity roundtrip
assert.equal(buildEnumPath(fd, "20261013000102"), "/media/mmcblk0p1/video/20261013000102_c00.jpg");
assert.equal(t.family, "event");

// --- non-enumerable schemes are rejected --------------------------------------
assert.equal(parseEnumTemplate("/media/mmcblk0p1/Camera00/event/202610/20261012/20261012164047.mp4"), null);
assert.equal(parseEnumTemplate("/media/mmcblk0p1/video/20261012203445_c01.jpg"), null); // only _c00 proven
assert.equal(parseEnumTemplate(""), null);
assert.equal(parseEnumTemplate(null), null);

// --- cluster windows (v4.2) -----------------------------------------------------
// anchor mid-window: full ±300s, bounds exclusive
const w1 = clusterWindowStamps("20261012120000", "20261012100000", "20261012140000");
assert.equal(w1.length, 601);
assert.equal(w1[0], "20261012115500");
assert.equal(w1[w1.length - 1], "20261012120500");
// window edges clip the cluster (anchor = newest, window ends at anchor)
const w2 = clusterWindowStamps("20261012140000", "20261012100000", "20261012140000");
assert.equal(w2.length, 300);
assert.equal(w2[0], "20261012135500");
assert.equal(w2[w2.length - 1], "20261012135959");
// anchor entirely below the window → empty
assert.deepEqual(clusterWindowStamps("20261012080000", "20261012100000", "20261012140000"), []);
// custom radius + window clipping: anchor 12:00:30, radius 60 → [11:59:30,
// 12:01:30], clipped by the window's exclusive end 12:01:00 → last is 12:00:59
const w3 = clusterWindowStamps("20261012120030", "20261012115900", "20261012120100", 60);
const w3Expected = [];
for (let s = -60; s <= 29; s++) w3Expected.push(shiftStamp("20261012120030", s));
assert.deepEqual(w3, w3Expected);

console.log("enum-paths.test: all assertions passed");
