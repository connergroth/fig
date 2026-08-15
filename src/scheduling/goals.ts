import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";

/**
 * The goal registry: long-running, self-driving objectives.
 *
 * A watch (see watches.ts) is PASSIVE — it re-checks a condition each cycle and
 * stays quiet until the world changes. A goal is ACTIVE — each cycle it does the
 * next increment of real WORK toward an objective, appends what it found to a
 * progress doc, then judges itself against an EXPLICIT, countable finish line.
 *
 * The whole point is that "done" is not vibes. The agent does not get to decide
 * it's finished because it feels like enough — it only terminates when the
 * `doneCriteria` is objectively met (or it hits the iteration cap as a backstop).
 * That's what keeps it grinding instead of quitting early.
 *
 * Reporting is decoupled from work: by default a goal runs SILENTLY and only
 * texts the owner when it's DONE. Set `reportEvery` to also surface an interim
 * update every N work-passes.
 *
 * Like watches, the registry lives in the vault state dir so the agent can append
 * rows live (no approval prompt). The accumulating progress doc lives in the vault
 * under `Grind/<id>.md` so the owner can literally watch it grind in Obsidian.
 * (NOT `Goals/` - that folder is the owner's formalized life-goals board, a separate thing.)
 */

export interface Goal {
  /** Stable slug, unique in the registry. */
  id: string;
  /** Human label for logs/state ("find 3 surviving project ideas"). */
  label: string;
  /** The objective — what the loop is working toward, in plain language. */
  goal: string;
  /**
   * The EXPLICIT, ideally countable finish line. This is checked literally each
   * pass ("3 ideas that survive all 4 filters with deep recon on each"), NOT a
   * gut feeling. If this is vague, the goal will either quit early or never stop.
   */
  doneCriteria: string;
  /** Vault-relative path to the accumulating progress doc. */
  progressFile: string;
  /** Cadence for doing the next work-pass (scheduler grammar: "every 30m", "every 2h"). */
  schedule: string;
  /** Optional: also send the owner an interim update every N work-passes. Omit = silent until done. */
  reportEvery?: number;
  /** Hard backstop — stop after this many passes even if criteria unmet, and report where it landed. */
  maxPasses: number;
  /** Passes run so far (scheduler-managed). */
  passes: number;
  /** ISO when created. */
  createdISO: string;
  /** Optional wall-clock hard stop. */
  expiresISO?: string;
  /** ISO of the last pass (scheduler-managed). */
  lastFiredISO?: string;
}

const GOALS_FILE = path.join(config.stateDir, "goals.json");

export function loadGoals(): Goal[] {
  return readJsonArray<Goal>(GOALS_FILE);
}

export function saveGoals(goals: Goal[]): void {
  // Called from the scheduler tick — swallow a transient write failure rather
  // than crash the loop; the next save reconciles.
  try {
    writeJson(GOALS_FILE, goals);
  } catch (e) {
    warn(`saveGoals failed: ${e}`);
  }
}

/** Drop a goal by id (completion / cancellation). Returns true if removed. */
export function removeGoal(id: string): boolean {
  const goals = loadGoals();
  const next = goals.filter((g) => g.id !== id);
  if (next.length === goals.length) return false;
  saveGoals(next);
  return true;
}

/** Stamp a goal's lastFiredISO and bump its pass count after a pass runs. */
export function markGoalPass(id: string, atISO: string): void {
  const goals = loadGoals();
  const g = goals.find((x) => x.id === id);
  if (!g) return;
  g.lastFiredISO = atISO;
  g.passes = (g.passes ?? 0) + 1;
  saveGoals(goals);
}

/** True if the goal has passed its hard expiry. */
export function isGoalExpired(g: Goal, now: Date): boolean {
  return !!g.expiresISO && new Date(g.expiresISO).getTime() <= now.getTime();
}
