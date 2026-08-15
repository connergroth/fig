import tzLookup from "tz-lookup";

import { getLastKnownLocation } from "./store";

/** Machine timezone — fallback when we have no location fix. */
function machineTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Owner's current timezone, derived from their physical Find My location so the clock
 * follows them wherever they are (a trip to the coast → America/Los_Angeles, home →
 * America/Denver) without reconfiguring the machine.
 *
 * Timezone only needs roughly-where-you-are, so we use the LAST KNOWN fix ignoring
 * age: a tz changes only when they travel, and the poller catches a new fix within
 * minutes of that — so a days-old fix in the right region beats falling back to the
 * machine's physical timezone, which is what leaks through whenever Find My is down
 * for a stretch. Machine tz is the true last resort: only if we've literally never
 * had a usable fix.
 */
export function resolveOwnerTz(): string {
  const loc = getLastKnownLocation();
  if (!loc) return machineTz();
  try {
    const zone = tzLookup(loc.lat, loc.lng);
    // Belt-and-suspenders: a GMT/UTC zone here means the fix resolved to open ocean
    // (null island / bad coords), not a real place. Never let that become the clock —
    // that's how fig ends up reporting UTC as the local hour. Fall back to the machine.
    if (!zone || /^(Etc\/|UTC$|GMT)/i.test(zone)) return machineTz();
    return zone;
  } catch {
    return machineTz();
  }
}

/**
 * The hour (0-23) on THE OWNER'S clock right now.
 *
 * Anything gated on "what time is it for them" — quiet hours, briefing windows, an expiry
 * they read off their phone — goes through here. `new Date().getHours()` is the MINI's clock,
 * a box that stays put while they spend whole months in another zone, so every one of
 * those decisions silently shifts by an hour when they travel: proactive pings unmuting at
 * 5am their time, a 🔐 that claims it expires an hour later than it really does.
 */
export function ownerHour(at: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: resolveOwnerTz(),
  }).format(at);
  return Number(h) % 24; // hour12:false renders midnight as "24" in some ICU versions
}
