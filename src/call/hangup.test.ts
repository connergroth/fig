import assert from "node:assert/strict";

import { drainThenPress, type DrainPressIo } from "./hangup";

/**
 * The hangup ordering invariant: `hang_up` lands when the goodbye TEXT is done, while
 * the audio is still rendering and playing — so the End press may only happen AFTER
 * the child says its mouth is empty. These pin that ordering.
 */

function recordingIo(over: Partial<DrainPressIo> = {}): { io: DrainPressIo; events: string[] } {
  const events: string[] = [];
  const io: DrainPressIo = {
    send: (line) => {
      events.push(`send:${line.trim()}`);
      return true;
    },
    awaitMarker: async () => {
      events.push("marker:DRAINED");
      return true;
    },
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    press: () => {
      events.push("press:End");
    },
    ...over,
  };
  return { io, events };
}

async function hangupDrainTests(): Promise<void> {
  {
    const { io, events } = recordingIo();
    const outcome = await drainThenPress(io);
    assert.equal(outcome, "drained");
    assert.deepEqual(
      events,
      ["send:drain", "marker:DRAINED", "press:End"],
      "End is pressed only after the child reports a drained mouth",
    );
  }

  {
    // A goodbye that outlives its render: the marker lands late, and the press waits.
    const order: string[] = [];
    const { io, events } = recordingIo({
      awaitMarker: async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push("goodbye finished playing");
        events.push("marker:DRAINED");
        return true;
      },
      press: () => {
        order.push("End pressed");
        events.push("press:End");
      },
    });
    await drainThenPress(io);
    assert.deepEqual(order, ["goodbye finished playing", "End pressed"], "never press mid-clause");
  }

  {
    // A wedged mouth must not strand the call: the cap presses anyway.
    const { io, events } = recordingIo({ awaitMarker: async () => false });
    const outcome = await drainThenPress(io, { timeoutMs: 5 });
    assert.equal(outcome, "timeout");
    assert.deepEqual(events, ["send:drain", "press:End"], "cap fires the press rather than hanging forever");
  }

  {
    // Child stdin is gone (dead pipe): fall back to the blind fixed beat.
    const { io, events } = recordingIo({ send: () => false });
    const outcome = await drainThenPress(io, { blindMs: 4_000 });
    assert.equal(outcome, "unavailable");
    assert.deepEqual(events, ["sleep:4000", "press:End"], "blind fallback still waits before pressing");
  }

  console.log("✓ call lane hangup drain-before-press tests passed");
}

void hangupDrainTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
