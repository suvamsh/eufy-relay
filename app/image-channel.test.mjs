#!/usr/bin/env node
/**
 * image-channel.test.mjs — offline tests for sweep v4.1's image-response
 * attribution (no camera, no session). Run: node app/image-channel.test.mjs
 *
 * The central case replicates the Experiment R race (Oct 13, 2026): a
 * consumer requested the Porch snapshot path ...20261013122500 (which
 * has NO file on the device) and a "station image download" event
 * carrying the station's NEWEST image (...20261013124251) landed inside
 * its wait window. A station-only matcher credited the newest image to
 * the 122500 request. ImageAttribution must not: an event settles a
 * request only when (a) it comes from the channel's own station and
 * (b) its file exactly equals a pending requested path.
 */
import assert from "node:assert";
import { ImageAttribution } from "./image-channel.mjs";

const PORCH = "PORCH-SERIAL-LAST4-AAAA";
const BACKYARD = "BACKYARD-SERIAL-LAST4-BBBB";
const PATH_A = "/media/mmcblk0p1/Camera00/event/202610/20261013/20261013122500_snapshot.jpg"; // nonexistent on device
const PATH_B = "/media/mmcblk0p1/Camera00/event/202610/20261013/20261013124251_snapshot.jpg"; // the newest event
const IMG_A = Buffer.from("image-for-A");
const IMG_B = Buffer.from("image-for-B");

function pending(att, path) {
    let settled = null;
    const entry = {
        timer: setTimeout(() => {}, 60_000),
        resolve: (img) => {
            settled = { ok: true, img };
        },
        reject: (err) => {
            settled = { ok: false, err };
        },
    };
    att.register(path, entry);
    return {
        get settled() {
            return settled;
        },
        entry,
    };
}

// --- 1. happy path: own station + exact file settles the request -------------
{
    const att = new ImageAttribution(PORCH);
    const p = pending(att, PATH_A);
    assert.equal(att.route(PORCH, PATH_A, IMG_A), true);
    assert.equal(p.settled?.ok, true);
    assert.equal(p.settled?.img, IMG_A);
    assert.equal(att.has(PATH_A), false, "settled request must be removed");
}

// --- 2. THE EXP-R RACE: newest image (file=B) lands during a wait for A ------
{
    const att = new ImageAttribution(PORCH);
    const p = pending(att, PATH_A);
    assert.equal(att.route(PORCH, PATH_B, IMG_B), false, "event for a different path must not settle the request");
    assert.equal(p.settled, null, "request for A must still be pending after B's event");
    assert.equal(att.route(PORCH, PATH_A, IMG_A), true, "A's own response still settles it afterwards");
    assert.equal(p.settled?.img, IMG_A);
}

// --- 3. foreign station, identical path string: never credited --------------
{
    const att = new ImageAttribution(BACKYARD);
    const p = pending(att, PATH_A); // SoloCams share the path scheme — same string, other station
    assert.equal(att.route(PORCH, PATH_A, IMG_A), false, "another station's event must not settle this channel");
    assert.equal(p.settled, null);
    assert.equal(att.route(BACKYARD, PATH_A, IMG_A), true, "own station's event settles it");
}

// --- 4. stray event with nothing pending is dropped ---------------------------
{
    const att = new ImageAttribution(PORCH);
    assert.equal(att.route(PORCH, PATH_B, IMG_B), false);
    assert.equal(att.route(undefined, PATH_B, IMG_B), false);
}

// --- 5. late response after timeout (expire) is dropped -----------------------
{
    const att = new ImageAttribution(PORCH);
    const p = pending(att, PATH_A);
    const entry = att.expire(PATH_A); // what the timeout path does
    assert.equal(entry, p.entry);
    entry.reject(new Error("probe timeout"));
    assert.equal(p.settled?.ok, false);
    assert.equal(att.route(PORCH, PATH_A, IMG_A), false, "late delivery for a timed-out path must be dropped");
}

// --- 6. duplicate registration for one path is refused -------------------------
{
    const att = new ImageAttribution(PORCH);
    pending(att, PATH_A);
    assert.throws(() => att.register(PATH_A, { resolve() {}, reject() {}, timer: null }), /already outstanding/);
    att.drop(PATH_A);
    assert.equal(att.has(PATH_A), false);
}

console.log("image-channel.test: all assertions passed");
