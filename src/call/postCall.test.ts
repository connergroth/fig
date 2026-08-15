import assert from "node:assert/strict";

import {
  firePostCallTurn,
  formatCallDuration,
  POST_CALL_MIN_CONNECTED_MS,
  postCallVerdict,
  postCallWakeText,
  type EndedCall,
} from "./postCall";
import { SILENCE_TOKEN } from "../render/chunking";

/**
 * The post-call turn's fire/no-fire rules: connected-only, ≥15s, exactly once.
 * All pure — the injector is a seam, `now` is injected, no lane/bridge involved.
 */

const NOW = 1_800_000_000_000;

function call(over: Partial<EndedCall> = {}): EndedCall {
  return {
    direction: "inbound",
    connectedAt: NOW - 120_000, // a 2-minute call by default
    turns: { owner: 7, fig: 7 },
    ...over,
  };
}

// --- verdict: connected vs not ---
assert.equal(postCallVerdict(call(), NOW).fire, true, "a real 2m call fires");
{
  const v = postCallVerdict(call({ connectedAt: null }), NOW);
  assert.equal(v.fire, false, "a warm session that never connected must NOT fire");
  assert.match((v as { reason: string }).reason, /never connected/);
}

// --- verdict: the pocket-dial duration guard ---
{
  const v = postCallVerdict(call({ connectedAt: NOW - (POST_CALL_MIN_CONNECTED_MS - 1) }), NOW);
  assert.equal(v.fire, false, "a call shorter than the guard must NOT fire");
  assert.match((v as { reason: string }).reason, /pocket-dial/);
}
assert.equal(
  postCallVerdict(call({ connectedAt: NOW - POST_CALL_MIN_CONNECTED_MS }), NOW).fire,
  true,
  "exactly at the threshold fires (>= semantics)",
);

// --- verdict: once per call ---
{
  const v = postCallVerdict(call({ postCallFired: true }), NOW);
  assert.equal(v.fire, false, "an already-fired call must NOT fire again");
  assert.match((v as { reason: string }).reason, /already fired/);
}

// --- firePostCallTurn: fires once, latches, and passes the wake text through ---
{
  const c = call({ direction: "outbound", connectedAt: NOW - 96_000, turns: { owner: 5, fig: 6 } });
  const injected: string[] = [];
  const ok = firePostCallTurn(c, NOW, (t) => {
    injected.push(t);
    return true;
  });
  assert.equal(ok, true);
  assert.equal(c.postCallFired, true, "firing latches the once-per-call flag");
  assert.equal(injected.length, 1);
  const text = injected[0];
  assert.match(text, /voice call/, "wake says a call ended");
  assert.match(text, /outbound/, "direction rides along");
  assert.match(text, /1m36s/, "duration rides along");
  assert.match(text, /11 turns/, "turn count rides along");
  assert.match(text, /\[call\]/, "points at the [call]-tagged transcript");
  assert.match(text, /re-read/i, "instructs a transcript re-read");
  assert.match(text, /execute/i, "instructs executing call-time commitments");
  assert.ok(text.includes(SILENCE_TOKEN), "carries the stay-silent escape hatch");

  // Second attempt on the same call: no second wake, ever.
  const again = firePostCallTurn(c, NOW, (t) => {
    injected.push(t);
    return true;
  });
  assert.equal(again, false, "the same call never fires twice");
  assert.equal(injected.length, 1, "injector was not called a second time");
}

// --- firePostCallTurn: no-fire paths never touch the injector ---
{
  let touched = 0;
  const short = call({ connectedAt: NOW - 5_000 });
  assert.equal(firePostCallTurn(short, NOW, () => (touched++, true)), false, "5s call: no fire");
  const warmOnly = call({ connectedAt: null });
  assert.equal(firePostCallTurn(warmOnly, NOW, () => (touched++, true)), false, "unconnected: no fire");
  assert.equal(touched, 0, "injector untouched on no-fire paths");
  assert.equal(short.postCallFired ?? false, false, "a no-fire does NOT latch (finalize is the once-only in prod)");
}

// --- firePostCallTurn: a false injector (nothing wired) still latches, still returns false ---
{
  const c = call();
  assert.equal(firePostCallTurn(c, NOW, () => false), false);
  assert.equal(c.postCallFired, true, "latched even when injection failed — never retried into a double wake");
}

// --- duration formatting matches the digest line's shape ---
assert.equal(formatCallDuration(45_000), "45s");
assert.equal(formatCallDuration(134_000), "2m14s");
assert.equal(formatCallDuration(60_000), "1m00s");

// --- wake text duration for an unconnected shape degrades safely (never fired in prod) ---
assert.match(postCallWakeText(call({ connectedAt: NOW }), NOW), /0s/);

console.log("✓ post-call turn fire/no-fire tests passed");
