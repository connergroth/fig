import { config } from "../core/config";
import { warn } from "../core/log";
import { OWNER_ALIASES } from "../core/owner";
import { bridgePoll, bridgeRefresh, bridgeShare } from "./bridge";
import { isInjectionHealthy, relaunchInjected } from "../transport/inject";
import { FIX_STALE_MS } from "./store";

/**
 * Find My client — reads the owner's live location off the find-my dylib
 * injected into fig's own Messages.app, via the in-process trigger-file bridge
 * (`./bridge`). No HTTP relay — location lives entirely under fig. Plus Google
 * geocoding to turn coordinates into addresses and place names into coordinates.
 *
 * Prerequisite for polling the owner: they must be sharing their location (Find My)
 * with the Apple ID signed into fig's Messages. `requestLocationShare` fires the
 * native prompt when they aren't.
 */

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY?.trim() || "";

export interface LivePosition {
  lat: number;
  lng: number;
  coarseAddress?: string;
  /**
   * Epoch MILLISECONDS of the DEVICE's actual fix (Apple's locationTimestamp), NOT
   * when we polled. Normalized to ms here so every caller can trust the unit. This is
   * the real freshness signal — if the owner's phone stops pushing to our Apple ID, this
   * stays frozen at the last real fix even while polls keep "succeeding" against a
   * stale FMF cache. Callers MUST check its age before treating the fix as current.
   */
  timestamp?: number;
}

/** Apple hands epoch SECONDS (fractional) in these fields; a stray path may hand ms. Normalize to ms. */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v; // < ~2001-in-ms ⇒ it's seconds, scale up
}

/** Map the dylib's raw location.json into a LivePosition (or null if no real fix). */
function parsePos(j: any): LivePosition | null {
  if (!j) return null;
  const ok = j.success === true || j.success === 1;
  if (!ok || typeof j.latitude !== "number" || typeof j.longitude !== "number") return null;
  // Prefer the device fix time; fall back to the generic stamp only if it's absent.
  const ts = toEpochMs(j.locationTimestamp) ?? toEpochMs(j.timestamp);
  return {
    lat: j.latitude,
    lng: j.longitude,
    coarseAddress: j.coarseAddress || j.coarse_address || j.formattedAddress || undefined,
    timestamp: ts,
  };
}

/**
 * One-shot current location for a person who shares with fig's Apple ID. Retries
 * once on a slow/empty fix, but fails fast when the dylib is down (heartbeat stale)
 * so callers — especially the where_is tool — don't hang on a doomed retry.
 */
