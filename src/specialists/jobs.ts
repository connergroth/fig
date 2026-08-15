import { z } from "zod";

import { log, warn } from "../core/log";
import { defineServer, toSdkServer } from "../tools/define";
import { injectBackground } from "./detach";
import {
  jobWakeText,
  markJobResultDelivered,
  noteRedelivery,
  recordSettledJobResult,
  retainedJobResults,
  undeliveredJobResults,
  undeliveredJobResultIds,
  type PendingJobResult,
} from "./jobResults";

/**
 * Fully-async background jobs — the decoupled-from-the-turn execution model.
 *
 * The problem this solves (distinct from detach.ts): the browser specialist is the one
 * long, flaky, ban-risky specialist. As a BLOCKING tool call it parks the live turn for
 * its whole run, fig can't see it's even alive, and — worst of all — a new message tears
 * the turn down and kills the in-flight browser child with it. detach.ts patches the
 * interrupt case, but the call is still fundamentally turn-bound: born inside the turn,
 * dies with it.
 *
 * A background job inverts that. launchJob() starts the work under its OWN AbortController
 * and a module-level registry that outlives any turn, then returns IMMEDIATELY with a
 * handle. The launching tool call returns in milliseconds, so the turn ends cleanly and
 * is never blocked. The job keeps running in this long-lived process, referenced by the
 * registry (never GC'd, never tied to the turn's abort). It survives across message
 * branches/interrupts by construction — no turn owns it.
 *
 * When a job settles it does two things: stores its result/error for on-demand polling
 * (status / check tools), AND pushes the result back into the conversation as a soft
 * inbound so fig is woken to relay it. Whichever path delivers first (push on completion,
 * or a manual poll) marks the job notified so the other becomes a no-op — fig sees each
 * result exactly once.
 *
 * Only the browser specialist runs this way today; the quick specialists (email, calendar,
 * music, codex) stay blocking-with-detach since they return in seconds.
 */

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface BackgroundJob {
  id: string;
  /** Job family, e.g. "browse" — used to scope listings per specialist. */
  label: string;
  /** The natural-language task it's running, for the status readout. */
  task: string;
  status: JobStatus;
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /**
   * Short human-readable "what it's doing right now" — last tool call / browser action /
   * bash command, overwritten in place as the job progresses (never accumulated into a
   * log). Lets jobs_check tell a stuck job (hung on a selector, retrying a flaky command)
   * apart from one that's actively working, without paying for a full transcript.
   */
  lastAction?: string;
  /** When lastAction was last updated. */
  lastActionAt?: number;
  /** True once fig has been handed the finished result (via push OR poll), so it's relayed once. */
  notified: boolean;
  controller: AbortController;
}

/** Live + recently-finished jobs, keyed by id. Pruned lazily (see pruneOld). */
const jobs = new Map<string, BackgroundJob>();
let counter = 0;

/** Keep finished jobs around this long so a late poll can still read the result. */
const RETAIN_FINISHED_MS = 30 * 60 * 1000;

function pruneOld(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== "running" && j.finishedAt && now - j.finishedAt > RETAIN_FINISHED_MS) {
      jobs.delete(id);
    }
  }
}

