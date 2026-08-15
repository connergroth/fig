import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";

/**
 * Registry of message guids that were emitted by a `/bg` (background/side-conversation)
 * run — i.e. the guids of the reply bubbles fig sent AS PART OF a /bg turn.
 *
 * Its one job: let the inbound router recognize when the owner THREAD-REPLIES (iMessage inline
 * reply) onto one of those bubbles, so that reply auto-continues the /bg branch instead of
 * hitting the main serial loop — no need to re-type `/bg`. background.ts registers each
 * bubble's guid as it's delivered; index.ts checks an inbound's `replyToId` against this set.
 *
 * Persistence: an in-memory Set is the source of truth (main loop + background runs share one
 * process, so the Set is visible to both live). It's also mirror-persisted to a small JSON
 * file under stateDir, loaded on boot — because this bot hot-reloads frequently at idle, and a
 * purely in-memory set would drop every recent /bg guid on each restart, silently breaking a
 * thread-reply continuation the moment the process bounced. The file keeps the last
 * `MAX_GUIDS` guids so a reply threaded onto a bubble from before a restart still routes right.
 * The failure mode is graceful either way: an unknown guid just falls back to normal routing.
 */

const STORE_FILE = path.join(config.stateDir, "bg-reply-guids.json");
// Cap the retained guids. A /bg bubble older than a few hundred replies ago is never going to
// get a fresh thread-reply, so we keep the set (and its file) bounded rather than unbounded.
const MAX_GUIDS = 500;

// Insertion-ordered so trimming drops the OLDEST guids first (Set preserves insertion order).
let guids: Set<string> | null = null;

function load(): Set<string> {
  if (guids) return guids;
  try {
    guids = new Set(readJsonArray<string>(STORE_FILE));
  } catch (e) {
    warn(`bgReplyRegistry: load failed (${e}) — starting empty`);
    guids = new Set();
  }
  return guids;
}

function persist(set: Set<string>): void {
  try {
    writeJson(STORE_FILE, [...set]);
  } catch (e) {
    // Persistence is a nice-to-have across restarts; the in-memory set still works this run.
    warn(`bgReplyRegistry: persist failed (${e}) — continuing in-memory only`);
  }
}

/** Record a guid of a bubble fig sent from a /bg run. No-op on empty. */
export function registerBgReplyGuid(guid: string | null | undefined): void {
  if (!guid) return;
  const set = load();
  if (set.has(guid)) return;
  set.add(guid);
  // Trim oldest (insertion order) down to the cap.
  while (set.size > MAX_GUIDS) {
    const oldest = set.values().next().value as string | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  persist(set);
}

/** True if `guid` is a bubble a /bg run emitted — i.e. a thread-reply to it continues the branch. */
export function isBgReplyGuid(guid: string | null | undefined): boolean {
  if (!guid) return false;
  return load().has(guid);
}
