import assert from "node:assert/strict";

import { parseBridgeVersion } from "./inject";

/**
 * The bridge-version parse is the eye of the injection watchdog's second health signal.
 * It exists because `imsg status` reports "connected" even when the IMCore bridge has
 * dropped to v0 and every send-rich is silently falling back to plain AppleScript —
 * connection state lies, the version doesn't.
 */

// Real `imsg status --json` output (0.13.5, healthy bridge), trimmed to the fields read.
const HEALTHY =
  '{"typing_indicators":true,"message":"Connected to Messages.app. IMCore features available.",' +
  '"sip":"disabled","basic_features":true,"bridge_version":2,"read_receipts":true,' +
  '"v2_ready":true,"version":"0.13.5","advanced_features":true}';

// The wedged shape: still "connected", still advanced_features, but the bridge is v0.
const WEDGED =
  '{"typing_indicators":true,"message":"Connected to Messages.app. IMCore features available.",' +
  '"sip":"disabled","basic_features":true,"bridge_version":0,"read_receipts":true,' +
  '"v2_ready":false,"version":"0.13.5","advanced_features":true}';

function testHealthy(): void {
  assert.equal(parseBridgeVersion(HEALTHY), 2);
}

function testWedged(): void {
  // The whole point: a payload that otherwise reads as healthy must come back v0.
  assert.equal(parseBridgeVersion(WEDGED), 0);
}

function testBooleanOnlyFallback(): void {
  // Older imsg builds expose only v2_ready, no numeric field.
  assert.equal(parseBridgeVersion('{"v2_ready":true}'), 2);
  assert.equal(parseBridgeVersion('{"v2_ready":false}'), 0);
}

function testUnknownIsNull(): void {
  // Unknown must be null (NOT 0) — the caller treats null as "don't relaunch", so a
  // broken probe can never crash-loop Messages.
  assert.equal(parseBridgeVersion(""), null, "empty stdout → unknown");
  assert.equal(parseBridgeVersion("not json"), null, "unparseable → unknown");
  assert.equal(parseBridgeVersion('{"version":"0.13.5"}'), null, "no bridge field → unknown");
  assert.equal(parseBridgeVersion('{"bridge_version":"2"}'), null, "wrong type → unknown");
}

function main(): void {
  testHealthy();
  testWedged();
  testBooleanOnlyFallback();
  testUnknownIsNull();
  console.log("inject bridge-version parse tests passed");
}

main();