function settle(job: BackgroundJob, status: "done" | "failed", result?: string, error?: string): void {
  // Already killed (or somehow double-settled) — don't clobber a terminal state.
  if (job.status !== "running") return;
  job.status = status;
  job.finishedAt = Date.now();
  if (result !== undefined) job.result = result;
  if (error !== undefined) job.error = error;
  log(`background job ${job.id} ${status}${error ? `: ${error}` : ""}`);

  // Push the result back so fig wakes and relays it — unless a poll already delivered it, or
  // this is a `silent` job that reports its own output out-of-band (a /btw replies to the owner
  // directly, so there's nothing owed to the main conversation and nothing to persist).
  if (job.notified) return;

  // Persist FIRST, undelivered — synchronously, in the same beat that took this job out of
  // "running". The reload gate reads the job board and this ledger from the poll loop, so there
  // must be no instant where the board looks clear and the owed result is invisible — that
  // instant is where a reload exits the process seconds after a job settles, losing its work.
  const record: PendingJobResult = {
    id: job.id,
    label: job.label,
    task: job.task,
    status,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? Date.now(),
  };
  recordSettledJobResult(record);

  // The wake text is unchanged from before this ledger existed (see jobResults.jobWakeText).
  // `notified` still means "fig has been handed this" for the purposes of suppressing a second
  // push; the ledger separately tracks whether it was actually CONSUMED into a turn, which is a
  // stronger claim and the one that survives a restart.
  if (injectBackground(jobWakeText(record), { jobResultId: job.id })) job.notified = true;
}

/**
 * Rehydrate the job board + re-deliver anything owed, at boot.
 *
 * Two independent losses are repaired here. First, the registry: `jobs` is memory-only, so a
 * job that settled seconds before a restart wasn't merely un-relayed, it was un-listable —
 * mcp__jobs__list showed nothing and mcp__jobs__check said "no job with id claude-code-2" for
 * work that had in fact completed and written files. Retained records come back as real (
 * finished) registry entries. Second, the wake: any result never consumed into a turn is
 * re-injected, with text that says it's late rather than pretending the job just finished.
 *
 * Idempotent across restarts by construction: the ledger marks a record delivered when its wake
 * is CONSUMED (session.ts), so a boot after delivery re-injects nothing, while a boot that
 * interrupted the window re-injects exactly once. Called once from index.ts after the
 * Conversation is wired (it's the injector), and a no-op when there's nothing owed.
 */
export function restoreJobsFromDisk(): { restored: number; redelivered: number } {
  const retained = retainedJobResults();
  let restored = 0;
  for (const r of retained) {
    if (jobs.has(r.id)) continue; // a live job always wins over a stale record
    jobs.set(r.id, {
      id: r.id,
      label: r.label,
      task: r.task,
      status: r.status,
      result: r.result,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      // Not running, so there is nothing to abort — a fresh controller keeps cancelJob honest
      // (it returns false for a finished job) without pretending the old child is reachable.
      controller: new AbortController(),
      notified: !!r.deliveredAt,
    });
    restored += 1;
    // Never re-issue an id: `counter` restarts at 0 each boot, so a restored claude-code-2
    // would otherwise collide with the next launch's claude-code-1/2.
    const n = Number(r.id.slice(r.id.lastIndexOf("-") + 1));
    if (Number.isFinite(n) && n > counter) counter = n;
  }

  let redelivered = 0;
  for (const r of undeliveredJobResults()) {
    if (!noteRedelivery(r.id)) continue; // too old / too many attempts — dropped, logged there
    if (injectBackground(jobWakeText(r, { late: true }), { jobResultId: r.id })) {
      redelivered += 1;
      const live = jobs.get(r.id);
      if (live) live.notified = true;
    }
  }
  if (restored || redelivered) {
    log(`jobs: restored ${restored} finished job(s) from disk, re-delivering ${redelivered} un-relayed result(s)`);
  }
  return { restored, redelivered };
}

/**
 * Any settled job result that hasn't been consumed into a turn yet — the reload gate's third
 * signal. Non-empty for the whole settle → debounce → turn window, which `hasRunningJobs()`
 * reports as clear and `isIdle()` only covers while the synthetic inbound happens to still be
 * sitting in the buffer.
 */
export function undeliveredResultIds(): string[] {
  return undeliveredJobResultIds();
}

/**
 * Launch a job in the background and return its handle synchronously. `run(signal)` is a
 * factory (not a started promise) so the job owns the AbortController threaded into it —
 * that's what makes kill real (cancelJob fires it) and keeps the work off the turn's signal.
 */
