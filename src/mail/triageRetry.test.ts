import assert from "node:assert/strict";

import {
  ATTEMPT_TTL_MS,
  MAX_ATTEMPT_ENTRIES,
  MAX_TRIAGE_ATTEMPTS,
  TriageAttempts,
  decideTriageFollowup,
  dispositionFor,
  type AttemptState,
} from "./triageRetry";
import type { TriageOutcome } from "./verdict";

/**
 * Regression tests for the second half of the 2026-07-29 fail-silent defect: both
 * pollers wrote the message id into `seen` BEFORE triage and regardless of outcome, so a
 * broken run was indistinguishable from a finished one and was never retried. These pin
 * the rule that replaced it — commit only on a recognized outcome — and the cap that
 * keeps "retry until understood" from becoming an infinite loop.
 */

const RECOGNIZED_SILENT: TriageOutcome = { brief: null, recognized: true };
const RECOGNIZED_NOTIFY: TriageOutcome = { brief: "NOTIFY\nwhat: real facts", recognized: true };
const UNREADABLE: TriageOutcome = { brief: "NOTIFY\nwhat: triage couldn't classify this email", recognized: false };
const RUN_FAILED: TriageOutcome = { brief: null, recognized: false };

function testDispositions(): void {
  assert.equal(dispositionFor(true, 1), "commit");
  assert.equal(dispositionFor(true, MAX_TRIAGE_ATTEMPTS + 5), "commit", "recognized always commits");
  assert.equal(dispositionFor(false, 1), "retry");
  assert.equal(dispositionFor(false, MAX_TRIAGE_ATTEMPTS - 1), "retry");
  assert.equal(dispositionFor(false, MAX_TRIAGE_ATTEMPTS), "giveup");
}

/** (c) An unrecognized or failed outcome must never mark the message seen. */
function testUnrecognizedNeverCommits(): void {
  for (const outcome of [UNREADABLE, RUN_FAILED]) {
    const next = decideTriageFollowup(outcome, 1);
    assert.equal(next.disposition, "retry");
    assert.equal(next.commitSeen, false, "an outcome we didn't understand must stay retryable");
    assert.equal(next.deliver, null, "retries stay quiet — the give-up path does the pinging");
  }
  // ...while a recognized one commits exactly as before.
  assert.deepEqual(decideTriageFollowup(RECOGNIZED_SILENT, 1), {
    disposition: "commit",
    commitSeen: true,
    deliver: null,
    remember: null,
  });
  assert.equal(decideTriageFollowup(RECOGNIZED_NOTIFY, 1).deliver, RECOGNIZED_NOTIFY.brief);
}

/** The held brief is what makes "unreadable, then the runtime died" still surface. */
function testGiveupSurfacesBestBrief(): void {
  const held = decideTriageFollowup(UNREADABLE, 1).remember;
  assert.equal(held, UNREADABLE.brief, "a fallback brief seen during a retry is held, not dropped");

  const withOwn = decideTriageFollowup(UNREADABLE, MAX_TRIAGE_ATTEMPTS, "older brief");
  assert.equal(withOwn.disposition, "giveup");
  assert.equal(withOwn.commitSeen, true, "giving up must commit, or the loop never ends");
  assert.equal(withOwn.deliver, UNREADABLE.brief, "the freshest brief wins");

  const fromMemory = decideTriageFollowup(RUN_FAILED, MAX_TRIAGE_ATTEMPTS, held!);
  assert.equal(fromMemory.deliver, held, "a later empty run must not erase the earlier fallback");

  const nothingAtAll = decideTriageFollowup(RUN_FAILED, MAX_TRIAGE_ATTEMPTS);
  assert.equal(nothingAtAll.commitSeen, true);
  assert.equal(nothingAtAll.deliver, null, "no text ever produced → nothing honest to say; the warn carries it");
}

/**
 * (c) + (d) The whole poller loop, end to end against the real ledger: a message that
 * NEVER classifies is retried, never marked seen while attempts remain, then given up on
 * exactly once — and the loop terminates.
 */
