import assert from "node:assert/strict";

import { classifyTriageOutput, resolveTriageOutcome, unrecognizedBrief, type TriageRun } from "./verdict";

/**
 * Regression tests for the 2026-07-29 fail-silent triage defect: an Amazon "Delivered"
 * email came back unparseable ("no verdict token"), got lumped in with the deliberate
 * NO_NOTIFY/GLANCE decisions, and was filed silently — a notify-tier email swallowed
 * with one log line. These pin BOTH halves of the fix: the real decisions still file
 * silently, and an unreadable result retries and then surfaces.
 */

const NOTIFY_BRIEF = ["NOTIFY", "what: your package was delivered to the front desk.", "links:", "📦 https://x/y"].join("\n");

/** Capture console output so log()/warn() lines can be asserted on. */
function capture<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; warns: string[] }> {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  return fn()
    .then((result) => ({ result, logs, warns }))
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
    });
}

function testClassification(): void {
  assert.equal(classifyTriageOutput(NOTIFY_BRIEF).kind, "notify");
  assert.deepEqual(classifyTriageOutput("NO_NOTIFY"), { kind: "silent", verdict: "NO_NOTIFY" });
  assert.deepEqual(classifyTriageOutput("GLANCE"), { kind: "silent", verdict: "GLANCE" });
  // Wrapped/punctuated tokens are still DECISIONS, not unknowns — the older fix.
  assert.deepEqual(classifyTriageOutput("**GLANCE**"), { kind: "silent", verdict: "GLANCE" });
  assert.deepEqual(classifyTriageOutput("`NO_NOTIFY`."), { kind: "silent", verdict: "NO_NOTIFY" });
  // A brief whose what: line is empty carries no facts — not a notify.
  assert.equal(classifyTriageOutput("NOTIFY\nwhat:\nlinks:").kind, "unrecognized");
  assert.equal(classifyTriageOutput("").kind, "unrecognized");
  assert.equal(classifyTriageOutput("I'll go ahead and read that email for you").kind, "unrecognized");
}

/** (a) NO_NOTIFY and GLANCE still file silently, in ONE run, with the same log line. */
async function testDecisionsStillFileSilently(): Promise<void> {
  for (const token of ["NO_NOTIFY", "GLANCE"]) {
    let runs = 0;
    const { result, logs, warns } = await capture(() =>
      resolveTriageOutcome({
        lane: "gmail triage",
        messageId: "abc123",
        run: async (): Promise<TriageRun> => {
          runs++;
          return { ok: true, text: token };
        },
      }),
    );
    assert.equal(runs, 1, `${token} must not trigger a retry`);
    assert.deepEqual(result, { brief: null, recognized: true }, `${token} is a decision: silent AND recognized`);
    assert.ok(
      logs.some((l) => l.includes(`gmail triage: ${token} [abc123] — filed silently`)),
      `${token} must keep its exact log line`,
    );
    assert.equal(warns.length, 0, `${token} is normal operation — nothing to warn about`);
  }
}

/** A well-formed brief is returned untouched, no retry. */
async function testNotifyPassesThrough(): Promise<void> {
  let runs = 0;
  const { result } = await capture(() =>
    resolveTriageOutcome({
      lane: "gmail triage",
      messageId: "abc123",
      run: async () => {
        runs++;
        return { ok: true, text: NOTIFY_BRIEF };
      },
    }),
  );
  assert.equal(runs, 1);
  assert.deepEqual(result, { brief: NOTIFY_BRIEF, recognized: true });
}

/** (b) An unrecognized result RETRIES, and a good retry wins — no fallback ping. */
async function testUnrecognizedRetrySucceeds(): Promise<void> {
  let runs = 0;
  const { result } = await capture(() =>
    resolveTriageOutcome({
      lane: "gmail triage",
      messageId: "19fb0b18a482f4bf",
      run: async () => {
        runs++;
        return runs === 1 ? { ok: true, text: "" } : { ok: true, text: NOTIFY_BRIEF };
      },
    }),
  );
  assert.equal(runs, 2, "an unreadable first result must be retried exactly once");
  assert.deepEqual(result, { brief: NOTIFY_BRIEF, recognized: true });
}

