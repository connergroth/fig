import assert from "node:assert/strict";

import { mayTripGeofence } from "./geofence";
import { FIX_STALE_MS } from "./store";

const now = Date.UTC(2026, 6, 29, 1, 3, 18);

// A live fix trips normally — the feature still works.
assert.equal(mayTripGeofence({ timestamp: now - 30_000 }, now), true);
assert.equal(mayTripGeofence({ timestamp: now }, now), true);
assert.equal(mayTripGeofence({ timestamp: now - FIX_STALE_MS }, now), true); // boundary is inclusive

// THE case this exists for: a phone stops sharing, the poller keeps re-reading the frozen
// pin at the owner's front door, and "text me when I'm home" fires hours before they're
// anywhere near home. A fix this old must never trip a geofence.
assert.equal(mayTripGeofence({ timestamp: now - 10 * 60 * 60 * 1000 }, now), false);
assert.equal(mayTripGeofence({ timestamp: now - (FIX_STALE_MS + 1) }, now), false);

// An undated fix can't be proven current, so it doesn't count either — note this is
// deliberately STRICTER than isFixStale(), which reads an undated fix as fresh (fine
// for ambient display, not for a claim about where they are this second).
assert.equal(mayTripGeofence({}, now), false);
assert.equal(mayTripGeofence(null, now), false);
assert.equal(mayTripGeofence(undefined, now), false);

console.log("geofence: all checks passed");
