import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Transport } from "../transport/types";

/**
 * Regressions for the silent loss of a background job's result.
 *
 * The shape of it: a coding job settles (its edits already on disk), and a code reload parked
 * on the job board exits the process three seconds later — opened by that job's own completion.
 * The wake it created was a synthetic inbound on a ~2.5s debounce, so it had not become a turn
 * yet; the registry entry and the wake are both memory-only, and both die with the process. The
 * owner is never told, and mcp__jobs__list can't even show the job afterwards.
 *
 * Two things are asserted here:
 *  (a) the reload gate refuses to exit while a settled result hasn't been consumed into a turn,
 *      including at the exact moment `hasRunningJobs()` goes false — and bounds that wait;
 *  (b) an undelivered result written before a restart is re-delivered exactly once after it,
 *      never twice, and the job stays visible on the board across the restart.
 *
 * (b) uses a real child process for the "restart" — same module code, fresh module state, same
 * on-disk store — because "did this survive a process boundary" is the entire question.
 */

// ---------------------------------------------------------------------------------------------
// Child mode: this file re-executes itself as the RESTARTED process (see restartProbe below).
// ---------------------------------------------------------------------------------------------
async function childBoot(): Promise<void> {
  const { setBackgroundInjector } = await import("./detach");
  const { jobsServerDef, listJobs, restoreJobsFromDisk } = await import("./jobs");
  const { markJobResultDelivered } = await import("./jobResults");

  const injected: { text: string; jobResultId?: string }[] = [];
  setBackgroundInjector((text, meta) => {
    injected.push({ text, jobResultId: meta?.jobResultId });
  });

  restoreJobsFromDisk();

  const check = jobsServerDef.capabilities.find((c) => c.name === "check");
  const checked = check ? await check.handler({ id: process.env.FIG_TEST_CHECK_ID ?? "" }) : "";

  // Simulate the Conversation consuming the wake into a turn (session.ts flush does exactly
  // this), but only when asked — so a boot can also be tested WITHOUT consumption.
  if (process.env.FIG_TEST_CONSUME === "1") {
    for (const i of injected) if (i.jobResultId) markJobResultDelivered(i.jobResultId);
  }

  process.stdout.write(
    `${JSON.stringify({ injected, jobs: listJobs().map((j) => ({ id: j.id, status: j.status, notified: j.notified })), checked })}\n`,
  );
}

interface BootResult {
  injected: { text: string; jobResultId?: string }[];
  jobs: { id: string; status: string; notified: boolean }[];
  checked: string;
}

/** Boot a fresh process against the same brain dir — a real restart. */
function restartProbe(brain: string, opts: { consume?: boolean; checkId?: string } = {}): BootResult {
  const out = execFileSync(process.execPath, ["--import", "tsx", __filename], {
    env: {
      ...process.env,
      BRAIN_DIR: brain,
      FIG_JOBRESULTS_CHILD: "1",
      FIG_TEST_CONSUME: opts.consume ? "1" : "0",
      FIG_TEST_CHECK_ID: opts.checkId ?? "",
    },
    encoding: "utf8",
  });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line) as BootResult;
}

