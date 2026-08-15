/**
 * Eval-set types + loader/validator.
 *
 * The set is a checked-in DATA file (eval-set.json) kept separate from the harness so
 * it can grow without touching code. Validation is not optional politeness: every
 * target is re-resolved against the live corpus by content hash on load, and a case
 * whose answer no longer exists is a hard failure rather than a silent miss. An eval
 * set that quietly rots produces numbers that look fine and mean nothing.
 */

import fs from "node:fs";
import path from "node:path";

import type { Corpus } from "./corpus";

export type Provenance = "A" | "B" | "C";

export interface EvalTarget {
  /** sha256(message text)[0..16). The stable key. */
  hash: string;
  date: string;
  time: string;
  speaker: string;
  sourceId: string;
  preview: string;
}

export interface EvalCase {
  id: string;
  provenance: Provenance;
  query: string;
  note?: string;
  /** B only: food / gym / school / work / spot / finance / travel / people / infra … */
  topic?: string;
  /** C only: numeric / proper-noun / engineering / rare-phrase */
  kind?: string;
  targets: EvalTarget[];
}

export interface EvalSet {
  version: number;
  description: string;
  cases: EvalCase[];
}

export interface ResolvedCase extends EvalCase {
  /** Corpus doc ids for every target. A hit on ANY of these counts. */
  targetDocIds: number[];
}

export const EVAL_SET_PATH = path.join(__dirname, "eval-set.json");

export function loadEvalSet(file: string = EVAL_SET_PATH): EvalSet {
  return JSON.parse(fs.readFileSync(file, "utf8")) as EvalSet;
}

export interface ResolveResult {
  cases: ResolvedCase[];
  problems: string[];
}

/**
 * Bind every case's targets to corpus doc ids.
 *
 * Resolution is by content hash first (survives file edits and re-ordering), narrowed
 * by date when a hash is ambiguous — short messages like "yeah" genuinely repeat, and
 * silently binding to the wrong "yeah" would be the worst kind of bug here.
 */
export function resolveCases(set: EvalSet, corpus: Corpus): ResolveResult {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const cases: ResolvedCase[] = [];

  for (const c of set.cases) {
    if (seenIds.has(c.id)) problems.push(`${c.id}: duplicate case id`);
    seenIds.add(c.id);
    if (!c.query?.trim()) problems.push(`${c.id}: empty query`);
    if (!c.targets?.length) problems.push(`${c.id}: no targets`);

    const ids: number[] = [];
    for (const t of c.targets ?? []) {
      const byHash = corpus.byHash.get(t.hash) ?? [];
      if (!byHash.length) {
        problems.push(`${c.id}: target hash ${t.hash} not found in corpus (${t.date} ${t.time} "${t.preview?.slice(0, 60)}")`);
        continue;
      }
      const narrowed = byHash.length === 1 ? byHash : byHash.filter((d) => d.date === t.date && d.time === t.time);
      if (!narrowed.length) {
        problems.push(`${c.id}: target hash ${t.hash} exists but not at ${t.date} ${t.time}`);
        continue;
      }
      if (narrowed.length > 1) {
        problems.push(`${c.id}: target hash ${t.hash} is ambiguous (${narrowed.length} messages) — counted as relevant set`);
      }
      // Metadata drift is a warning, not a failure: the hash is the contract.
      const first = narrowed[0];
      if (t.speaker && first.speaker !== t.speaker) {
        problems.push(`${c.id}: target ${t.hash} speaker drift (set=${t.speaker} corpus=${first.speaker})`);
      }
      if (t.sourceId && first.sourceId !== t.sourceId) {
        problems.push(`${c.id}: target ${t.hash} sourceId drift (set=${t.sourceId} corpus=${first.sourceId})`);
      }
      for (const d of narrowed) if (!ids.includes(d.id)) ids.push(d.id);
    }
    if (!ids.length) {
      problems.push(`${c.id}: DROPPED — no target resolved`);
      continue;
    }
    cases.push({ ...c, targetDocIds: ids });
  }

  return { cases, problems };
}
