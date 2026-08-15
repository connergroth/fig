/**
 * Merge scripts/bakeoff/parts/*.json into scripts/bakeoff/eval-set.json, validating
 * every target against the live corpus on the way through.
 *
 * `tsx scripts/bakeoff/buildEvalSet.ts [--strict]`
 *
 * The parts/ dir is where cases are AUTHORED (one file per mining pass, so the set can
 * grow one slice at a time). eval-set.json is the merged artifact the harness reads.
 * Anything that fails to resolve is reported and dropped rather than written through —
 * a case with a wrong answer is worse than no case.
 */

import fs from "node:fs";
import path from "node:path";

import { loadCorpus } from "./corpus";
import { resolveCases, type EvalCase, type EvalSet } from "./evalSet";

const PARTS_DIR = path.join(__dirname, "parts");
const OUT = path.join(__dirname, "eval-set.json");

function main(): void {
  const strict = process.argv.includes("--strict");
  const corpus = loadCorpus();
  console.log(`corpus: ${corpus.docs.length} messages, ${corpus.chunks.length} chunks`);

  const files = fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort();
  const all: EvalCase[] = [];
  for (const f of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, f), "utf8")) as EvalCase[] | EvalSet;
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;
    console.log(`  ${f}: ${cases.length} cases`);
    all.push(...cases);
  }

  const draft: EvalSet = {
    version: 1,
    description:
      "Retrieval eval for the conversation recall index. A = known vocabulary-mismatch seeds, " +
      "B = mined paraphrases sampled across the whole date range, C = exact-token controls where " +
      "bm25 should win. Targets are keyed by sha256(message)[0:16] so they survive file edits.",
    cases: all,
  };

  const { cases, problems } = resolveCases(draft, corpus);
  for (const p of problems) console.log(`  ! ${p}`);
  if (strict && problems.length) {
    console.error(`\n${problems.length} problem(s) with --strict — not writing`);
    process.exit(1);
  }

  const kept = new Set(cases.map((c) => c.id));
  draft.cases = all.filter((c) => kept.has(c.id));
  fs.writeFileSync(OUT, `${JSON.stringify(draft, null, 2)}\n`);

  const byProv: Record<string, number> = {};
  let targets = 0;
  for (const c of draft.cases) {
    byProv[c.provenance] = (byProv[c.provenance] ?? 0) + 1;
    targets += c.targets.length;
  }
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${draft.cases.length} cases (${Object.entries(byProv).map(([k, v]) => `${k}=${v}`).join(" ")}), ${targets} targets`);
  console.log(`  dropped ${all.length - draft.cases.length}`);
}

main();
