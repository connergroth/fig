import path from "node:path";

import { config } from "./config";

/**
 * Advisory per-file async mutex, keyed by ABSOLUTE path.
 *
 * Why this exists: fig is normally a single serial conversation, so vault writes never
 * race. But a `/btw` spawns a SECOND, concurrent fig agent run in THIS same node process
 * (see session/background.ts). Now two lanes can write the same daily file at the same
 * instant — the classic read-modify-write clobber (both Edit today's Nutrition log; the
 * later write wins and drops the earlier row). This mutex serializes writes to the small
 * set of HOT files skills mutate, and ONLY those — unrelated writes stay fully parallel.
 *
 * It's an in-process chain of promises per path (`tails`): each acquire waits on the
 * previous holder's release before resolving. Deliberately advisory: the built-in
 * Write/Edit tools execute inside the SDK harness (out-of-process), so there's no
 * post-write callback we can hang the release on. The gate at the permission layer
 * (runtimes/permissions.ts) therefore acquires the lock, approves the write, and releases
 * after a short bounded settle window — long enough for a small-markdown write to land.
 * See that call site for the tradeoff.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Acquire the lock for `absPath`. Resolves once it's this caller's turn, with a release
 * function. Call release() exactly once when done; it's idempotent. Concurrent acquires
 * on the same path are served strictly in call order (the map is updated synchronously,
 * so ordering is deterministic even for same-tick callers).
 */
export function acquireFileLock(absPath: string): Promise<() => void> {
  const key = path.resolve(absPath);
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const next = prev.then(() => gate);
  tails.set(key, next);
  return prev.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // If nobody chained after us, drop the map entry so it doesn't leak forever.
      if (tails.get(key) === next) tails.delete(key);
      release();
    };
  });
}

// The hot set: the daily files two lanes can realistically touch at once. Whole-dir
// coverage for Health/ (superset of "today's file" — strictly safer, and cross-file
// collisions there are rare so the extra serialization costs nothing in practice),
// plus the three exact open-loop lists that every skill keeps fresh.
// Health/ subsumes the old top-level Nutrition/ — the food log now lives at
// Health/nutrition/ and the sleep log at Health/sleep/, so this one dir still covers
// both. Keep it that way: a narrower path here silently drops a lock.
const HEALTH_DIR = path.join(config.brainDir, "Health");
const LIST_FILES = new Set([
  path.join(config.brainDir, "Pending.md"),
  path.join(config.brainDir, "Lists", "Todos.md"),
  path.join(config.brainDir, "Tasks.md"),
]);

function underDir(abs: string, dir: string): boolean {
  return abs === dir || abs.startsWith(dir + path.sep);
}

/** True if a write to this absolute path should be serialized across lanes. */
export function isHotFile(absPath: string): boolean {
  const abs = path.resolve(absPath);
  if (LIST_FILES.has(abs)) return true;
  return underDir(abs, HEALTH_DIR);
}
