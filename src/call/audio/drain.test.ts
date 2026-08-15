import assert from "node:assert/strict";
import test from "node:test";

import { DRAIN_TAIL_MS, PlaybackClock, waitForDrain } from "./drain";

/**
 * Drain-before-teardown: wait on the QUEUE, pad, and only then hand control back to
 * whoever tears down. A fixed timer here chops goodbyes that are still playing.
 */

/** Deterministic clock + sleep: `sleep` advances the fake clock and logs the wait. */
function fakeIo(): { now: () => number; sleep: (ms: number) => Promise<void>; clock: { t: number }; waits: number[] } {
  const clock = { t: 1_000_000 };
  const waits: number[] = [];
  return {
    clock,
    waits,
    now: () => clock.t,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.t += ms;
    },
  };
}

void test("resolves only after the queue empties, then pads the tail", async () => {
  const io = fakeIo();
  // 400ms of audio still queued when the drain is asked for.
  const doneAt = io.clock.t + 400;
  const events: string[] = [];

  const result = await waitForDrain(
    () => {
      const pending = io.now() < doneAt;
      events.push(pending ? "pending" : "empty");
      return pending;
    },
    { pollMs: 50, tailMs: 300, timeoutMs: 5_000 },
    io,
  );

  assert.equal(result.drained, true);
  assert.equal(result.waitedMs, 400, "waited exactly until the queue read empty");
  assert.equal(events.at(-1), "empty");
  assert.equal(io.waits.at(-1), 300, "the tail pad is the LAST thing before returning");
  assert.equal(
    io.clock.t - 1_000_000,
    700,
    "total = queue drain + tail pad, never a fixed guess",
  );
});

void test("an already-idle mouth still gets the tail pad, and nothing more", async () => {
  const io = fakeIo();
  const result = await waitForDrain(() => false, { pollMs: 50, tailMs: 250, timeoutMs: 5_000 }, io);
  assert.deepEqual(result, { drained: true, waitedMs: 0 });
  assert.deepEqual(io.waits, [250]);
});

void test("a wedged mouth hits the cap instead of stranding the call forever", async () => {
  const io = fakeIo();
  const result = await waitForDrain(() => true, { pollMs: 100, tailMs: 300, timeoutMs: 1_000 }, io);
  assert.equal(result.drained, false, "reports the truth: it gave up, it did not drain");
  assert.equal(result.waitedMs, 1_000, "capped at the timeout");
  assert.ok(
    !io.waits.includes(300),
    "no tail pad on the timeout path — audio is still queued, padding just delays a teardown we already chose",
  );
});

void test("the default tail sits in the 250–400ms window the device buffer needs", () => {
  assert.ok(DRAIN_TAIL_MS >= 250 && DRAIN_TAIL_MS <= 400, `tail pad ${DRAIN_TAIL_MS}ms out of range`);
});

void test("PlaybackClock accumulates queued audio and empties in real time", () => {
  let t = 5_000;
  const clock = new PlaybackClock(() => t);

  assert.equal(clock.isDraining(), false, "silence to start");

  clock.bumpMs(1_000);
  assert.equal(clock.msRemaining(), 1_000);

  // A second clause queued 400ms in appends to the tail rather than restarting it.
  t += 400;
  clock.bumpMs(1_000);
  assert.equal(clock.msRemaining(), 1_600);

  t += 1_600;
  assert.equal(clock.isDraining(), false, "queue empties exactly when the audio would have finished");
});

void test("PlaybackClock: a flush drops the queue, so nothing is owed", () => {
  let t = 5_000;
  const clock = new PlaybackClock(() => t);
  clock.bumpMs(4_000);
  assert.equal(clock.isDraining(), true);
  clock.clear();
  assert.equal(clock.isDraining(), false, "barge-in flushed the mouth — teardown must not wait on dropped audio");
});

console.log("✓ call drain tests passed");