export function launchJob(opts: {
  label: string;
  task: string;
  /**
   * `report` is a cheap one-liner sink threaded down into the underlying specialist/CLI —
   * call it with a short "what I'm doing now" string and it overwrites job.lastAction in
   * place. Optional to call; a job that never reports just shows no last-action, same as
   * before this existed.
   */
  run: (signal: AbortSignal, report: (action: string) => void) => Promise<string>;
  /**
   * Start pre-`notified` so settle() never pushes the result back into the main
   * conversation. For jobs that deliver their OWN output out-of-band (a /btw background
   * fig replies to the owner directly over iMessage), the completion-push would be duplicate
   * cross-talk into the main loop. The job still lists/checks/cancels like any other.
   */
  silent?: boolean;
}): BackgroundJob {
  pruneOld();
  counter += 1;
  const id = `${opts.label}-${counter}`;
  const controller = new AbortController();
  const job: BackgroundJob = {
    id,
    label: opts.label,
    task: opts.task,
    status: "running",
    startedAt: Date.now(),
    notified: !!opts.silent,
    controller,
  };
  jobs.set(id, job);
  const report = (action: string) => {
    if (job.status !== "running" || !action.trim()) return;
    job.lastAction = action.trim();
    job.lastActionAt = Date.now();
  };
  log(`background job ${id} launched: ${opts.task.slice(0, 100)}`);
  void opts.run(controller.signal, report).then(
    (result) => settle(job, "done", result),
    (e) => settle(job, "failed", undefined, String(e)),
  );
  return job;
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

/**
 * Any job still running? Used by the idle-gated hot reload (index.ts) to defer a code
 * restart while a detached async job (codex, browse) is in flight. These jobs are children
 * of THIS process, so a self-edit restart would orphan them mid-run — the registry gets
 * wiped, the child is killed, and the job never settles (no result, no error). That's the
 * cross-repo self-sabotage: launch a codex job AND edit fig's own code in the same stretch,
 * and the edit's auto-restart kills the codex job. Holding the restart until the board is
 * clear closes that hole.
 *
 * NOT sufficient on its own: this goes false the instant a job SETTLES, while its result is
 * still an un-consumed synthetic inbound. See undeliveredResultIds() — the gate needs both.
 */
export function hasRunningJobs(): boolean {
  for (const j of jobs.values()) if (j.status === "running") return true;
  return false;
}

/** All jobs (optionally filtered to one label), newest first. */
export function listJobs(label?: string): BackgroundJob[] {
  pruneOld();
  return [...jobs.values()]
    .filter((j) => !label || j.label === label)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Kill a running job: fire its controller so the underlying specialist sub-query is truly
 * aborted (the signal is threaded all the way into runClaudeText → query). Returns false
 * if there's no such job or it already finished.
 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.status = "killed";
  job.finishedAt = Date.now();
  job.notified = true; // a kill is deliberate — don't push a result back
  try {
    job.controller.abort();
  } catch {
    /* best-effort */
  }
  log(`background job ${id} killed`);
  return true;
}

/**
 * Hard-cancel every running background job — wired into the "stop" kill switch so a bare
 * "stop" nukes in-flight browser work too (not just blocking/detached specialist calls).
 * Returns how many were killed.
 */
export function cancelAllJobs(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === "running" && cancelJob(j.id)) n += 1;
  }
  if (n) log(`stop: killed ${n} running background job(s)`);
  return n;
}

/**
 * Mark a finished job as seen via a manual poll, so its completion push is suppressed
 * (fig is reading the result right now). Returns the job for convenience. A no-op on a
 * still-running job.
 */
export function markPolled(job: BackgroundJob): void {
  if (job.status === "running") return;
  job.notified = true;
  // A poll IS delivery — fig has the result in hand right now. Settle the ledger entry too,
  // or the reload gate would keep waiting on a result that's already been read and boot would
  // re-deliver it a second time.
  markJobResultDelivered(job.id);
}

