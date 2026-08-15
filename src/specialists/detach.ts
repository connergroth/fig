import { log, warn } from "../core/log";
import { stripLoneSurrogates } from "../core/sanitize";

/**
 * Detach-on-interrupt for blocking specialist calls.
 *
 * The problem this solves: the everyday specialists (browse, email, calendar,
 * music, codex) are BLOCKING tool calls — while one runs, the live turn is parked
 * inside it at the protocol level (the model can't emit new text with an unanswered
 * tool_use outstanding). So a correction/interjection that lands mid-call can't reach
 * fig until the call returns — and if the call is hung (e.g. a flaky browser), it sits
 * behind it to the bitter end. That's the "flysoar.ai" miss: the correction queued
 * behind a hung browse call and fig finished researching the wrong site.
 *
 * The fix (see docs/interruptible-tools.md): keep the existing abort→restart machinery,
 * but when a specialist call is interrupted mid-flight, DON'T throw its work away —
 * DETACH it. Return a clearly-labelled placeholder so the turn can unwind and re-run
 * with the new message folded in, and keep the real call alive. When it settles, inject
 * its result back as a fresh inbound so fig can use it (interjection: "also, weather?")
 * or ignore it (correction: "flysoar not trysoar").
 *
 * Two pieces of module state, set by the Conversation (mirrors setApprover):
 *  - currentSignal: the live turn's AbortSignal, set per turn, so the wrapper can tell
 *    when the turn it's running under got cancelled.
 *  - injector: a persistent hook back into the Conversation, so a detached call's
 *    eventual result can be re-queued as a soft inbound once it settles.
 */
let currentSignal: AbortSignal | null = null;
let injector: BackgroundInjector | null = null;

/**
 * Provenance carried alongside a synthetic inbound. Today's only field is the background job
 * whose settled result this wake is relaying — the Conversation stamps it onto the buffered
 * item so that CONSUMING the item (it becoming a turn) is what marks that job's result
 * delivered in the durable ledger (specialists/jobResults.ts). Without the id, "was this
 * result ever actually relayed?" is unanswerable across a restart, which is how a finished
 * job's result got silently dropped by a hot reload.
 */
export interface BackgroundInjectionMeta {
  jobResultId?: string;
}

export type BackgroundInjector = (text: string, meta?: BackgroundInjectionMeta) => void;

/**
 * Live detached tasks whose eventual results are still pending injection. The "stop"
 * kill switch cancels them so their orphan results never come back. Each detached call
 * registers a small token here carrying both a `cancelled` flag (so the pending `.then`
 * injection becomes a no-op) and an `abort` hook into its own AbortController (so the
 * underlying specialist call is TRULY killed mid-flight, not just left running).
 */
const detachedTasks = new Set<{ cancelled: boolean; abort: () => void }>();

/**
 * Hard-cancel every detached background task. Two things happen per task: its result is
 * suppressed so no orphan ever injects back, AND its AbortController is fired so the real
 * underlying call (the specialist sub-query / codex child process) actually stops instead
 * of running to completion. That second part is the v1.5 fix: the turn's abort signal is
 * now threaded all the way into the specialists, so a hung browse/email/etc. call gets
 * killed on "stop" rather than quietly burning tokens to the end.
 */
export function cancelAllDetached(): void {
  if (detachedTasks.size) log(`stop: aborting ${detachedTasks.size} detached task(s)`);
  for (const t of detachedTasks) {
    t.cancelled = true;
    try {
      t.abort();
    } catch {
      /* best-effort */
    }
  }
  detachedTasks.clear();
}

/** Set (or clear) the live turn's abort signal. Called by flush() per turn. */
export function setTurnSignal(signal: AbortSignal | null): void {
  currentSignal = signal;
}

/** Register the persistent background-result injector (the Conversation's soft enqueue). */
export function setBackgroundInjector(fn: BackgroundInjector | null): void {
  injector = fn;
}

/** True when a conversation is wired to receive synthetic inbounds at all. */
export function hasBackgroundInjector(): boolean {
  return injector !== null;
}

