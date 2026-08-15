import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";

/**
 * The watch registry: runtime-created "dedicated loops".
 *
 * The heartbeat is a sparse anchor beat. Anything that needs SUSTAINED watching
 * (a delivery landing, a listing dropping under a price, a goal nudge at a set
 * hour) becomes its own row here instead of riding a global high-frequency poll.
 * Each watch carries its OWN focused prompt and its OWN cadence, and self-prunes
 * when it resolves or expires.
 *
 * The file lives inside the vault (`.state/watches.json`) so the agent can append
 * rows live (no approval prompt) when the owner says "watch for X". The scheduler
 * reads it every tick alongside frontmatter-scheduled skills.
 */

export interface Watch {
  /** Stable slug, unique in the registry. Used for dedup + removal. */
  id: string;
  /** Human label for logs/state ("RTX 4090 under $1000 on FB marketplace"). */
  label: string;
  /**
   * The focused instruction this loop runs each time it fires. Should tell the
   * agent exactly what to check and what counts as resolved. The runner appends
   * the output contract (NOTHING to stay quiet, RESOLVED to self-terminate), so
   * the prompt itself just needs the task.
   */
  prompt: string;
  /** A schedule string in the same grammar the scheduler parses ("every 12h", "daily 18:00"). */
  schedule: string;
  /** ISO when created. */
  createdISO: string;
  /** Optional hard stop — the watch is dropped after this instant no matter what. */
  expiresISO?: string;
  /** ISO of the last time this watch fired (scheduler-managed). */
  lastFiredISO?: string;
}

const WATCHES_FILE = path.join(config.stateDir, "watches.json");

export function loadWatches(): Watch[] {
  return readJsonArray<Watch>(WATCHES_FILE);
}

export function saveWatches(watches: Watch[]): void {
  // Called from the scheduler tick — swallow a transient write failure rather
  // than crash the loop; the next save reconciles.
  try {
    writeJson(WATCHES_FILE, watches);
  } catch (e) {
    warn(`saveWatches failed: ${e}`);
  }
}

/** Drop a watch by id (self-termination / resolution). Returns true if removed. */
export function removeWatch(id: string): boolean {
  const watches = loadWatches();
  const next = watches.filter((w) => w.id !== id);
  if (next.length === watches.length) return false;
  saveWatches(next);
  return true;
}

/** Stamp a watch's lastFiredISO after it runs. */
export function markWatchFired(id: string, atISO: string): void {
  const watches = loadWatches();
  const w = watches.find((x) => x.id === id);
  if (!w) return;
  w.lastFiredISO = atISO;
  saveWatches(watches);
}

/** True if the watch has passed its hard expiry. */
export function isExpired(w: Watch, now: Date): boolean {
  return !!w.expiresISO && new Date(w.expiresISO).getTime() <= now.getTime();
}