/** Human-readable age, e.g. "12s" / "3m". */
export function age(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * The unified job board — one control plane over EVERY async background sink (browser, codex,
 * and any future one), instead of a duplicate jobs/check/cancel trio per specialist. The
 * registry has always been type-agnostic (jobs keyed by id, tagged with a `label`), so the
 * launch tools stay per-type (mcp__browse__use, mcp__codex__delegate — different params/meaning)
 * but list/check/cancel collapse to one set here. The id encodes the type (browse-3, codex-1)
 * and the listing shows it, so a single cancel is never ambiguous. A new sink registers in the
 * same map and is instantly listable/checkable/cancellable with zero new tools.
 */
export const jobsServerDef = defineServer({
  key: "jobs",
  kind: "direct",
  purpose: "unified control plane for every async background job (browse, code, codex) — list, read, kill; it cannot launch one",
  exposure: "both",
  capabilities: [
    {
      name: "list",
      purpose: "every async background job, running and recently finished",
      mutates: "read",
      fallback: "deny",
      fallbackReason: "main-process job registry; stdio fallback runtimes run out-of-process and would see an empty one",
      description:
        "List ALL async background jobs (browser, codex, anything) — running + recently finished, newest first. Each row shows its type via the id (browse-3, codex-1). Use to see what's still in flight and grab an id to check or cancel.",
      input: {},
      handler: async () => {
        const all = listJobs();
        if (all.length === 0) return "No background jobs (none running, none finished recently).";
        const lines = all.map((j) => {
          const when =
            j.status === "running"
              ? `running ${age(j.startedAt)}${j.lastAction ? ` — last: ${j.lastAction}` : " — no progress update yet"}`
              : `${j.status} ${age(j.finishedAt ?? j.startedAt)} ago`;
          return `• ${j.id} — ${when} — ${j.task.slice(0, 90)}`;
        });
        return lines.join("\n");
      },
    },
    {
      name: "check",
      purpose: "one job's status, result or error, by id",
      mutates: "read",
      fallback: "deny",
      fallbackReason: "main-process job registry; stdio fallback runtimes run out-of-process and would see an empty one",
      description:
        "Check one background job by id (any type): its status, and (if finished) its result or error. Reading a finished job here counts as you seeing it, so it won't ALSO get pushed back to you as a follow-up.",
      input: { id: z.string().describe("the job id, e.g. browse-3 or codex-1") },
      handler: async (args) => {
        const job = getJob(args.id);
        if (!job) return `No job with id ${args.id}. Use mcp__jobs__list to see what's running.`;
        if (job.status === "running") {
          const last = job.lastAction
            ? `last action (${age(job.lastActionAt ?? job.startedAt)} ago): ${job.lastAction}`
            : "no progress update yet";
          return `${job.id} is still running (${age(job.startedAt)}). ${last}. Task: ${job.task}`;
        }
        markPolled(job); // fig is reading it now → suppress the duplicate completion push
        if (job.status === "killed") return `${job.id} was cancelled.`;
        if (job.status === "failed") return `${job.id} failed: ${job.error}`;
        return `${job.id} done:\n\n${job.result}`;
      },
    },
    {
      name: "cancel",
      purpose: "kill a running background job by id",
      mutates: "write",
      fallback: "deny",
      fallbackReason: "main-process job registry; stdio fallback runtimes run out-of-process and would see an empty one",
      description:
        "Cancel/kill a running background job by id (any type). Truly aborts the underlying sub-query/run. No-op if it already finished.",
      input: { id: z.string().describe("the job id to kill, e.g. browse-3 or codex-1") },
      handler: async (args) => {
        const ok = cancelJob(args.id);
        return ok ? `Killed job ${args.id}.` : `Nothing to kill — ${args.id} isn't running (already done or no such job).`;
      },
    },
  ],
});

export const jobsServer = toSdkServer(jobsServerDef);