/** (b) Unrecognized twice → NOT silent. Loud warn + an honest notify brief. */
async function testUnrecognizedTwiceSurfaces(): Promise<void> {
  let runs = 0;
  const { result, logs, warns } = await capture(() =>
    resolveTriageOutcome({
      lane: "gmail triage",
      messageId: "19fb0b18a482f4bf",
      run: async () => {
        runs++;
        return { ok: true, text: "   " };
      },
      describe: async () => ({
        subject: "Delivered: your Amazon order",
        from: "Amazon <ship-confirm@amazon.com>",
        link: "https://mail.google.com/mail/u/0/#all/19fb0b18a482f4bf",
      }),
    }),
  );
  assert.equal(runs, 2, "exactly one retry, then a decision");
  assert.ok(result.brief, "an unreadable verdict must NOT come back as silence — this is the whole defect");
  assert.equal(result.recognized, false, "we still never learned the verdict: the poller must keep it retryable");
  assert.equal(classifyTriageOutput(result.brief!).kind, "notify", "the fallback must be a well-formed NOTIFY brief");
  assert.match(result.brief!, /triage couldn't classify/i, "the brief must be honest that triage failed");
  assert.match(result.brief!, /Delivered: your Amazon order/, "subject carries through for context");
  assert.match(result.brief!, /ship-confirm@amazon\.com/, "sender carries through for context");
  assert.match(result.brief!, /📧 https:\/\/mail\.google\.com/, "the email link rides along, per the skill contract");
  assert.ok(
    warns.some((w) => /NO VERDICT after 2 attempts \[19fb0b18a482f4bf\]/.test(w)),
    "the give-up must be a warn, unmistakable in the log",
  );
  assert.ok(
    !logs.some((l) => l.includes("filed silently")),
    "an unreadable verdict must never be logged as a silent filing",
  );
}

/** A describe() that blows up must not turn a surfaced email back into silence. */
async function testFallbackSurvivesDescribeFailure(): Promise<void> {
  const { result } = await capture(() =>
    resolveTriageOutcome({
      lane: "outlook triage",
      messageId: "<m@cu>",
      run: async () => ({ ok: true, text: "?" }),
      describe: async () => {
        throw new Error("mail.app is busy");
      },
    }),
  );
  assert.ok(result.brief && classifyTriageOutput(result.brief).kind === "notify");
  assert.equal(result.recognized, false);
}

/**
 * A run that produced NOTHING is an infrastructure failure, not a verdict: no fabricated
 * ping (a dead classifier would otherwise ping once per inbound email), but explicitly
 * NOT recognized, so the poller keeps it retryable instead of burning it.
 */
async function testRunFailureIsUnrecognized(): Promise<void> {
  const { result, warns } = await capture(() =>
    resolveTriageOutcome({
      lane: "gmail triage",
      messageId: "abc123",
      run: async () => ({ ok: false, text: "" }),
    }),
  );
  assert.deepEqual(result, { brief: null, recognized: false });
  assert.ok(warns.some((w) => /run failed.*left unseen for retry/.test(w)));
}

function testUnrecognizedBriefShape(): void {
  const bare = unrecognizedBrief("xyz");
  assert.equal(classifyTriageOutput(bare).kind, "notify", "even with zero metadata it must be a valid brief");
  assert.match(bare, /xyz/, "with no subject/sender, the id is the only handle they have");
  assert.ok(!bare.includes("links:"), "no link known → no empty links block");
}

async function main(): Promise<void> {
  testClassification();
  await testDecisionsStillFileSilently();
  await testNotifyPassesThrough();
  await testUnrecognizedRetrySucceeds();
  await testUnrecognizedTwiceSurfaces();
  await testFallbackSurvivesDescribeFailure();
  await testRunFailureIsUnrecognized();
  testUnrecognizedBriefShape();
  console.log("verdict.test.ts: all triage verdict tests passed");
}

void main();
