import assert from "node:assert/strict";

import { NOOP_SPOT_LANE, isSeamAbsence, spotLane } from "./lane";

// The seam must be presence-agnostic: these assertions hold on the owner's checkout
// (personal lane loaded) AND on a public checkout (NOOP lane), because the whole
// point of the seam is that the same public code runs in both.

// Whichever lane loaded, it satisfies the full contract — a partial personal module
// would surface here instead of as a runtime TypeError mid-turn.
for (const method of [
  "getMode",
  "resolveModeCommand",
  "relayOwnerMessage",
  "relayDownReply",
  "routeExternal",
  "startNotify",
  "safeUploadRoots",
] as const) {
  assert.equal(typeof spotLane[method], "function", `lane implements ${method}`);
}
assert.ok(["fig", "spot"].includes(spotLane.getMode()), "mode is always a valid SpotMode");
assert.equal(spotLane.resolveModeCommand("just a normal sentence"), null, "prose never trips the mode switch");

// The NOOP lane is what a public checkout runs: mode pinned to fig, /spot not a
// command, strangers dropped without a throw, no extra upload roots.
assert.equal(NOOP_SPOT_LANE.getMode(), "fig");
assert.equal(NOOP_SPOT_LANE.resolveModeCommand("/spot"), null);
assert.equal(NOOP_SPOT_LANE.resolveModeCommand("/switch"), null);
assert.deepEqual(NOOP_SPOT_LANE.safeUploadRoots(), []);
NOOP_SPOT_LANE.startNotify({} as never, "+15550000000");
NOOP_SPOT_LANE.routeExternal({} as never, { id: "x", from: "+15551234567", text: "hi" } as never);
// relayOwnerMessage is unreachable while getMode is "fig" — it must throw loudly, not
// fabricate a reply, if a future call site gets the gating wrong. (Async, so it can't
// sit at module top level under CommonJS — same main() shape as permissions.test.ts.)
async function main(): Promise<void> {
  await assert.rejects(() => NOOP_SPOT_LANE.relayOwnerMessage("hi", []));
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// The loader swallows exactly one failure: the seam module itself being absent.
const absent = Object.assign(new Error("Cannot find module '../personal/spot'"), { code: "MODULE_NOT_FOUND" });
assert.equal(isSeamAbsence(absent), true, "missing seam module → NOOP lane");
// A missing dep INSIDE personal/spot names the seam dir only in its require stack —
// that's a broken lane, not an absent one, and must throw instead of silently no-opping.
const brokenInner = Object.assign(
  new Error("Cannot find module './spot'\nRequire stack:\n- /x/src/personal/spot/index.ts"),
  { code: "MODULE_NOT_FOUND" },
);
assert.equal(isSeamAbsence(brokenInner), false, "broken module inside the lane still throws");
const realError = Object.assign(new Error("boom in personal/spot"), { code: "ERR_OTHER" });
assert.equal(isSeamAbsence(realError), false, "non-resolution errors always throw");