/**
 * Push a synthetic inbound back into the live conversation (the Conversation's soft
 * enqueue). Used by detached calls AND by fully-async background jobs (jobs.ts) to wake
 * fig with a result when work finishes off-turn. Returns false if no conversation is
 * wired (e.g. a proactive/CLI pass) — caller can fall back to leaving the result for a
 * later poll. Best-effort: a throwing injector never propagates.
 */
export function injectBackground(text: string, meta?: BackgroundInjectionMeta): boolean {
  if (!injector) return false;
  try {
    // Scrub orphaned UTF-16 surrogates before this synthetic inbound enters the
    // conversation — a lone half (from a mid-pair slice in a scraped page/tool
    // result) would otherwise make the whole API request body un-encodable.
    injector(stripLoneSurrogates(text), meta);
    return true;
  } catch (e) {
    warn(`background injection failed: ${e}`);
    return false;
  }
}

const INTERRUPTED = Symbol("interrupted");

/**
 * Wrap a blocking specialist call so it survives a mid-turn interruption.
 *
 * Takes a FACTORY `run(signal)` rather than an already-started promise, so detachable can
 * own an AbortController and hand its signal down into the specialist. That's what lets a
 * detached call be truly killed: on "stop" (cancelAllDetached) the controller fires, the
 * signal is threaded through runSpecialist → runClaudeText → query (and codex → child
 * process), and the real work aborts instead of running to completion.
 *
 * Fast path (the common case — no interruption, or no orchestration context like a
 * proactive/background pass): just await the work and return it. Zero behavioural
 * change, negligible overhead.
 *
 * Interrupted path: the live turn was cancelled (the owner texted again) while this call
 * was still running. Instead of freezing the turn until the call finishes — or throwing
 * the work away — DETACH: return a labelled placeholder so the turn can unwind and
 * re-run with their new message folded in, and keep the real call alive. When it settles,
 * its result (or failure) is injected back as a fresh inbound. A detached call can never
 * silently vanish: it either injects a result or injects a failure (and a hung one still
 * dies on the specialist's own internal timeout — the runaway guard — or on a "stop").
 */
export async function detachable(
  label: string,
  run: (signal: AbortSignal) => Promise<string>,
): Promise<string> {
  const signal = currentSignal;
  const inject = injector;
  // Own controller so the underlying call can be aborted on stop/suppression. Threaded
  // into the specialist via run(signal); fires only from cancelAllDetached() below.
  const controller = new AbortController();
  const work = run(controller.signal);
  // No orchestration context wired → plain await, completely unchanged.
  if (!signal || !inject) return work;

  const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
    if (signal.aborted) return resolve(INTERRUPTED);
    signal.addEventListener("abort", () => resolve(INTERRUPTED), { once: true });
  });

  const winner = await Promise.race([work, interrupted]);
  if (winner !== INTERRUPTED) return winner; // work finished before any interruption — normal path

  // The turn was interrupted before this call finished. Detach it: keep it running and
  // inject the result when it lands. (`[no reply]` below MUST match SILENCE_TOKEN in
  // session.ts — it's the escape hatch for fig to stay quiet when the result is stale.)
  log(`${label} specialist detached on interrupt — keeping it alive in the background`);
  // Register the task so a "stop" kill switch can suppress its result. If it's cancelled
  // before it settles, the injection below is skipped — the orphan never comes back.
  const token = { cancelled: false, abort: () => controller.abort() };
  detachedTasks.add(token);
  void work.then(
    (result) => {
      detachedTasks.delete(token);
      if (token.cancelled) return log(`detached ${label} result suppressed (stopped)`);
      inject(
        `[the ${label} task you started a moment ago just finished. use this if it's still relevant; ` +
          `if your latest message moved on (e.g. it was a correction), reply with exactly [no reply] and nothing is sent.\n\n${result}]`,
      );
    },
    (e) => {
      detachedTasks.delete(token);
      if (token.cancelled) return;
      warn(`detached ${label} specialist failed: ${e}`);
      inject(
        `[the ${label} task you started a moment ago failed before returning (${e}). ` +
          `tell the owner only if they're still waiting on it; otherwise reply with exactly [no reply].]`,
      );
    },
  );
  return (
    `(interrupted before this finished — the ${label} call is still running and its result ` +
    `will arrive as a follow-up. this is NOT the answer; don't relay it.)`
  );
}