function testCapStopsTheLoop(): void {
  let persisted: AttemptState = {};
  const attempts = new TriageAttempts({ persist: (s) => void (persisted = { ...s }) });
  const seen = new Set<string>();
  const delivered: string[] = [];
  const key = "personal:19fb0b18a482f4bf";

  let ticks = 0;
  while (!seen.has(key)) {
    if (++ticks > 50) assert.fail("retry loop never terminated — the cap is not holding");
    const attempt = attempts.begin(key);
    assert.equal(persisted[key]?.attempts, attempt, "the attempt is persisted BEFORE the run, so a crash still counts");
    const next = decideTriageFollowup(UNREADABLE, attempt);
    if (next.remember) attempts.remember(key, next.remember);
    if (!next.commitSeen) {
      assert.ok(!seen.has(key), "must stay unseen while attempts remain");
      continue;
    }
    seen.add(key);
    attempts.clear(key);
    if (next.deliver) delivered.push(next.deliver);
  }

  assert.equal(ticks, MAX_TRIAGE_ATTEMPTS, `gave up after exactly ${MAX_TRIAGE_ATTEMPTS} attempts`);
  assert.equal(delivered.length, 1, "exactly one ping for the whole ordeal — surfaced, not spammed");
  assert.equal(delivered[0], UNREADABLE.brief);
  assert.deepEqual(persisted, {}, "a resolved message leaves no residue in the ledger");
}

/** A message that classifies on the second attempt commits then, and pings for real. */
function testRecoveryOnRetry(): void {
  const attempts = new TriageAttempts();
  const key = "personal:m1";
  const first = decideTriageFollowup(UNREADABLE, attempts.begin(key));
  assert.equal(first.commitSeen, false);
  if (first.remember) attempts.remember(key, first.remember);
  const second = decideTriageFollowup(RECOGNIZED_NOTIFY, attempts.begin(key), attempts.recall(key));
  assert.equal(second.commitSeen, true);
  assert.equal(second.deliver, RECOGNIZED_NOTIFY.brief, "the real brief wins over the held fallback");
  attempts.clear(key);
  assert.equal(attempts.attempts(key), 0);
}

/** The ledger cannot grow without bound: TTL, hard cap, and clear-on-resolve. */
function testLedgerIsBounded(): void {
  let now = 1_000_000_000_000;
  const attempts = new TriageAttempts({ now: () => now });
  for (let i = 0; i < MAX_ATTEMPT_ENTRIES + 25; i++) {
    now += 1000;
    attempts.begin(`personal:m${i}`);
  }
  assert.equal(Object.keys(attempts.snapshot()).length, MAX_ATTEMPT_ENTRIES, "hard cap holds");
  assert.ok(!attempts.snapshot()["personal:m0"], "oldest entries are the ones evicted");

  now += ATTEMPT_TTL_MS + 1;
  const dropped = attempts.prune();
  assert.equal(dropped.length, MAX_ATTEMPT_ENTRIES, "everything past the TTL is dropped, and reported");
  assert.deepEqual(attempts.snapshot(), {}, "nothing sticks around forever");
}

/** Malformed/absent persisted state must never take the poller down. */
function testStateRoundTrip(): void {
  const state: AttemptState = { "personal:m1": { attempts: 2, first: Date.now(), brief: "NOTIFY\nwhat: held" } };
  const attempts = new TriageAttempts({
    state,
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.equal(attempts.attempts("personal:m1"), 2, "attempts survive a restart");
  assert.equal(attempts.recall("personal:m1"), "NOTIFY\nwhat: held");
  assert.equal(attempts.begin("personal:m1"), 3, "a persist failure must not throw out of the poll loop");
  assert.deepEqual(attempts.pending(), ["personal:m1"]);
}

function main(): void {
  testDispositions();
  testUnrecognizedNeverCommits();
  testGiveupSurfacesBestBrief();
  testCapStopsTheLoop();
  testRecoveryOnRetry();
  testLedgerIsBounded();
  testStateRoundTrip();
  console.log("triageRetry.test.ts: all triage retry/seen-commit tests passed");
}

main();
