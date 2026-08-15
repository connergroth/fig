import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";

/**
 * Deep-research job store. A research request takes minutes (it fans out across
 * many independent agent contexts), so it can't run inside a single-shot chat turn.
 * Instead the `deep_research` tool enqueues a job here and returns immediately; the
 * background worker (worker.ts) drains the queue, runs the pipeline, and texts the
 * TLDR + Obsidian link when done. Same shape as reminders.ts — a JSON file the
 * worker can reliably scan across daemon restarts.
 */

export type ResearchStatus = "pending" | "running" | "done" | "failed";

export interface ResearchJob {
  id: string;
  question: string;
  /** Optional extra scope/angle the owner gave (budget, region, "focus on X") — shapes the RESEARCH. */
  focus?: string;
  /** Why this was run / how it'll be used — shapes how the orchestrator PACKAGES the result for the owner. */
  intent?: string;
  status: ResearchStatus;
  createdAt: string; // ISO
  /** Set when finished — relative vault path of the written note, e.g. "Wiki/reports/…md". */
  notePath?: string;
  error?: string;
}

const FILE = path.join(config.stateDir, "research-jobs.json");

const load = (): ResearchJob[] => readJsonArray<ResearchJob>(FILE);
const save = (list: ResearchJob[]): void => writeJson(FILE, list);

export function enqueueResearch(question: string, focus?: string, intent?: string): ResearchJob {
  const list = load();
  const job: ResearchJob = {
    id: randomUUID().slice(0, 8),
    question: question.trim(),
    focus: focus?.trim() || undefined,
    intent: intent?.trim() || undefined,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  list.push(job);
  save(list);
  return job;
}

/** Claim the oldest pending job (mark it running) so only one worker runs it. */
export function claimNextPending(): ResearchJob | null {
  const list = load();
  const job = list
    .filter((j) => j.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!job) return null;
  job.status = "running";
  save(list);
  return job;
}

export function finishResearch(id: string, patch: Partial<ResearchJob>): void {
  const list = load();
  const job = list.find((j) => j.id === id);
  if (!job) return;
  Object.assign(job, patch);
  save(list);
}

/** Any job stuck in "running" (e.g. daemon crashed mid-run) gets requeued at boot. */
export function requeueStale(): void {
  const list = load();
  let changed = false;
  for (const j of list) {
    if (j.status === "running") {
      j.status = "pending";
      changed = true;
    }
  }
  if (changed) save(list);
}
