import { log, warn } from "../core/log";
import { SILENCE_TOKEN } from "../render/chunking";
import { injectBackground } from "../specialists/detach";

/**
 * The post-call turn — the "webhook" that makes call-time promises real.
 *
 * A call ending only writes a digest line into Conversations/ (lane.ts finalize) —
 * that wakes nobody. Without this turn, anything fig committed to MID-CALL ("i'll
 * kick that off right after we hang up") silently dies with the session child: the
 * promise lives in the call transcript and no turn ever reads it.
 *
 * This reuses the ONE existing internal-event mechanism instead of inventing a new
 * lane: `injectBackground` (specialists/detach.ts) — the same synthetic-inbound hook a
 * settled background job (jobs.ts settle → jobWakeText) uses to wake fig. It soft-
 * enqueues into the live Conversation, becomes a NORMAL fig turn in the main session
 * loop (full tools, full context — the transcript reseed includes the [call] lines,
 * which land BEFORE this fires because finalize logs the digest synchronously first),
 * and fig stays silent by replying with the SILENCE_TOKEN when nothing's owed.
 *
 * Fire/no-fire rules (see postCallVerdict):
 *  - only for calls that actually CONNECTED (connectedAt set) — a warm session that
 *    never picked up has no transcript and no promises;
 *  - never for calls shorter than POST_CALL_MIN_CONNECTED_MS (pocket-dial / instant
 *    hang-up guard — an 11s "hey — bye" call has nothing to execute);
 *  - exactly once per call (finalize is already once-only via call.finalized, and the
 *    postCallFired flag makes this hold structurally even if a caller re-fires).
 */

/** Pocket-dial guard: a connected call shorter than this wakes nobody. */
export const POST_CALL_MIN_CONNECTED_MS = 15_000;

/** The slice of ActiveCall (lane.ts) the post-call decision needs. Structural, so tests
 *  don't have to build a ChildProcess/bridge just to exercise the fire/no-fire logic. */
export interface EndedCall {
  direction: "inbound" | "outbound";
  /** Epoch ms the call went live; null = warm session that never connected. */
  connectedAt: number | null;
  turns: { owner: number; fig: number };
  /** Mutated by firePostCallTurn — the once-per-call latch. */
  postCallFired?: boolean;
}

export type PostCallVerdict = { fire: true } | { fire: false; reason: string };

/** The pure fire/no-fire decision. `now` injectable for tests. */
export function postCallVerdict(call: EndedCall, now = Date.now()): PostCallVerdict {
  if (call.postCallFired) return { fire: false, reason: "post-call turn already fired for this call" };
  if (!call.connectedAt) return { fire: false, reason: "call never connected (warm session only)" };
  const connectedMs = now - call.connectedAt;
  if (connectedMs < POST_CALL_MIN_CONNECTED_MS) {
    return {
      fire: false,
      reason: `connected only ${Math.round(connectedMs / 1000)}s (< ${POST_CALL_MIN_CONNECTED_MS / 1000}s pocket-dial guard)`,
    };
  }
  return { fire: true };
}

/** "2m14s" / "45s" — same shape as the digest line so the two never disagree. */
export function formatCallDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
}

function ownerLabel(): string {
  return process.env.OWNER_NAME?.trim() || "the owner";
}

/**
 * The synthetic-inbound text for the post-call turn. Same conventions as jobWakeText:
 * bracketed internal event, and the SILENCE_TOKEN escape hatch so a call that needs
 * nothing produces no bubble.
 */
export function postCallWakeText(call: EndedCall, now = Date.now()): string {
  const dur = formatCallDuration(now - (call.connectedAt ?? now));
  const turns = call.turns.owner + call.turns.fig;
  return (
    `[internal event: a voice call with ${ownerLabel()} just ended — ${call.direction}, ${dur}, ${turns} turns. ` +
    `the full transcript is in today's Conversations log, tagged [call] (it's in your recent context above). ` +
    `re-read that call transcript now. if you committed to doing ANYTHING on the call ` +
    `("i'll kick that off right after we hang up", "that's queued", "i'll land the fix") — execute it now, ` +
    `for real, with your tools; a promise made on a call that dies with the hang-up is the exact failure ` +
    `this event exists to prevent. only text them if there's a real follow-up they need to see — otherwise ` +
    `reply with exactly ${SILENCE_TOKEN} and nothing is sent.]`
  );
}

/**
 * Decide + fire the post-call turn. Called from lane.ts finalize() on the connected
 * branch, AFTER the digest line is logged (so the turn's transcript reseed contains the
 * whole call). Returns true only when the wake actually reached the conversation.
 * `inject` is a seam for tests; production is the real injectBackground.
 */
export function firePostCallTurn(
  call: EndedCall,
  now = Date.now(),
  inject: (text: string) => boolean = injectBackground,
): boolean {
  const verdict = postCallVerdict(call, now);
  if (!verdict.fire) {
    log(`call lane: no post-call turn — ${verdict.reason}`);
    return false;
  }
  // Latch BEFORE injecting: even a throwing/false injector must not make this retryable
  // into a double wake.
  call.postCallFired = true;
  const ok = inject(postCallWakeText(call, now));
  if (ok) log("call lane: post-call turn fired — fig wakes to execute anything promised on the call");
  else warn("call lane: post-call turn could not fire — no conversation injector wired (CLI/bench run?)");
  return ok;
}
