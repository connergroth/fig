import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";

/**
 * Lightweight reminder store. Reminders are dynamic one-off pings ("text me to call
 * the dentist at 3"), set by the agent via the reminder tool and fired by the
 * scheduler when due. Stored as JSON so the scheduler can reliably find due ones.
 */

export interface Reminder {
  id: string;
  text: string;
  dueAt: string; // ISO
  createdAt: string;
}

const FILE = path.join(config.stateDir, "reminders.json");

const load = (): Reminder[] => readJsonArray<Reminder>(FILE);
const save = (list: Reminder[]): void => writeJson(FILE, list);

export function addReminder(text: string, dueAt: string): Reminder {
  const list = load();
  const r: Reminder = { id: randomUUID().slice(0, 8), text, dueAt, createdAt: new Date().toISOString() };
  list.push(r);
  save(list);
  return r;
}

export function listReminders(): Reminder[] {
  return load().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function cancelReminder(id: string): boolean {
  const list = load();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** Reminders due at or before `now`, removed from the store (caller fires them). */
export function takeDueReminders(now = new Date()): Reminder[] {
  const list = load();
  const due: Reminder[] = [];
  const keep: Reminder[] = [];
  for (const r of list) {
    if (new Date(r.dueAt).getTime() <= now.getTime()) due.push(r);
    else keep.push(r);
  }
  if (due.length) save(keep);
  return due;
}
