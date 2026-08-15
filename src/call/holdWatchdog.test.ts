import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { HoldWatchdog } from "./holdWatchdog";

/**
 * The renewable hold deadline (real timers, short fuses, generous margins):
 *  - no heartbeat → expires exactly once;
 *  - heartbeats keep renewing it past several would-be deadlines (a lane that's
 *    alive but not yet releasing must never lose its child);
 *  - "go"/disarm makes it permanently inert, even against a late renew().
 */
async function main(): Promise<void> {
  // --- expiry fires without renewal, and only once ---
  {
    let fired = 0;
    new HoldWatchdog(40, () => fired++).arm();
    await sleep(120);
    assert.equal(fired, 1, "an unrenewed hold must expire exactly once");
  }

  // --- renewals defer expiry past multiple deadlines; expiry still lands after they stop ---
  {
    let fired = 0;
    const dog = new HoldWatchdog(90, () => fired++).arm();
    for (let i = 0; i < 4; i++) {
      await sleep(45); // each beat lands well inside the 90ms fuse
      dog.renew();
      assert.equal(fired, 0, `heartbeat #${i + 1} should have kept the hold alive`);
    }
    await sleep(220); // stop the heartbeats → backstop must still fire
    assert.equal(fired, 1, "once heartbeats stop, the backstop must fire");
  }

  // --- disarm ("go") is permanent: no expiry, and a late renew can't re-arm ---
  {
    let fired = 0;
    const dog = new HoldWatchdog(30, () => fired++).arm();
    dog.disarm();
    dog.renew(); // stray heartbeat after release — must be a no-op
    await sleep(100);
    assert.equal(fired, 0, "a disarmed hold must never expire");
  }

  console.log("✓ hold watchdog tests passed");
}

void main();