export async function pollLocation(address: string): Promise<LivePosition | null> {
  try {
    const first = parsePos(await bridgePoll(address, 15_000));
    if (first) return first;
    // No fix. If injection is down, a retry is doomed — bail. Otherwise the fix was
    // just slow/empty; give it one more, longer window.
    if (!isInjectionHealthy()) return null;
    return parsePos(await bridgePoll(address, 18_000));
  } catch (e) {
    warn(`findmy poll failed: ${e}`);
    return null;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is this fix older than we'll trust as "current"? (device fix time, not poll time) */
export function isFixStale(pos: LivePosition | null): boolean {
  return !!pos?.timestamp && Date.now() - pos.timestamp > FIX_STALE_MS;
}

/**
 * Current location for a handle, force-refreshed if the cached fix is stale.
 *
 * A plain `pollLocation` returns FMF's cache, which the dylib won't refresh on a
 * cache HIT — so a phone that stopped pushing fixes reads "frozen at last night"
 * forever. This does the extra work: poll, and if the fix is stale, fire a live
 * `refresh` and re-read until a fresher fix lands (or we give up and return the
 * best we had, still correctly flagged stale by the caller). This is what makes
 * "where am I" self-heal instead of confidently serving a 15h-old address.
 */
export async function pollLocationFresh(address: string): Promise<LivePosition | null> {
  let pos = await pollLocation(address);
  if (!pos || !isFixStale(pos)) return pos; // nothing to force, or already fresh
  // Stale cache hit: actively re-query the device, then re-read the refreshed cache.
  const refreshed = parsePos(await bridgeRefresh(address));
  if (refreshed && (refreshed.timestamp ?? 0) > (pos.timestamp ?? 0)) pos = refreshed;
  for (let i = 0; i < 3 && isFixStale(pos); i++) {
    await wait(2500);
    const next = await pollLocation(address);
    if (next && (next.timestamp ?? 0) > (pos.timestamp ?? 0)) pos = next;
  }
  return pos;
}

/**
 * Ordered handles to try for the OWNER's own Find My fix. Their iPhone shares location
 * under their Apple ID (a gmail), NOT under their phone number — FMF returns "cache
 * still empty" for the phone-number handle and a real fix only for the Apple-ID
 * handle. So poll the configured LOCATION_HANDLES first (default: the OWNER_EMAILS
 * aliases, which carry the Apple ID), then the owner numbers. Deduped, order preserved.
 * Get this order wrong and location reads as permanently frozen: every poll "succeeds"
 * against a handle that never carries a fix.
 */
export function ownerLocationHandles(): string[] {
  const configured = (process.env.LOCATION_HANDLES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const primary = configured.length ? configured : [...OWNER_ALIASES];
  return [...new Set([...primary, ...config.ownerNumbers])].filter(Boolean);
}

/**
 * FMFSession self-heal.
 *
 * The injected Messages.app's in-process FindMy session can rot while the dylib
 * heartbeat stays perfectly healthy: the session's friend-location cache empties,
 * every `refresh` comes back "cache still empty", and location silently freezes for
 * DAYS — even though the injection watchdog (which only watches the heartbeat) sees
 * nothing wrong. A long-lived Messages.app is the usual setup for it: the session can
 * be dead for a week with the heartbeat ticking the entire time. The cure is a full
 * re-inject, which rebuilds the session from current OS FindMy state. So when owner
 * polls repeatedly return NO live fix DESPITE a healthy heartbeat, treat that as a
 * dead session and force one rate-limited recycle.
 */
let consecutiveOwnerMisses = 0;
let lastSessionRecycle = 0;
const OWNER_MISS_RECYCLE_THRESHOLD = 3; // ~3 straight failed cycles (~15m) before acting
const SESSION_RECYCLE_COOLDOWN_MS = 45 * 60 * 1000; // at most one recycle / 45min

async function maybeRecycleSession(): Promise<void> {
  if (!isInjectionHealthy()) return; // heartbeat's the problem — the watchdog owns that
  if (consecutiveOwnerMisses < OWNER_MISS_RECYCLE_THRESHOLD) return;
  if (Date.now() - lastSessionRecycle < SESSION_RECYCLE_COOLDOWN_MS) return;
  lastSessionRecycle = Date.now();
  warn(
    `findmy: ${consecutiveOwnerMisses} owner polls returned no live fix despite a healthy heartbeat — recycling Messages to rebuild the FindMy session`,
  );
  await relaunchInjected(); // rebuilds the in-process FMFSession; next cycle confirms the heal
  consecutiveOwnerMisses = 0;
}

/**
 * Current location for the OWNER specifically — walks `ownerLocationHandles()` and
 * returns the first real fix. Beats `pollLocation(ownerNumber)`, which silently
 * fails because their phone doesn't share under the number.
 */
export async function pollOwnerLocation(): Promise<LivePosition | null> {
  let stale: LivePosition | null = null;
  for (const handle of ownerLocationHandles()) {
    const pos = await pollLocationFresh(handle);
    if (!pos) continue;
    if (!isFixStale(pos)) {
      consecutiveOwnerMisses = 0; // a live fix proves the session is healthy
      return pos;
    }
    stale ??= pos; // hold the best stale one, keep trying the other handles
  }
  // No LIVE fix from any handle. If the heartbeat's healthy, the rotted in-process
  // session is the likely culprit — count the miss and recycle after a sustained streak.
  consecutiveOwnerMisses++;
  void maybeRecycleSession();
  return stale;
}

/** Trigger the native "share your location with me" prompt to `address`. */
export async function requestLocationShare(address: string): Promise<boolean> {
  try {
    return await bridgeShare(address);
  } catch (e) {
    warn(`findmy onboard failed: ${e}`);
    return false;
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  if (!MAPS_KEY) return null;
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${MAPS_KEY}`);
    if (!res.ok) return null;
    const j: any = await res.json();
    return j?.results?.[0]?.formatted_address ?? null;
  } catch {
    return null;
  }
}

export interface GeoPlace {
  lat: number;
  lng: number;
  address: string;
}

/** Resolve a place name ("Whole Foods Hillcrest") to coordinates + a tidy address. */
export async function forwardGeocode(place: string): Promise<GeoPlace | null> {
  if (!MAPS_KEY) return null;
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${MAPS_KEY}`);
    if (!res.ok) return null;
    const j: any = await res.json();
    const r = j?.results?.[0];
    const loc = r?.geometry?.location;
    if (!loc || typeof loc.lat !== "number") return null;
    return { lat: loc.lat, lng: loc.lng, address: r.formatted_address ?? place };
  } catch {
    return null;
  }
}

/** A tappable Apple Maps pin for coordinates. */
export function appleMapsPin(lat: number, lng: number, label = "Location"): string {
  return `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(label)}`;
}
