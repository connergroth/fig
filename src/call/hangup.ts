import type { ChildProcess } from "node:child_process";

/**
 * Drain-before-press: the End press on a live call may only fire once the session
 * child's mouth is actually empty. `hang_up` fires the moment the goodbye TEXT is
 * done, while the audio is still being rendered clause-by-clause and then still has
 * to PLAY — text-done is not audio-done, and pressing on a timer chops the last
 * clause mid-word.
 *
 * The contract with the child (all front-ends speak it):
 *   lane writes `drain\n` on stdin → child answers with the exact line `DRAINED` on
 *   stdout once its playback queue is empty plus the device-buffer tail. The press
 *   waits on that marker, capped so a wedged mouth can't strand a call forever, with
 *   a blind fixed beat as the fallback for a child that can't answer at all.
 */

/** How long the End press will wait on the child's DRAINED marker. */
const HANGUP_DRAIN_TIMEOUT_MS = 20_000;
/** Fallback beat when the child can't answer the probe (dead stdin). */
const HANGUP_BLIND_PRESS_MS = 4_000;

/** The exact stdout line a child answers the drain probe with. */
export const DRAINED_MARKER = "DRAINED";

export type DrainOutcome = "drained" | "timeout" | "unavailable";

export interface DrainPressIo {
  /** Write a line to the child's stdin. False = stdin is gone. */
  send: (line: string) => boolean;
  /** Resolve true when the child prints the marker, false on timeout. */
  awaitMarker: (timeoutMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  press: () => void | Promise<void>;
  log?: (message: string) => void;
}

/**
 * Ask the child to drain, then press End — in that order, always. Pure over its io so
 * the ORDERING (the whole point) is testable without a call.
 */
export async function drainThenPress(
  io: DrainPressIo,
  opts: { timeoutMs?: number; blindMs?: number } = {},
): Promise<DrainOutcome> {
  const timeoutMs = opts.timeoutMs ?? HANGUP_DRAIN_TIMEOUT_MS;
  const blindMs = opts.blindMs ?? HANGUP_BLIND_PRESS_MS;
  const note = io.log ?? (() => undefined);

  if (!io.send("drain\n")) {
    // No stdin to ask down. Blind-wait the fixed beat rather than cutting instantly.
    note(`call lane: hang_up — child stdin gone, blind ${blindMs}ms press`);
    await io.sleep(blindMs);
    await io.press();
    return "unavailable";
  }
  const drained = await io.awaitMarker(timeoutMs);
  if (!drained) {
    note(`call lane: hang_up — child never reported ${DRAINED_MARKER} in ${timeoutMs}ms, pressing End anyway`);
    await io.press();
    return "timeout";
  }
  note("call lane: hang_up — mouth drained, pressing End");
  await io.press();
  return "drained";
}

/** Wait for an exact marker LINE on the child's stdout (never a substring of a log line). */
export function awaitChildMarker(child: ChildProcess, marker: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const stdout = child.stdout;
    if (!stdout) return resolve(false);
    let buf = "";
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      stdout.off("data", onData);
      resolve(ok);
    };
    const onData = (d: Buffer | string): void => {
      buf += String(d);
      // Anchored per line: the children deliberately keep the word out of their prose.
      if (buf.split("\n").some((line) => line.trim() === marker)) done(true);
      if (buf.length > 64_000) buf = buf.slice(-8_000);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    stdout.on("data", onData);
  });
}
