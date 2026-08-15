import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyPollStatePath, loadPollState, pollStatePath, savePollState } from "./pollState";

/**
 * Two failure modes this pins, both of which look like nothing going wrong:
 *   - shared state between accounts — one inbox's watermark/seen silently swallowing
 *     the other's unread mail,
 *   - a missed migration — the pre-registry `outlook-poll.json` not being found, which
 *     reads as "never polled", which BASELINES: the whole current inbox marked seen and
 *     everything that arrived during the upgrade never triaged.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fig-pollstate-"));
}

function testPerAccountIsolation(): void {
  const dir = tmpdir();
  savePollState("outlook", { watermark: 100, seen: ["a"], attempts: { a: { attempts: 1, first: 1 } } }, dir);
  savePollState("personal", { watermark: 200, seen: ["b"] }, dir);

  assert.notEqual(pollStatePath("outlook", dir), pollStatePath("personal", dir), "one file per account key");
  const outlook = loadPollState("outlook", dir);
  const personal = loadPollState("personal", dir);
  assert.deepEqual(outlook, { watermark: 100, seen: ["a"], attempts: { a: { attempts: 1, first: 1 } } });
  assert.deepEqual(personal, { watermark: 200, seen: ["b"], attempts: {} });

  // A save on one account leaves the other's watermark/seen/ledger untouched.
  savePollState("personal", { watermark: 999, seen: ["b", "c"] }, dir);
  assert.deepEqual(loadPollState("outlook", dir), outlook, "accounts can't stomp each other");

  assert.equal(loadPollState("unpolled", dir), null, "an account with no file has never been polled");
}

function testLegacyMigration(): void {
  const dir = tmpdir();
  const legacy = { watermark: 1234, seen: ["m1", "m2"], attempts: { m3: { attempts: 2, first: 5 } } };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyPollStatePath(dir), JSON.stringify(legacy));

  const loaded = loadPollState("outlook", dir);
  assert.deepEqual(loaded, legacy, "the legacy file IS the outlook account's state — no re-baseline");
  assert.ok(fs.existsSync(pollStatePath("outlook", dir)), "and it's copied forward on first load");
  assert.deepEqual(JSON.parse(fs.readFileSync(pollStatePath("outlook", dir), "utf8")), legacy);

  // Only the legacy account migrates: another key must not inherit the school inbox's seen-set.
  assert.equal(loadPollState("personal", dir), null);

  // Once migrated, the new file wins — the stale legacy copy can't resurrect old state.
  savePollState("outlook", { watermark: 5000, seen: ["m9"] }, dir);
  assert.equal(loadPollState("outlook", dir)?.watermark, 5000);
}

function testMalformedStateIsNotState(): void {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pollStatePath("outlook", dir), "{ not json");
  assert.equal(loadPollState("outlook", dir), null, "unparseable state is no state, not a crash");
  fs.writeFileSync(pollStatePath("personal", dir), JSON.stringify({ watermark: "soon", seen: [] }));
  assert.equal(loadPollState("personal", dir), null, "a wrong-shaped watermark is rejected too");
}

function testSeenIsCapped(): void {
  const dir = tmpdir();
  const seen = Array.from({ length: 3200 }, (_, i) => `m${i}`);
  savePollState("outlook", { watermark: 1, seen }, dir);
  const loaded = loadPollState("outlook", dir);
  assert.equal(loaded?.seen.length, 3000, "the seen-set is bounded per account");
  assert.equal(loaded?.seen.at(-1), "m3199", "and it's the NEWEST ids that survive");
}

function main(): void {
  testPerAccountIsolation();
  testLegacyMigration();
  testMalformedStateIsNotState();
  testSeenIsCapped();
  console.log("pollState.test.ts: all per-account mail poll state tests passed");
}

main();
