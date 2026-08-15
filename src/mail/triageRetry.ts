/**
 * Retry bookkeeping shared by both email pollers (src/google/watch.ts,
 * src/mail/outlookPoll.ts).
 *
 * THE BUG THIS FILE EXISTS TO KILL (2026-07-29, same incident as verdict.ts): both
 * pollers wrote a message id into their `seen` set BEFORE triage ran and regardless of
 * how it went. So a crashed, truncated, or unrecognized triage run looked EXACTLY like a
 * completed one, and was never retried — which is why nothing self-corrected in the two
 * hours after a notify-tier email got swallowed.
 *
 * The rule now: a message is only committed to `seen` once triage returned an outcome we
 * UNDERSTOOD. Anything else stays retryable. The obvious hazard in that is an infinite
 * retry loop on a message that can never be classified, so attempts are counted, capped,
 * and persisted — and the counter is bumped BEFORE the run, so even a hard crash mid-run
 * burns an attempt and the loop still terminates.
 *
 * The ledger is bounded three ways, because unbounded retry state is its own outage:
 * entries are deleted the moment a message resolves (committed or given up), entries
 * older than ATTEMPT_TTL_MS are pruned, and the whole map is capped at
 * MAX_ATTEMPT_ENTRIES (oldest dropped first).
 */

/** Total triage attempts per message before we give up and commit it anyway. */
export const MAX_TRIAGE_ATTEMPTS = 3;
/** An unresolved message older than this stops being retried (stale history/api trouble). */
export const ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard cap on tracked in-flight messages; oldest are dropped past this. */
export const MAX_ATTEMPT_ENTRIES = 100;

export interface AttemptRecord {
  /** Attempts already started for this message. */
  attempts: number;
  /** Epoch ms of the first attempt (drives TTL + cap eviction). */
  first: number;
  /**
   * The best fallback brief seen so far for this message. Retries are silent (a message
   * being retried every few seconds must not ping every few seconds), so the ping only
   * fires when we give up — and by then the failing attempt may have produced no text at
   * all. Holding the earlier one means "unreadable, then the runtime died" still surfaces
   * something instead of going quiet, which is the whole point of this exercise.
   */
  brief?: string;
}

export type AttemptState = Record<string, AttemptRecord>;

/**
 * What the poller should do with a message after triage.
 * - `commit` — understood outcome: mark seen, ping if there's a brief.
 * - `retry`  — not understood, attempts left: leave it UNSEEN for the next poll.
 * - `giveup` — not understood, cap reached: mark seen (so it can't loop forever), warn
 *              loudly, and still deliver whatever brief we have rather than swallow it.
 */
export type TriageDisposition = "commit" | "retry" | "giveup";

export function dispositionFor(
  recognized: boolean,
  attempt: number,
  max: number = MAX_TRIAGE_ATTEMPTS,
): TriageDisposition {
  if (recognized) return "commit";
  return attempt >= max ? "giveup" : "retry";
}

/** The full follow-up decision: what to persist, and what (if anything) to ping. */
export interface TriageFollowup {
  disposition: TriageDisposition;
  /** True only when the message may be marked permanently handled. */
  commitSeen: boolean;
  /** The brief to voice + deliver, or null for silence. */
  deliver: string | null;
  /** A fallback brief to hold for the give-up path (retries stay silent). */
  remember: string | null;
}

/**
 * The rule both pollers run after triage, in one place so gmail and outlook can't drift.
 *
 * - understood outcome → commit it, ping if there's a brief (unchanged behavior).
 * - not understood, attempts left → commit NOTHING. Hold any fallback brief and stay
 *   quiet; the retry lands seconds later and a real verdict is worth more than a
 *   "couldn't classify" ping fired three times.
 * - not understood, cap reached → commit (so it can't loop) but SURFACE the best brief
 *   we have. Silence here is the original bug; a false ping is the accepted price.
 */
export function decideTriageFollowup(
  outcome: { brief: string | null; recognized: boolean },
  attempt: number,
  remembered?: string,
  max: number = MAX_TRIAGE_ATTEMPTS,
): TriageFollowup {
  const disposition = dispositionFor(outcome.recognized, attempt, max);
  if (disposition === "retry") {
    return { disposition, commitSeen: false, deliver: null, remember: outcome.brief };
  }
  if (disposition === "commit") {
    return { disposition, commitSeen: true, deliver: outcome.brief, remember: null };
  }
  return { disposition, commitSeen: true, deliver: outcome.brief ?? remembered ?? null, remember: null };
}

/** Persisted, bounded per-message attempt counter. IO is injected so it's testable. */
export class TriageAttempts {
  private state: AttemptState;
  private readonly persist: (state: AttemptState) => void;
  private readonly now: () => number;

  constructor(opts: {
    state?: AttemptState;
    /** Called after every mutation. Should be best-effort (never throw). */
    persist?: (state: AttemptState) => void;
    now?: () => number;
  } = {}) {
    this.state = { ...(opts.state ?? {}) };
    this.persist = opts.persist ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  /** Attempts already started for `key` (0 if untracked). */
  attempts(key: string): number {
    return this.state[key]?.attempts ?? 0;
  }

  /** Keys still awaiting a recognized outcome, oldest first. */
  pending(): string[] {
    return Object.entries(this.state)
      .sort((a, b) => a[1].first - b[1].first)
      .map(([k]) => k);
  }

  /**
   * Record that an attempt is STARTING and return its number (1-based). Called before
   * the triage run on purpose: a crash mid-run must still count, or a message that
   * reliably kills the process would be retried forever.
   */
  begin(key: string): number {
    const rec = (this.state[key] ??= { attempts: 0, first: this.now() });
    rec.attempts += 1;
    this.prune(); // after inserting, so the cap counts this entry too (never evicts it: it's newest)
    this.save();
    return rec.attempts;
  }

  /** Keep a fallback brief for a message we haven't given up on yet. */
  remember(key: string, brief: string): void {
    const rec = this.state[key];
    if (!rec) return; // never tracked / already resolved — nothing to hold it against
    rec.brief = brief;
    this.save();
  }

  /** The best fallback brief recorded for `key`, if any. */
  recall(key: string): string | undefined {
    return this.state[key]?.brief;
  }

  /** Message resolved (committed or given up) — stop tracking it. */
  clear(key: string): void {
    if (this.state[key]) {
      delete this.state[key];
      this.save();
    }
  }

  /**
   * Drop expired and overflow entries. Returns the keys dropped so the caller can say
   * so out loud — a message aging out of the ledger is a message we stopped retrying.
   */
  prune(): string[] {
    const cutoff = this.now() - ATTEMPT_TTL_MS;
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(this.state)) {
      if (v.first < cutoff) {
        delete this.state[k];
        dropped.push(k);
      }
    }
    const keys = Object.entries(this.state).sort((a, b) => a[1].first - b[1].first);
    for (const [k] of keys.slice(0, Math.max(0, keys.length - MAX_ATTEMPT_ENTRIES))) {
      delete this.state[k];
      dropped.push(k);
    }
    if (dropped.length) this.save();
    return dropped;
  }

  snapshot(): AttemptState {
    return { ...this.state };
  }

  private save(): void {
    try {
      this.persist(this.state);
    } catch {
      /* best-effort, exactly like the seen-set's own save */
    }
  }
}
