/**
 * "Is the mouth actually finished?" — the one thing every teardown path on the call lane
 * has to ask before it pulls the plug. Text-done is not audio-done: a goodbye is still
 * being rendered clause-by-clause and then still has to PLAY after the turn's text ends,
 * so never guess at a duration — wait on the actual queue:
 *
 *  1. wait until nothing is pending — no turn in flight, no audio left to play
 *  2. add a small TAIL pad on top, because "our queue is empty" still leaves one device
 *     buffer in flight downstream (CoreAudio ring + FaceTime's own encoder)
 *  3. cap the wait, because a wedged mouth must not strand a call forever — a truncated
 *     goodbye is bad, a call that never hangs up is worse
 *
 * Both the session children and the lane's End press run this shape; the Rust half
 * lives in tools/call/child/src/drain.rs. Keep the two in step.
 */

/** Device buffer + FaceTime encoder lag after OUR queue reads empty. */
export const DRAIN_TAIL_MS = 300;
/** Hang-up cap: the goodbye still has to be thought, rendered AND played. */
export const DRAIN_TIMEOUT_MS = 20_000;
/** Teardown cap: by now the call is already ending, so bound it much tighter. */
export const TEARDOWN_DRAIN_TIMEOUT_MS = 8_000;
/** How often to re-ask. Cheap — it's a clock/queue read, not a syscall. */
export const DRAIN_POLL_MS = 25;

export interface DrainPolicy {
  pollMs?: number;
  tailMs?: number;
  timeoutMs?: number;
}

export interface DrainResult {
  /** True = the queue really went empty. False = the cap fired with audio still pending. */
  drained: boolean;
  /** Time spent waiting for the queue, EXCLUDING the tail pad. */
  waitedMs: number;
}

export interface DrainIo {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Block until `pending()` reads false, then pad, then return.
 *
 * The tail pad is applied ONLY on the drained path: if the cap fired, audio is still
 * queued and padding would just make a teardown we already decided on later.
 */
export async function waitForDrain(
  pending: () => boolean,
  policy: DrainPolicy = {},
  io: DrainIo = {},
): Promise<DrainResult> {
  const pollMs = policy.pollMs ?? DRAIN_POLL_MS;
  const tailMs = policy.tailMs ?? DRAIN_TAIL_MS;
  const timeoutMs = policy.timeoutMs ?? DRAIN_TIMEOUT_MS;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? realSleep;

  const t0 = now();
  while (pending()) {
    if (now() - t0 >= timeoutMs) return { drained: false, waitedMs: now() - t0 };
    await sleep(pollMs);
  }
  const waitedMs = now() - t0;
  if (tailMs > 0) await sleep(tailMs);
  return { drained: true, waitedMs };
}

/**
 * How much audio is still owed to the device, tracked by ENQUEUED DURATION.
 *
 * A TypeScript child can't read injectin's FIFO (it's a separate process) so the honest
 * model is "sum the durations we handed it": playback starts immediately and runs in
 * real time, so `speakingUntil` is when the last sample lands. Barge-in drops the queue,
 * so it resets the clock too.
 */
export class PlaybackClock {
  private speakingUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}

  /** Queue `ms` more audio. */
  bumpMs(ms: number): void {
    if (!(ms > 0)) return;
    this.speakingUntil = Math.max(this.now(), this.speakingUntil) + ms;
  }

  /** Barge-in / flush: the queue was dropped, so nothing is owed any more. */
  clear(): void {
    this.speakingUntil = 0;
  }

  msRemaining(): number {
    return Math.max(0, this.speakingUntil - this.now());
  }

  isDraining(): boolean {
    return this.now() < this.speakingUntil;
  }
}
