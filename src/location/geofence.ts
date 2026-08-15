import { FIX_STALE_MS } from "./store";

/**
 * May this Find My fix be used to trip an arrival watch?
 *
 * Split out as a pure, testable predicate on purpose. A geofence is a claim about
 * where the owner is RIGHT NOW, and the poller's source (`pollOwnerLocation`) is allowed
 * to return a STALE fix as a fallback when no handle has a live one. A stale fix is
 * almost always their last PARKED position — usually home — so trusting it silently
 * converts "their phone went dark" into "they've been home for hours" and trips every
 * home watch at once.
 *
 * Rules, both deliberately strict:
 * - no timestamp → NOT trippable. An undated fix can't be proven current, and a
 *   geofence firing is exactly a currency claim. (`isFixStale` treats an undated fix
 *   as fresh, which is right for ambient display and wrong for this.)
 * - older than FIX_STALE_MS → NOT trippable.
 *
 * Failing this only HOLDS the watch — nothing is consumed or lost, it just waits for
 * a live fix. That asymmetry is why strict is correct here: a held watch fires late,
 * a falsely-tripped watch fires wrong AND deletes itself.
 */
export function mayTripGeofence(pos: { timestamp?: number } | null | undefined, now = Date.now()): boolean {
  if (!pos?.timestamp) return false;
  return now - pos.timestamp <= FIX_STALE_MS;
}
