import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { primaryLabel } from "./accounts";

/**
 * Calendar changes the agent itself just made (on the owner's behalf) shouldn't ping
 * them back — they asked for them, they already know. The calendar tools record an event
 * id here right after a create/update/delete; the sync poller skips any change whose
 * id was recorded in the last few minutes. Small, disk-backed so it survives the
 * poller and tool runs being separate processes/contexts.
 */

const STORE = path.join(config.stateDir, "calendar-self-changes.json");
const TTL_MS = 5 * 60 * 1000;

type Store = Record<string, number>; // eventId -> epoch ms recorded

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

function save(s: Store): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

function prune(s: Store): Store {
  const now = Date.now();
  for (const [id, ts] of Object.entries(s)) if (now - ts > TTL_MS) delete s[id];
  return s;
}

// Key by account too — two accounts can hold events with the same id.
const key = (eventId: string, account?: string) => `${account || primaryLabel()}:${eventId}`;

/** Mark an event the agent just created/updated/deleted, so the poller won't ping about it. */
export function recordSelfChange(eventId: string | undefined | null, account?: string): void {
  if (!eventId) return;
  const s = prune(load());
  s[key(eventId, account)] = Date.now();
  save(s);
}

/** Did the agent just make this change itself (within the TTL)? */
export function isSelfChange(eventId: string | undefined | null, account?: string): boolean {
  if (!eventId) return false;
  const s = prune(load());
  const hit = s[key(eventId, account)] !== undefined;
  save(s); // persist the prune
  return hit;
}
