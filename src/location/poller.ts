import { sleep } from "../render/chunking";
import { config } from "../core/config";
import { log, warn } from "../core/log";
import type { Transport } from "../transport";
import { pollOwnerLocation, reverseGeocode } from "./findmy";
import { mayTripGeofence } from "./geofence";
import { FIX_STALE_MS, humanizeAge, listWatches, setCachedLocation, takeTriggeredWatches } from "./store";
import { ownerHour } from "./timezone";
import { deliver } from "../scheduling/scheduler";

/**
 * Live-location poller. On an interval it fetches the owner's current Find My position,
 * caches it (so the prompt always knows roughly where they are — "ambient" awareness),
 * and checks arrival watches, texting them when they reach a watched place.
 *
 * To keep Find My load and battery reasonable, it polls at a relaxed cadence and
 * pauses during quiet hours UNLESS there are active arrival watches (you still want
 * "text me when I'm home" to fire at 1am).
 */

const POLL_MS = Number(process.env.LOCATION_POLL_MS || 5 * 60 * 1000); // 5 min

// Their clock, not the mini's — the pause is meant to line up with when THEY are asleep,
// and the machine stays in one timezone while they don't. Reading the last known fix to
// decide whether to poll isn't circular: a stale fix still gives the right zone.
function inQuietHours(now = new Date()): boolean {
  const h = ownerHour(now);
  const { start, end } = config.quietHours;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

export function startLocationPoller(transport: Transport, owner: string): void {
  if (!owner) {
    log("location poller off (no owner)");
    return;
  }

  // One-shot latch so a phone that's been dark for hours logs the hold once, not
  // every POLL_MS tick. Reset the moment a live fix lands.
  let staleHoldLogged = false;

  async function tick(): Promise<void> {
    const hasWatches = listWatches().length > 0;
    if (inQuietHours() && !hasWatches) return; // idle overnight unless something's pending

    const pos = await pollOwnerLocation();
    if (!pos) return;

    const address = (await reverseGeocode(pos.lat, pos.lng)) ?? pos.coarseAddress;
    setCachedLocation({
      lat: pos.lat,
      lng: pos.lng,
      address,
      fixAt: pos.timestamp ? new Date(pos.timestamp).toISOString() : undefined,
    });

    // A geofence is a claim about where they are RIGHT NOW, so it may only ever be
    // evaluated against a fix we know is current. `pollOwnerLocation()` falls back to
    // the best STALE fix when no handle returns a live one (its own doc: "Callers MUST
    // check its age before treating the fix as current") — and a stale fix is almost
    // always their last PARKED position, which is usually home. So a phone that quietly
    // stopped pushing fixes doesn't read as "no idea where they are", it reads as "they've
    // been home for hours", and every home watch trips at once — hours early, and then
    // CONSUMES itself, so it can't fire when they actually arrive.
    //
    // Caching the stale fix above is fine (the prompt renders its age and warns), but
    // firing on it is not. Hold the watches instead; they're not lost, just not spent.
    if (!mayTripGeofence(pos)) {
      if (!staleHoldLogged) {
        staleHoldLogged = true;
        const age = pos.timestamp
          ? `${humanizeAge(Date.now() - pos.timestamp)} old`
          : "no fix timestamp";
        warn(
          `location: ${listWatches().length} arrival watch(es) HELD — ${age} (need a fix under ${Math.round(
            FIX_STALE_MS / 60_000,
          )}m to trip a geofence)`,
        );
      }
      return;
    }
    staleHoldLogged = false;

    for (const w of takeTriggeredWatches(pos.lat, pos.lng)) {
      try {
        // Through deliver(), not transport.send(). deliver() is the single chokepoint
        // for proactive messages: it writes the line to the Conversations transcript
        // and resets the live session so the NEXT turn actually knows what I just said.
        // Sending raw would leave an arrival ping in the owner's thread and nowhere in my
        // memory — so a reply to one lands on a session that has no idea it was ever sent.
        // Any new proactive sender belongs on this path too.
        await deliver(transport, owner, w.note);
        log(`arrival watch fired: ${w.id} (${w.label})`);
      } catch (e) {
        warn(`arrival watch send failed: ${e}`);
      }
    }
  }

  void (async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (e) {
        warn(`location poll: ${e}`);
      }
      await sleep(POLL_MS);
    }
  })();

  log(`location poller started (every ${Math.round(POLL_MS / 60000)}m)`);
}
