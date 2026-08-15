import fs from "node:fs";
import path from "node:path";

import { warn } from "../core/log";
import { ensureInjected, isInjectionHealthy, MESSAGES_TMP } from "../transport/inject";

/**
 * Find My bridge — talks to the find-my dylib injected into Messages.app
 * directly, over the trigger-file protocol. No HTTP relay in between: we write a trigger
 * JSON into Messages' sandbox tmp (atomic temp+rename, since the dylib reads+deletes it),
 * the dylib does the FindMy work and writes a result file back, and we poll for it by
 * mtime. Entirely in-process, so location lives under fig alone.
 */

const TRIGGER_FILE = path.join(MESSAGES_TMP, "findmy-trigger.json");
const TRIGGER_TMP = path.join(MESSAGES_TMP, "findmy-trigger.json.tmp");
const LOCATION_RESULT = path.join(MESSAGES_TMP, "findmy-location.json");

/**
 * Serialize ALL dylib invocations. FindMyLocateSession inside Messages.app is NOT
 * reentrant — concurrent triggers race Apple's ChatKit observers and crash Messages
 * (verified repeatedly; it's why the old relay held a single lock at its HTTP
 * boundary). One promise chain enforces the same one-at-a-time contract here.
 */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function writeTrigger(action: string, address?: string): void {
  const payload: Record<string, string> = { action };
  if (address) payload.address = address;
  fs.writeFileSync(TRIGGER_TMP, JSON.stringify(payload));
  fs.renameSync(TRIGGER_TMP, TRIGGER_FILE); // atomic — the watcher reads+deletes it
}

/** Wait for a result file written AFTER `after` (epoch ms); null on timeout. */
async function awaitResult(file: string, after: number, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > after) {
        try {
          return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          /* file mid-write — retry next tick */
        }
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 800ms slack so coarse fs mtime / clock skew never makes us miss a fresh write. */
function freshnessMark(): number {
  return Date.now() - 800;
}

/** Refresh + read the cached location for a handle. Null = down or no fix in window. */
export function bridgePoll(address: string, timeoutMs = 15_000): Promise<any | null> {
  return withLock(async () => {
    await ensureInjected();
    if (!isInjectionHealthy()) {
      warn("findmy bridge: dylib heartbeat stale — skipping poll");
      return null;
    }
    const before = freshnessMark();
    writeTrigger("poll", address);
    return awaitResult(LOCATION_RESULT, before, timeoutMs);
  });
}

/**
 * Force a LIVE Find My re-fetch for `address`, then return the fresh fix.
 *
 * The plain `poll` action returns whatever FMF has CACHED — and the dylib only
 * force-refreshes on a cache MISS. So a present-but-stale fix (phone hasn't pushed
 * a new location in hours) is served as-is forever, which is exactly the "frozen at
 * last night's fix" failure. This fires the dylib's `refresh-findmy-friends` action
 * (forceRefresh under the hood), which actively re-queries Apple for a current
 * location and rewrites the result file when the phone answers. Null = dylib down,
 * or no refreshed fix landed inside the window (phone unreachable / not sharing).
 */
export function bridgeRefresh(address: string, timeoutMs = 15_000): Promise<any | null> {
  return withLock(async () => {
    await ensureInjected();
    if (!isInjectionHealthy()) {
      warn("findmy bridge: dylib heartbeat stale — skipping refresh");
      return null;
    }
    const before = freshnessMark();
    writeTrigger("refresh-findmy-friends", address);
    return awaitResult(LOCATION_RESULT, before, timeoutMs);
  });
}

/** Fire the native "share your location with me" prompt to `address`. */
export function bridgeShare(address: string): Promise<boolean> {
  return withLock(async () => {
    await ensureInjected();
    if (!isInjectionHealthy()) return false;
    writeTrigger("share", address);
    await new Promise((r) => setTimeout(r, 600)); // fire-and-forget; let the watcher consume it
    return true;
  });
}
