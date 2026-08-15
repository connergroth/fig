import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";
import { log, warn } from "../core/log";

/**
 * Durable delivery ledger for SETTLED background job results.
 *
 * The bug this exists for: a coding job settles, and seconds later the process exits on a code
 * reload that had been parked waiting for the job board to clear — opened by that job's own
 * completion. The result exists (edits on disk, the result string on the job) and the wake has
 * been created as a synthetic inbound, but nothing has become a turn yet. Both halves of that
 * state are memory-only: the job registry (jobs.ts) and the pending synthetic inbound (the
 * Conversation's buffer), so the restart drops both. The owner is never told the job finished,
 * and the job isn't even listable afterwards.
 *
 * So a settled result now lands HERE — on disk, marked undelivered — in the same synchronous
 * beat that flips the job out of "running". That gives two things the in-memory path can't:
 *
 *  1. A DRAIN SIGNAL for the reload gate (index.ts). `undeliveredJobResultIds()` is non-empty
 *     from the instant a job settles until the wake is actually consumed into a turn, which is
 *     exactly the settle → debounce → turn window a restart can land in.
 *  2. A SAFETY NET. If the process goes down in that window anyway (a bounded-out reload, a
 *     crash, a kill), boot re-reads this file and re-delivers whatever is still undelivered,
 *     and rehydrates the job registry so mcp__jobs__list / mcp__jobs__check can still see it.
 *
 * Delivery is idempotent on the job id: `markJobResultDelivered` is called when the wake is
 * CONSUMED into a turn (session.ts flush), not when it's enqueued, so a restart mid-window
 * re-delivers while a restart after consumption never does. Records are retained (delivered
 * flag and all) for RETAIN_MS so the registry entry outlives a restart the same way it
 * outlives a turn, then pruned.
 *
 * Same file-backed pattern as every other small registry under `config.stateDir` (reminders,
 * watches, bg-reply guids): core/jsonStore's atomic read/write, malformed file → empty. There
 * is deliberately NO in-memory cache — the file is the source of truth, which is what makes
 * "did this survive a restart" a real question with a real answer, and the read only happens
 * on settle, on consumption, on a pending reload tick, and at boot.
 */

const STORE_FILE = path.join(config.stateDir, "pending-job-results.json");

/** How long a settled record is kept (delivered or not). Mirrors jobs.ts's RETAIN_FINISHED_MS
 *  on purpose: a restored record should stay listable for exactly as long as a live one would. */
const RETAIN_MS = 30 * 60 * 1000;

/**
 * An undelivered wake older than this is dropped instead of re-delivered. Waking fig at 9am to
 * relay a job that finished at 2am is noise, not a rescue — and it also bounds the file if a
 * pathological record could never be consumed.
 */
const MAX_REDELIVERY_AGE_MS = 12 * 60 * 60 * 1000;

/** Hard cap on re-delivery attempts for one record, so a wedged wake can't loop forever. */
const MAX_REDELIVERIES = 3;

export interface PendingJobResult {
  /** The job id (browse-3, claude-code-2). The idempotency key — one record per job. */
  id: string;
  label: string;
  task: string;
  status: "done" | "failed";
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt: number;
  /** Set when the wake was CONSUMED into a turn. Undefined = still owed to the owner. */
  deliveredAt?: number;
  /** How many times this wake has been re-injected after a restart. */
  redeliveries?: number;
}

function read(): PendingJobResult[] {
  return readJsonArray<PendingJobResult>(STORE_FILE).filter((r) => r && typeof r.id === "string");
}

function write(records: PendingJobResult[]): void {
  try {
    writeJson(STORE_FILE, records);
  } catch (e) {
    // Persistence is the safety net, never the primary path — a failed write must not break
    // the live notify (which is already in flight by the time we get here).
    warn(`jobResults: persist failed (${e}) — this result won't survive a restart`);
  }
}

/** Drop records past their retention window. Returns the kept list. */
function prune(records: PendingJobResult[], now = Date.now()): PendingJobResult[] {
  return records.filter((r) => now - (r.finishedAt || r.startedAt || now) <= RETAIN_MS);
}

/**
 * Record a settled job result as UNDELIVERED, before its wake is pushed into the conversation.
 * Called synchronously from settle() so there is no instant where the job board looks clear
 * while an undelivered result exists — that gap is the whole bug.
 */
export function recordSettledJobResult(entry: Omit<PendingJobResult, "deliveredAt" | "redeliveries">): void {
  const kept = prune(read()).filter((r) => r.id !== entry.id);
  kept.push({ ...entry });
  write(kept);
}

/**
 * Mark a wake as delivered — i.e. it was consumed into a turn, so fig has actually seen it.
 * Idempotent and safe on an unknown id (a wake with no record, e.g. a detached specialist
 * result, is a no-op).
 */
