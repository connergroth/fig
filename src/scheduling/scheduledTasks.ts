import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";

/**
 * Durable one-off scheduled-TASK store. Unlike a reminder (which just delivers a
 * fixed string at a time), a scheduled task carries a PROMPT the scheduler runs as
 * a full agent pass when due — tools, recent context, fig's voice. This is the
 * durable replacement for the ephemeral harness cron:
 *   - file-backed, so a task survives any process restart, and
 *   - the due-check is "fireAt <= now" (not "fire exactly at this minute"), so a
 *     task whose fire-time passed while fig was down runs the moment fig is back —
 *     catch-up is automatic, never silently dropped the way the harness cron did.
 *
 * Staleness guard: a one-off missed by more than `maxLateMs` is dropped WITHOUT
 * running, because a late "wake me at 5:50" is useless at noon. The agent sets the
 * window per task based on whether late execution is still worth anything.
 */

export interface ScheduledTask {
  id: string;
  prompt: string; // what fig should DO when this fires (run as a full agent pass)
  label: string; // short human tag for logs
  fireAt: string; // ISO instant
  maxLateMs: number; // drop without running if fired more than this late
  createdAt: string;
}

const FILE = path.join(config.stateDir, "scheduled-tasks.json");
const DEFAULT_MAX_LATE_MS = 60 * 60_000; // 1h within target, else considered stale

const load = (): ScheduledTask[] => readJsonArray<ScheduledTask>(FILE);
const save = (list: ScheduledTask[]): void => writeJson(FILE, list);

export function addScheduledTask(
  prompt: string,
  label: string,
  fireAt: string,
  maxLateMs: number = DEFAULT_MAX_LATE_MS,
): ScheduledTask {
  const list = load();
  const t: ScheduledTask = {
    id: randomUUID().slice(0, 8),
    prompt,
    label,
    fireAt,
    maxLateMs,
    createdAt: new Date().toISOString(),
  };
  list.push(t);
  save(list);
  return t;
}

export function listScheduledTasks(): ScheduledTask[] {
  return load().sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}

export function cancelScheduledTask(id: string): boolean {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** Remove a task by id (used after a successful run). No-op if already gone. */
export function removeScheduledTask(id: string): void {
  const list = load();
  const next = list.filter((t) => t.id !== id);
  if (next.length !== list.length) save(next);
}

/**
 * Classify the store against `now`: `due` = fire-time reached and still within the
 * lateness window (run them); `expired` = fire-time missed by more than maxLateMs
 * (drop without running). Does NOT mutate — the caller removes a task only after it
 * runs successfully (so a transient failure retries next tick) or when expired.
 */
export function dueScheduledTasks(now = new Date()): { due: ScheduledTask[]; expired: ScheduledTask[] } {
  const t = now.getTime();
  const due: ScheduledTask[] = [];
  const expired: ScheduledTask[] = [];
  for (const task of load()) {
    const fire = new Date(task.fireAt).getTime();
    if (fire > t) continue; // not yet
    if (t - fire > task.maxLateMs) expired.push(task);
    else due.push(task);
  }
  return { due, expired };
}