// ---------------------------------------------------------------------------------------------
// (a) The reload gate must not exit while a job result is pending delivery.
// ---------------------------------------------------------------------------------------------
async function testReloadGate(): Promise<void> {
  const { ReloadGate } = await import("../session/reloadGate");

  let now = 1_000_000;
  const logs: string[] = [];
  const warns: string[] = [];
  const gate = new ReloadGate({
    now: () => now,
    maxInjectionWaitMs: 90_000,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  // A clear board still restarts immediately — the normal path is untouched.
  assert.equal(gate.ready({ idle: true, jobsRunning: false, undeliveredResults: [] }), true);

  // The two original signals still hold a reload off, and neither is bounded.
  assert.equal(gate.ready({ idle: false, jobsRunning: false, undeliveredResults: [] }), false);
  assert.equal(gate.ready({ idle: true, jobsRunning: true, undeliveredResults: [] }), false);
  now += 10 * 60 * 1000;
  assert.equal(
    gate.ready({ idle: true, jobsRunning: true, undeliveredResults: [] }),
    false,
    "a running job must never be cut short by a reload, however long it takes",
  );

  // THE regression. This is the 00:31:38 state: the job has left "running" (so the gate's old
  // second signal is clear) and the conversation looks idle, but its result is still an
  // un-consumed synthetic inbound. Exiting here is the silent loss.
  const pending = { idle: true, jobsRunning: false, undeliveredResults: ["claude-code-2"] };
  assert.equal(gate.ready(pending), false, "must not exit while a settled job result is undelivered");
  now += 3_000; // the few seconds between a settle and a restart that lands on top of it
  assert.equal(gate.ready(pending), false, "3s later — still inside the window a restart lands in");
  now += 60_000;
  assert.equal(gate.ready(pending), false, "still inside the bounded wait");
  assert.ok(
    logs.some((l) => /deferring restart until a finished job's result reaches the owner \(claude-code-2\)/.test(l)),
    `expected a defer log naming the blocking job, got: ${JSON.stringify(logs)}`,
  );
  assert.equal(warns.length, 0, "nothing loud until the bound is actually hit");

  // Draining releases it — and the wait resets, so the next pending result gets a full window.
  assert.equal(gate.ready({ idle: true, jobsRunning: false, undeliveredResults: [] }), true);

  // The bound: a wedged injection cannot hold a reload off forever, and proceeding is LOUD and
  // names the ids being left to the boot-time re-delivery.
  assert.equal(gate.ready(pending), false);
  now += 89_999;
  assert.equal(gate.ready(pending), false, "one ms short of the bound must still defer");
  now += 1;
  assert.equal(gate.ready(pending), true, "the injection wait is bounded so a wedge can't block reloads forever");
  assert.equal(warns.length, 1, `expected exactly one loud warning, got: ${JSON.stringify(warns)}`);
  assert.match(warns[0], /claude-code-2/);
  assert.match(warns[0], /re-delivered on boot/);

  console.log("✓ reload gate: waits for the injection queue to drain, bounded and loud");
}

// ---------------------------------------------------------------------------------------------
// (a2) The wiring: settling a real job must produce that gate-blocking state, in the same beat
//      the job board goes clear.
// ---------------------------------------------------------------------------------------------
async function testSettleBlocksTheGate(): Promise<void> {
  const { setBackgroundInjector } = await import("./detach");
  const { hasRunningJobs, launchJob, undeliveredResultIds } = await import("./jobs");
  const { markJobResultDelivered } = await import("./jobResults");
  const { ReloadGate } = await import("../session/reloadGate");

  const injected: { text: string; jobResultId?: string }[] = [];
  setBackgroundInjector((text, meta) => injected.push({ text, jobResultId: meta?.jobResultId }));

  let release: (v: string) => void = () => {};
  const job = launchJob({
    label: "claude-code",
    task: "build the maps tool",
    run: () => new Promise<string>((resolve) => (release = resolve)),
  });
  assert.equal(hasRunningJobs(), true);

  release("(no answer from the claude-code specialist)");
  await new Promise((r) => setTimeout(r, 10));

  // The exact instant that loses work: nothing running, nothing buffered yet, result owed.
  assert.equal(hasRunningJobs(), false, "the job settled, so the old gate's job signal is clear");
  assert.deepEqual(undeliveredResultIds(), [job.id], "the settled result is on disk, marked undelivered");
  assert.equal(injected.length, 1, "the wake still fires immediately — unchanged normal path");
  assert.equal(injected[0].jobResultId, job.id, "the wake carries its job id so consumption can settle the ledger");
  assert.match(injected[0].text, /just finished/, "the live wake text is unchanged");
  assert.match(injected[0].text, /\(no answer from the claude-code specialist\)/);

  const gate = new ReloadGate({ log: () => {}, warn: () => {} });
  assert.equal(
    gate.ready({ idle: true, jobsRunning: hasRunningJobs(), undeliveredResults: undeliveredResultIds() }),
    false,
    "a reload queued before this job settled must NOT exit on the job's own completion",
  );

  // Consumption (what flush() does when the wake becomes a turn) is what releases the gate.
  markJobResultDelivered(job.id);
  assert.deepEqual(undeliveredResultIds(), []);
  assert.equal(gate.ready({ idle: true, jobsRunning: false, undeliveredResults: undeliveredResultIds() }), true);

  setBackgroundInjector(null);
  console.log("✓ settle: records the result before the job board reads clear, and holds the reload gate");
}

/**
 * Reading a finished job with mcp__jobs__check IS delivery (fig has the result in hand), so it
 * has to settle the ledger too — otherwise the gate would keep waiting on a result already read,
 * and boot would relay it a second time.
 */
async function testPollCountsAsDelivery(): Promise<void> {
  const { setBackgroundInjector } = await import("./detach");
  const { jobsServerDef, launchJob, undeliveredResultIds } = await import("./jobs");

  setBackgroundInjector(null); // no conversation wired — the wake can't be pushed at all
  const job = launchJob({ label: "browse", task: "read the cart", run: async () => "total is $20.26" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    undeliveredResultIds(),
    [job.id],
    "with nothing wired to receive the wake, the result is still owed — that used to be a silent drop",
  );

  const check = jobsServerDef.capabilities.find((c) => c.name === "check");
  assert.ok(check);
  const out = await check.handler({ id: job.id });
  assert.match(out, /total is \$20\.26/);
  assert.deepEqual(undeliveredResultIds(), [], "a poll settles the ledger, so nothing is re-delivered on boot");

  console.log("✓ jobs__check: polling a finished job settles its ledger entry");
}

/**
 * The Conversation half of the wiring: a job's wake carries its id into the buffered synthetic
 * inbound (so consuming it can settle the ledger), and the "stop" kill switch — which throws
 * that buffered item away — retires the ledger entry with it rather than leaving a result to
 * reappear hours later on the next restart.
 */
async function testConversationWiring(): Promise<void> {
  const { injectBackground, setBackgroundInjector } = await import("./detach");
  const { recordSettledJobResult, undeliveredJobResultIds } = await import("./jobResults");
  const { Conversation } = await import("../session/session");

  const sends: string[] = [];
  const transport = {
    send: async (_to: string, text: string) => {
      sends.push(text);
      return "guid-jobresults-test";
    },
  } as Transport;

  const convo = new Conversation(transport, "+15555550123");
  const state = convo as unknown as { buffer: { text: string; jobResultId?: string }[]; debounce: NodeJS.Timeout | null };

  recordSettledJobResult({
    id: "claude-code-77",
    label: "claude-code",
    task: "wire the ledger",
    status: "done",
    result: "done and tested",
    startedAt: Date.now() - 5_000,
    finishedAt: Date.now(),
  });
  assert.equal(injectBackground("[the claude-code job …]", { jobResultId: "claude-code-77" }), true);
  assert.equal(state.buffer.length, 1);
  assert.equal(
    state.buffer[0].jobResultId,
    "claude-code-77",
    "the buffered wake must remember which job it's relaying, or consumption can't settle the ledger",
  );
  assert.deepEqual(undeliveredJobResultIds(), ["claude-code-77"], "still owed while it sits on the debounce timer");

  // A bare "stop" clears the buffer — the wake dies there, so the ledger entry must die too.
  (convo as unknown as { killAll: () => void }).killAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(state.buffer, []);
  assert.deepEqual(
    undeliveredJobResultIds(),
    [],
    "stop must retire the ledger entry too — a stopped result reappearing after a restart is worse than losing it",
  );
  if (state.debounce) clearTimeout(state.debounce);
  setBackgroundInjector(null);

  console.log("✓ conversation: the wake carries its job id, and stop retires the ledger entry");
}

/**
 * Abort-and-fold must not silently consume a job wake.
 *
 * The real miss: a job settles, the owner sends a message seconds later, and flush() cancels the
 * warm turn to fold it in. The bundle was already marked delivered when it committed to that
 * turn — but the turn is thrown away and its items unshifted back onto the buffer, so the wake
 * was NOT actually relayed. The ledger claiming delivery in
 * that window is the same hole this file exists to close: the reload gate reads it as clear, and
 * a reload landing there leaves boot with nothing to re-deliver.
 */
async function testAbortAndFoldReopensTheDebt(): Promise<void> {
  const { markJobResultDelivered, recordSettledJobResult, restoreJobResultUndelivered, undeliveredJobResultIds } =
    await import("./jobResults");

  recordSettledJobResult({
    id: "claude-code-10",
    label: "claude-code",
    task: "root-cause the call drop",
    status: "done",
    result: "committed as ca4049b",
    startedAt: Date.now() - 11 * 60_000,
    finishedAt: Date.now(),
  });

  // The bundle commits to a turn — flush() settles the ledger here.
  markJobResultDelivered("claude-code-10");
  assert.deepEqual(undeliveredJobResultIds(), [], "committing to a turn settles it");

  // …then the owner's message lands mid-turn and the turn is aborted, re-queueing its items.
  restoreJobResultUndelivered("claude-code-10");
  assert.deepEqual(
    undeliveredJobResultIds(),
    ["claude-code-10"],
    "an aborted turn puts the wake back on the buffer, so the debt is owed again until it truly runs",
  );

  // The re-run consumes it for real. Now it's settled for good, and idempotently.
  markJobResultDelivered("claude-code-10");
  assert.deepEqual(undeliveredJobResultIds(), [], "the re-run settles it");
  restoreJobResultUndelivered("unknown-job-999");
  assert.deepEqual(undeliveredJobResultIds(), [], "restoring an unknown id is a no-op");

  console.log("✓ abort-and-fold: a cancelled turn re-owes its job wake instead of eating it");
}

// ---------------------------------------------------------------------------------------------
// (b) Re-delivery across a real restart: exactly once, and the registry entry survives.
// ---------------------------------------------------------------------------------------------
async function testRedeliveryAcrossRestart(brain: string): Promise<void> {
  const { recordSettledJobResult, JOB_RESULTS_FILE } = await import("./jobResults");

  // The pre-restart state: a job settled and its wake never became a turn (settle() writes
  // exactly this — see testSettleBlocksTheGate).
  const finishedAt = Date.now() - 4_000;
  recordSettledJobResult({
    id: "claude-code-42",
    label: "claude-code",
    task: "build a clean first-class fig tool for google maps traffic",
    status: "done",
    result: "built src/maps/directions.ts + the tool wrapper",
    startedAt: finishedAt - 700_000,
    finishedAt,
  });

  // Restart #1 — the process that comes up after the reload.
  const boot1 = restartProbe(brain, { consume: true, checkId: "claude-code-42" });
  assert.equal(boot1.injected.length, 1, `the un-relayed result must be re-delivered once: ${JSON.stringify(boot1.injected)}`);
  assert.equal(boot1.injected[0].jobResultId, "claude-code-42");
  assert.match(boot1.injected[0].text, /right before fig restarted/, "a late wake must not claim the job 'just finished'");
  assert.match(boot1.injected[0].text, /built src\/maps\/directions\.ts/, "the actual result has to come with it");
  // The registry entry survived, so the board can still answer for it.
  const listed = boot1.jobs.find((j) => j.id === "claude-code-42");
  assert.ok(listed, `mcp__jobs__list must still see a job that settled just before the restart: ${JSON.stringify(boot1.jobs)}`);
  assert.equal(listed.status, "done");
  assert.match(boot1.checked, /claude-code-42 done/, "mcp__jobs__check must still return its result after a restart");
  assert.match(boot1.checked, /built src\/maps\/directions\.ts/);

  const afterBoot1 = JSON.parse(fs.readFileSync(JOB_RESULTS_FILE, "utf8")) as { id: string; deliveredAt?: number }[];
  const record = afterBoot1.find((r) => r.id === "claude-code-42");
  assert.ok(record?.deliveredAt, "consuming the re-delivered wake must mark the ledger entry delivered");

  // Restart #2 — must NOT deliver it again. This is the whole point of the ledger: a result is
  // relayed exactly once across a restart, never duplicated.
  const boot2 = restartProbe(brain, { consume: true, checkId: "claude-code-42" });
  assert.deepEqual(boot2.injected, [], "a delivered result must never be re-delivered a second time");
  const stillListed = boot2.jobs.find((j) => j.id === "claude-code-42");
  assert.ok(stillListed, "the job stays listable for its retention window even once relayed");
  assert.equal(stillListed.notified, true);

  console.log("✓ restart: an un-relayed result is re-delivered exactly once, and the job board survives");
}

/** A boot that is interrupted AGAIN before consuming keeps owing the result — no silent drop. */
async function testUnconsumedRestartStillOwes(brain: string): Promise<void> {
  const { recordSettledJobResult } = await import("./jobResults");
  const finishedAt = Date.now() - 1_000;
  recordSettledJobResult({
    id: "browse-9",
    label: "browse",
    task: "grab the cart total",
    status: "failed",
    error: "chrome went away",
    startedAt: finishedAt - 60_000,
    finishedAt,
  });

  // No checkId here on purpose: reading a finished job with mcp__jobs__check counts as delivery
  // (markPolled), which is the very thing this case must NOT do.
  const boot1 = restartProbe(brain, { consume: false });
  assert.equal(boot1.injected.length, 1, "a failed job's result is owed just like a successful one");
  assert.match(boot1.injected[0].text, /chrome went away/);

  // It was injected but never consumed (restart #2 landed in the same window), so it is still
  // owed — losing it here would be the original bug wearing a different hat.
  const boot2 = restartProbe(brain, { consume: true });
  assert.equal(boot2.injected.length, 1, "a wake that was never consumed must still be owed after another restart");

  const boot3 = restartProbe(brain, { consume: true });
  assert.deepEqual(boot3.injected, [], "...and once consumed, it stops being owed");

  console.log("✓ restart: an injected-but-unconsumed wake is still owed; consumption is what settles it");
}

async function main(): Promise<void> {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "fig-jobresults-test-"));
  process.env.BRAIN_DIR = brain; // read at module load by core/config → stateDir
  try {
    await testReloadGate();
    await testSettleBlocksTheGate();
    await testPollCountsAsDelivery();
    await testConversationWiring();
    await testAbortAndFoldReopensTheDebt();
    await testRedeliveryAcrossRestart(brain);
    await testUnconsumedRestartStillOwes(brain);
    console.log("jobResults + reloadGate: all checks passed");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
}

void (process.env.FIG_JOBRESULTS_CHILD === "1" ? childBoot() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
