#!/usr/bin/env node
/**
 * session-restore.mjs — fleet session resolution (Session permanence,
 * Oct 13, 2026). Run by every relay workflow AFTER the data repo is
 * checked out and BEFORE its app starts. Pure Node (fs only) so it can
 * run before `npm ci`.
 *
 * Resolution order (see session-lib.mjs for the mechanics):
 *   1. data-repo canonical copy: $RELAY_DATA_DIR/session/persistent.json
 *      (maintained by session-keeper.mjs; the freshest copy in the fleet)
 *   2. Actions-secret bootstrap copy: env EUFY_PERSISTENT_JSON
 *      (kept forever as the fallback; set once by redirection)
 * The winner is written VERBATIM to app/persistent-data/persistent.json
 * (the path every app reads), mode 0600. Only the source name and the
 * expiry DATES are logged — never any file content.
 *
 * Env:
 *   RELAY_DATA_DIR            data repo checkout (default ../data)
 *   EUFY_PERSISTENT_JSON      bootstrap copy (may be unset)
 *   SESSION_RESTORE_NO_SECRET "1" ignores the secret copy (proof mode:
 *                             demonstrates restore from the data-repo
 *                             copy alone)
 * Exit: 0 = a usable/expiring copy was written; 1 = no usable copy
 * anywhere (nothing written; the app's own offline gate will produce
 * its usual SESSION: FAIL marker and the keeper/blocker flow owns it).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseSessionSource, isoOrNull } from "./session-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSISTENT_DIR = path.join(HERE, "persistent-data");
const PERSISTENT_FILE = path.join(PERSISTENT_DIR, "persistent.json");
const DATA_DIR = process.env.RELAY_DATA_DIR || path.resolve(HERE, "..", "data");
const CANONICAL_FILE = path.join(DATA_DIR, "session", "persistent.json");

function readIfExists(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return null;
    }
}

function main() {
    const noSecret = process.env.SESSION_RESTORE_NO_SECRET === "1";
    const candidates = [{ source: "data-repo", text: readIfExists(CANONICAL_FILE) }];
    if (!noSecret) {
        candidates.push({ source: "actions-secret", text: process.env.EUFY_PERSISTENT_JSON || null });
    } else {
        console.log("session-restore: SESSION_RESTORE_NO_SECRET=1 — secret copy ignored (proof mode)");
    }

    const pick = chooseSessionSource(candidates);
    if (!pick) {
        console.error(
            "session-restore: NO usable session copy (data-repo copy missing/expired/invalid" +
                (noSecret ? "; secret ignored" : " and secret copy missing/expired/invalid") +
                ") — leaving persistent-data untouched; the app gate will fail this run",
        );
        process.exit(1);
    }

    fs.mkdirSync(PERSISTENT_DIR, { recursive: true });
    try {
        fs.chmodSync(PERSISTENT_DIR, 0o700);
    } catch {
        /* best effort */
    }
    const tmp = `${PERSISTENT_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, pick.text, { mode: 0o600 });
    fs.renameSync(tmp, PERSISTENT_FILE);
    console.log(
        `SESSION SOURCE: ${pick.source} (${pick.classification}) ` +
            `legacyExpires=${isoOrNull(pick.shape.legacyExpiryMs)} megaExpires=${isoOrNull(pick.shape.megaExpiryMs)}`,
    );
    process.exit(0);
}

main();
