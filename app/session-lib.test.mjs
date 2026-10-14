/**
 * session-lib.test.mjs — offline unit tests for session-lib.mjs.
 * Run: node app/session-lib.test.mjs   (exit 0 = all pass)
 * Fixture tokens are obvious fakes; only structure/dates are exercised.
 */
import assert from "node:assert";
import { validateSessionShape, classifySession, chooseSessionSource, expiryToMs, RENEW_MARGIN_MS } from "./session-lib.mjs";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function makeCopy({ legacyMs = NOW + 29 * DAY, megaSec = (NOW + 29 * DAY) / 1000 } = {}) {
    return JSON.stringify({
        country: "US",
        openudid: "fake-openudid",
        login_hash: "fakehash",
        version: "4.1.0",
        cloud_token: "FAKE-LEGACY-TOKEN",
        cloud_token_expiration: legacyMs,
        httpApi: { user_id: "fake-user", email: "", nick_name: "", device_public_keys: {}, clientPrivateKey: "FAKE", serverPublicKey: "FAKE" },
        megaApi: {
            ab: "us",
            openudid: "fake-openudid",
            login_hash: "fakehash",
            cloud_token: "FAKE-MEGA-TOKEN",
            cloud_token_expiration: megaSec,
            user_id: "fake-user",
            domains: {},
            megaDomain: "mega-us-pr.eufy.com",
            identities: {},
        },
    });
}

// expiryToMs: ms stays ms, seconds become ms, junk is null
assert.equal(expiryToMs(NOW + DAY), NOW + DAY);
assert.equal(expiryToMs((NOW + DAY) / 1000), NOW + DAY);
assert.equal(expiryToMs(0), null);
assert.equal(expiryToMs(""), null);
assert.equal(expiryToMs("not a date"), null);

// shape: a well-formed copy validates and reports both expiries
{
    const shape = validateSessionShape(JSON.parse(makeCopy()));
    assert.equal(shape.ok, true, shape.problems.join("; "));
    assert.equal(shape.legacyExpiryMs, NOW + 29 * DAY);
    assert.equal(shape.megaExpiryMs, NOW + 29 * DAY);
}

// shape: missing mega token / corrupt shapes fail with problems, no throw
{
    const bad = JSON.parse(makeCopy());
    delete bad.megaApi.cloud_token;
    const shape = validateSessionShape(bad);
    assert.equal(shape.ok, false);
    assert.ok(shape.problems.some((p) => p.includes("mega cloud_token")));
    assert.equal(validateSessionShape(null).ok, false);
    assert.equal(validateSessionShape("nope").ok, false);
    assert.equal(validateSessionShape([1, 2]).ok, false);
}

// classify: usable / expiring / expired boundaries
{
    assert.equal(classifySession(validateSessionShape(JSON.parse(makeCopy())), NOW), "usable");
    const expiring = makeCopy({ legacyMs: NOW + RENEW_MARGIN_MS - DAY });
    assert.equal(classifySession(validateSessionShape(JSON.parse(expiring)), NOW), "expiring");
    const dead = makeCopy({ legacyMs: NOW - DAY });
    assert.equal(classifySession(validateSessionShape(JSON.parse(dead)), NOW), "expired");
    const megaDead = makeCopy({ megaSec: (NOW - DAY) / 1000 });
    assert.equal(classifySession(validateSessionShape(JSON.parse(megaDead)), NOW), "expired");
    assert.equal(classifySession({ ok: false, problems: ["x"], legacyExpiryMs: null, megaExpiryMs: null }, NOW), "invalid");
}

// choose: data-repo wins when usable; expired data copy never shadows a usable secret
{
    const good = makeCopy();
    const dead = makeCopy({ legacyMs: NOW - DAY, megaSec: (NOW - DAY) / 1000 });
    const pick1 = chooseSessionSource(
        [
            { source: "data-repo", text: good },
            { source: "actions-secret", text: makeCopy({ legacyMs: NOW + 10 * DAY }) },
        ],
        NOW,
    );
    assert.equal(pick1.source, "data-repo");
    const pick2 = chooseSessionSource(
        [
            { source: "data-repo", text: dead },
            { source: "actions-secret", text: good },
        ],
        NOW,
    );
    assert.equal(pick2.source, "actions-secret", "expired canonical copy must fall back to the secret copy");
    const pick3 = chooseSessionSource(
        [
            { source: "data-repo", text: "{corrupt json" },
            { source: "actions-secret", text: good },
        ],
        NOW,
    );
    assert.equal(pick3.source, "actions-secret", "corrupt canonical copy must fall back, never brick the fleet");
    const pick4 = chooseSessionSource(
        [
            { source: "data-repo", text: dead },
            { source: "actions-secret", text: dead },
        ],
        NOW,
    );
    assert.equal(pick4, null, "all copies expired/invalid -> no source");
    const pick5 = chooseSessionSource([{ source: "data-repo", text: "" }, { source: "actions-secret", text: null }], NOW);
    assert.equal(pick5, null);
}

console.log("session-lib.test: ALL PASS");