export function markJobResultDelivered(id: string): void {
  const records = prune(read());
  const record = records.find((r) => r.id === id);
  if (!record || record.deliveredAt) return;
  record.deliveredAt = Date.now();
  write(records);
}

/**
 * Undo a delivery mark, because the turn that consumed the wake was ABORTED and its items were
 * re-queued (session.ts's abort-and-fold: the owner sends something while a turn is warm, the turn
 * is cancelled, and everything in the bundle is unshifted back onto the buffer to re-run).
 *
 * Without this the ledger says "delivered" while the wake is in fact still sitting on the
 * debounce timer waiting to re-run — which re-opens the exact hole this file exists to close:
 * the hot-reload gate reads `undeliveredJobResultIds()` as clear and a parked reload can fire
 * in that window, and boot then has nothing to re-deliver. Narrow window, but the trigger is
 * the same one as the original bug (a job settling right as the gate opens), so it gets closed
 * the same way. No-op on an unknown id or one that was never marked.
 */
export function restoreJobResultUndelivered(id: string): void {
  const records = prune(read());
  const record = records.find((r) => r.id === id);
  if (!record?.deliveredAt) return;
  delete record.deliveredAt;
  write(records);
}

/** Every settled result still owed to the owner, oldest first. */
export function undeliveredJobResults(): PendingJobResult[] {
  return read()
    .filter((r) => !r.deliveredAt)
    .sort((a, b) => a.finishedAt - b.finishedAt);
}

/** Job ids of results still owed to the owner — the reload gate's drain signal. */
export function undeliveredJobResultIds(): string[] {
  return undeliveredJobResults().map((r) => r.id);
}

/** Every retained record (delivered or not) — used to rehydrate the job registry on boot. */
export function retainedJobResults(): PendingJobResult[] {
  const records = read();
  const kept = prune(records);
  if (kept.length !== records.length) write(kept);
  return kept;
}

/**
 * Drop the undelivered wakes without delivering them. Wired to the "stop" kill switch, which
 * already clears the buffered synthetic inbound: without this, a result the owner explicitly
 * stopped would come back hours later on the next restart. Deliberate and logged.
 */
export function discardUndeliveredJobResults(reason: string): number {
  const records = prune(read());
  const undelivered = records.filter((r) => !r.deliveredAt);
  if (undelivered.length === 0) return 0;
  const now = Date.now();
  for (const r of undelivered) r.deliveredAt = now;
  write(records);
  log(`jobResults: discarded ${undelivered.length} undelivered result(s) (${reason}): ${undelivered.map((r) => r.id).join(", ")}`);
  return undelivered.length;
}

/** Count a re-delivery attempt. Returns false when the record is too old / too retried to send. */
export function noteRedelivery(id: string, now = Date.now()): boolean {
  const records = prune(read());
  const record = records.find((r) => r.id === id);
  if (!record) return false;
  const attempts = (record.redeliveries ?? 0) + 1;
  const tooOld = now - record.finishedAt > MAX_REDELIVERY_AGE_MS;
  const tooMany = attempts > MAX_REDELIVERIES;
  record.redeliveries = attempts;
  if (tooOld || tooMany) {
    record.deliveredAt = now; // give up on it rather than looping forever
    write(records);
    warn(`jobResults: giving up on ${id} (${tooOld ? "older than the redelivery window" : `${attempts} attempts`})`);
    return false;
  }
  write(records);
  return true;
}

/** Human-readable gap, e.g. "40s" / "12m" / "3h". For the late-delivery wake text. */
export function ago(from: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * The synthetic-inbound text for a settled job. `late` = this is a re-delivery after a restart
 * ate the first attempt, so the text says so instead of claiming the job finished "a moment
 * ago". The non-late strings are byte-identical to what settle() has always sent.
 */
export function jobWakeText(entry: PendingJobResult, opts: { late?: boolean; now?: number } = {}): string {
  const { label, id, result, error } = entry;
  if (!opts.late) {
    return entry.status === "done"
      ? `[the ${label} job you started a moment ago (${id}) just finished. use it if it's still relevant; ` +
          `if your latest message already moved on, reply with exactly [no reply] and nothing is sent.\n\n${result}]`
      : `[the ${label} job ${id} failed before returning (${error}). ` +
          `tell the owner only if they're still waiting on it; otherwise reply with exactly [no reply].]`;
  }
  const when = ago(entry.finishedAt, opts.now);
  return entry.status === "done"
    ? `[the ${label} job ${id} finished ${when} ago, right before fig restarted, so its result was never relayed. ` +
        `relay it now if the owner is still waiting on it; if the conversation has moved on, reply with exactly [no reply].\n\n${result}]`
    : `[the ${label} job ${id} failed ${when} ago (${error}), right before fig restarted, so it was never relayed. ` +
        `tell the owner only if they're still waiting on it; otherwise reply with exactly [no reply].]`;
}

/** Test seam: the on-disk path, so a test can assert the file itself. */
export const JOB_RESULTS_FILE = STORE_FILE;
