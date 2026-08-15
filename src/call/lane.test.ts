import assert from "node:assert/strict";

import { prewarmGate } from "./lane";

/**
 * The synchronous prewarm gate. One ring can emit two "incoming call" log-stream
 * lines ms apart, and `active` isn't assigned until after prewarm's first await —
 * so the gate must refuse on `prewarming` (a latch set before any await), not just
 * `active`, or twin sessions spawn and the orphan later kills the live call.
 */

const NOW = 1_800_000_000_000;

// --- idle lane: both directions may warm ---
assert.equal(prewarmGate({ active: false, prewarming: false, lastFinalizedAt: 0 }, "inbound", NOW), true);
assert.equal(prewarmGate({ active: false, prewarming: false, lastFinalizedAt: 0 }, "outbound", NOW), true);

// --- the double-spawn race: second ring marker lands while the first prewarm is mid-await ---
assert.equal(
  prewarmGate({ active: false, prewarming: true, lastFinalizedAt: 0 }, "inbound", NOW),
  false,
  "a prewarm already in flight must swallow the duplicate ring marker",
);

// --- a call in flight (warm or live) blocks a new one ---
assert.equal(prewarmGate({ active: true, prewarming: false, lastFinalizedAt: 0 }, "inbound", NOW), false);
assert.equal(prewarmGate({ active: true, prewarming: false, lastFinalizedAt: 0 }, "outbound", NOW), false);

// --- ring cooldown: trailing "incoming call" lines from a just-ended call don't re-warm… ---
assert.equal(
  prewarmGate({ active: false, prewarming: false, lastFinalizedAt: NOW - 3_000 }, "inbound", NOW),
  false,
  "inbound must respect the 10s post-call ring cooldown",
);
// …but a deliberate outbound dial is never cooldown-blocked, and inbound recovers after it
assert.equal(prewarmGate({ active: false, prewarming: false, lastFinalizedAt: NOW - 3_000 }, "outbound", NOW), true);
assert.equal(prewarmGate({ active: false, prewarming: false, lastFinalizedAt: NOW - 11_000 }, "inbound", NOW), true);

console.log("✓ call lane prewarm gate tests passed");
