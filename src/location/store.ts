import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../core/config";
import { readJson, writeJson as writeJsonAtomic } from "../core/jsonStore";

/**
 * Location state: a cached "where the owner is now" (kept warm by the poller, read by
 * the prompt for ambient awareness) and a set of arrival watches ("ping me when I
 * get to X"), which the poller checks each cycle.
 */

export interface CachedLocation {
  lat: number;
  lng: number;
  address?: string;
  at: string; // ISO — when WE cached it (poll time). NOT a freshness signal on its own.
  fixAt?: string; // ISO — the DEVICE's actual Find My fix time. Lags `at` badly when sharing goes stale.
}

/**
 * How old a real fix can be before we stop trusting it as "current". Beyond this,
 * the ambient line + where_is flag it as stale instead of presenting it as live —
 * the exact failure that had us reporting a 3-day-old fix as "now".
 */
export const FIX_STALE_MS = 20 * 60 * 1000;

/** Human-friendly age string (m / h / d) for a millisecond delta. */
export function humanizeAge(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export interface ArrivalWatch {
  id: string;
  label: string; // human place name, for the confirmation/notification
  lat: number;
  lng: number;
  radiusM: number;
  note: string; // what to text when they arrive
  createdAt: string;
}

const CACHE_FILE = path.join(config.stateDir, "location-cache.json");
const WATCH_FILE = path.join(config.stateDir, "arrival-watches.json");

// Writes happen in the location poller loop — swallow a transient failure
// (best-effort) rather than crash the cycle.
function writeJson(file: string, data: unknown): void {
  try {
    writeJsonAtomic(file, data);
  } catch {
    /* best-effort */
  }
}

// --- Cached current location ---

/**
 * A usable fix: finite, in-range, and NOT null-island (0,0). A bad fix (0,0 or
 * garbage coords) silently breaks everything downstream — most painfully the
 * timezone derivation, where tzLookup(0,0) returns Etc/GMT and the clock jumps to
 * UTC. So we reject bad fixes at the store boundary: never cache one, never hand
 * one back.
 */
function isUsableFix(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // null island — a near-zero pair is virtually always a bad/empty fix, not a real location.
  if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return false;
  return true;
}

export function setCachedLocation(loc: Omit<CachedLocation, "at">): void {
  if (!isUsableFix(loc.lat, loc.lng)) return; // drop garbage rather than clobber a good cache
  writeJson(CACHE_FILE, { ...loc, at: new Date().toISOString() });
}

/** The cached location if it's fresher than maxAgeMs AND a usable fix, else null. */
export function getCachedLocation(maxAgeMs = 20 * 60 * 1000): CachedLocation | null {
  const loc = readJson<CachedLocation | null>(CACHE_FILE, null);
  if (!loc?.at) return null;
  if (Date.now() - new Date(loc.at).getTime() > maxAgeMs) return null;
  if (!isUsableFix(loc.lat, loc.lng)) return null;
  return loc;
}

/**
 * Last usable fix we ever saw, IGNORING age. For timezone only: a tz is coarse and
 * only changes when the owner actually travels (and the poller catches a new fix within
 * minutes of that), so a days-old fix in the right region is a far better clock than
 * falling back to the machine's physical timezone. This is what keeps the clock on
 * their time even when Find My is down for a stretch.
 */
export function getLastKnownLocation(): CachedLocation | null {
  const loc = readJson<CachedLocation | null>(CACHE_FILE, null);
  if (!loc?.at) return null;
  if (!isUsableFix(loc.lat, loc.lng)) return null;
  return loc;
}

// --- Arrival watches ---

export function addWatch(label: string, lat: number, lng: number, radiusM: number, note: string): ArrivalWatch {
  const list = readJson<ArrivalWatch[]>(WATCH_FILE, []);
  const w: ArrivalWatch = {
    id: randomUUID().slice(0, 8),
    label,
    lat,
    lng,
    radiusM,
    note,
    createdAt: new Date().toISOString(),
  };
  list.push(w);
  writeJson(WATCH_FILE, list);
  return w;
}

export function listWatches(): ArrivalWatch[] {
  return readJson<ArrivalWatch[]>(WATCH_FILE, []);
}

export function cancelWatch(id: string): boolean {
  const list = readJson<ArrivalWatch[]>(WATCH_FILE, []);
  const next = list.filter((w) => w.id !== id);
  if (next.length === list.length) return false;
  writeJson(WATCH_FILE, next);
  return true;
}

/** Great-circle distance in meters. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Watches whose target is now within radius of (lat,lng) — returned AND removed (they fire once). */
export function takeTriggeredWatches(lat: number, lng: number): ArrivalWatch[] {
  const list = readJson<ArrivalWatch[]>(WATCH_FILE, []);
  const fired: ArrivalWatch[] = [];
  const keep: ArrivalWatch[] = [];
  for (const w of list) {
    if (haversineMeters(lat, lng, w.lat, w.lng) <= w.radiusM) fired.push(w);
    else keep.push(w);
  }
  if (fired.length) writeJson(WATCH_FILE, keep);
  return fired;
}
