/**
 * Acceptance run: score the PRODUCTION retrieval path on the bake-off's 94 cases.
 *
 * `tsx scripts/bakeoff/runProduction.ts [--k 10] [--keyword-only] [--grid]`
 *
 * The distinction from run.ts matters. run.ts scored a HARNESS re-implementation of
 * retrieval — its own bm25 wrapper, its own RRF, its own vector store — in order to
 * choose a model. This scores `BrainIndex.searchHybrid()` itself: the real fusion, the
 * real snippet builder, the real payload cap, the real lazily-loaded embedder, against
 * the real brain index. If the two disagree, the wiring is wrong, and the point of
 * this file is to make that visible rather than to let production quietly under-deliver
 * numbers that were signed off on a bench.
 *
 * Ground truth is keyed on sha256(message text)[0:16] exactly as in run.ts, resolved
 * through documents.source_id, so the eval set needs no changes to point at production
 * rows.
 *
 * NOTE: deliberately does not import ./embedCorpus — that module calls main() at the
 * top level, so importing it for a path helper would kick off a real embedding run.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { BrainIndex, type SearchOptions } from "../../src/memory/brainIndex";
import { CONTRACT, MODEL } from "../../src/memory/embedder";
import { createConversationSource } from "../../src/memory/conversationSource";
import { config } from "../../src/core/config";
import { loadCorpus, type Corpus } from "./corpus";
import { loadEvalSet, resolveCases, type ResolvedCase } from "./evalSet";
import { aggregate, scoreCase, type CaseScore, type Metrics } from "./retrieval";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5);
}
function metricsRow(label: string, m: Metrics): string {
  return `${label.padEnd(24)} ${String(m.n).padStart(3)}   ${pct(m.r1)}  ${pct(m.r5)}  ${pct(m.r10)}   ${m.mrr.toFixed(4)}`;
}

function loadSqlite(): typeof import("node:sqlite") {
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return (orig as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** documents.id -> the eval set's dense corpus id, via source_id. */
function buildDocIdMap(dbPath: string, corpus: Corpus): Map<number, number> {
  const { DatabaseSync } = loadSqlite();
  const db: DatabaseSync = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT id, source_id FROM documents WHERE source_type = 'conversation'")
    .all() as { id: number; source_id: string }[];
  db.close();
  const out = new Map<number, number>();
  for (const r of rows) {
    const doc = corpus.bySourceId.get(r.source_id);
    if (doc) out.set(r.id, doc.id);
  }
  return out;
}

async function main(): Promise<void> {
  const SCORE_K = Number(arg("k") ?? 10);
  const keywordOnly = flag("keyword-only");
  const lines: string[] = [];
  const say = (s = ""): void => {
    console.log(s);
    lines.push(s);
  };

  const corpus = loadCorpus();
  const { cases, problems } = resolveCases(loadEvalSet(), corpus);
  for (const p of problems) console.error(`  ! ${p}`);

  // The REAL index at the REAL path — not a scratch copy. This is the same db
  // recall_conversations reads.
  // Fusion overrides, so the acceptance run can also demonstrate what production
  // scores WITHOUT the category-C constraint — which is how "we're below the harness"
  // gets distinguished from "we're wired wrong".
  const fusion: Record<string, number | boolean> = {};
  if (arg("vec-depth")) fusion.vecDepth = Number(arg("vec-depth"));
  if (arg("bm25-depth")) fusion.bm25Depth = Number(arg("bm25-depth"));
  if (arg("bm25-weight")) fusion.bm25Weight = Number(arg("bm25-weight"));
  if (arg("agree")) fusion.agreeDepth = Number(arg("agree"));
  const idx = new BrainIndex({
    sources: [createConversationSource()],
    fusion: Object.keys(fusion).length ? (fusion as never) : undefined,
  });
  const stats = idx.stats();
  const vstat = idx.vectorStatus();
  const docIdMap = buildDocIdMap(idx.dbPath, corpus);

  say(`# production retrieval — acceptance run`);
  say();
  say(`index:  ${idx.dbPath}`);
  say(`        ${stats.documents} documents, ${stats.chunks} chunks, ${(stats.dbBytes / 1e6).toFixed(1)} MB`);
  say(`vectors: ${vstat.vectors}/${vstat.chunks}${vstat.mismatch ? "  !! CONTRACT MISMATCH" : ""}`);
  say(`model:  ${MODEL.upstream} ${MODEL.dim}d ${MODEL.dtype}`);
  // Report the fusion ACTUALLY in use, overrides included — not the module defaults.
  say(`fusion: bm25 ${idx.fusion.bm25Source} depth ${idx.fusion.bm25Depth} x weight ${idx.fusion.bm25Weight}, ` +
      `vec depth ${idx.fusion.vecDepth}, RRF k=${idx.fusion.rrfK}, ` +
      `agreeDepth=${idx.fusion.agreeDepth}, floor=${idx.fusion.floorStrictRanks}, pin=${idx.fusion.pinTopBm25}`);
  say(`mapped ${docIdMap.size} production documents onto ${corpus.docs.length} corpus messages`);
  say(`eval:   ${cases.length} cases (A=${cases.filter((c) => c.provenance === "A").length}, ` +
      `B=${cases.filter((c) => c.provenance === "B").length}, C=${cases.filter((c) => c.provenance === "C").length})`);
  say();

  if (vstat.vectors === 0 && !keywordOnly) {
    say(`!! no vectors in the index — run \`npm run embed:brain\` first. Scoring keyword-only.`);
  }

  const baseOpts = (c: ResolvedCase): SearchOptions => ({
    query: c.query,
    sourceTypes: ["conversation"],
    k: SCORE_K,
  });

  // --- production keyword path (the bm25 ladder, WITH the empty-result fix) ---
  const kwScores: CaseScore[] = [];
  const tKw = performance.now();
  for (const c of cases) {
    const res = idx.search(baseOpts(c));
    const ranked = res.results.map((h) => ({ docId: docIdMap.get(h.document_id) ?? -1, score: 0 }));
    kwScores.push(scoreCase(c.id, ranked, c.targetDocIds));
  }
  const kwMs = performance.now() - tKw;

  // --- production hybrid path ---
  const hyScores: CaseScore[] = [];
  let hybridUsed = 0;
  let embedMsTotal = 0;
  const tHy = performance.now();
  if (!keywordOnly) {
    for (const c of cases) {
      const t0 = performance.now();
      const res = await idx.searchHybrid(baseOpts(c));
      embedMsTotal += performance.now() - t0;
      if (res.retrieval === "hybrid") hybridUsed++;
      const ranked = res.results.map((h) => ({ docId: docIdMap.get(h.document_id) ?? -1, score: 0 }));
      hyScores.push(scoreCase(c.id, ranked, c.targetDocIds));
    }
  }
  const hyMs = performance.now() - tHy;

  say(`keyword: ${cases.length} queries in ${(kwMs / 1000).toFixed(1)}s (${(kwMs / cases.length).toFixed(1)} ms/query)`);
  if (!keywordOnly) {
    say(`hybrid:  ${cases.length} queries in ${(hyMs / 1000).toFixed(1)}s ` +
        `(${(hyMs / cases.length).toFixed(0)} ms/query, incl. query embedding), ` +
        `${hybridUsed}/${cases.length} actually fused`);
  }
  say();

  const configs: { name: string; scores: CaseScore[] }[] = [
    { name: "production-keyword", scores: kwScores },
  ];
  if (!keywordOnly) configs.push({ name: "production-hybrid", scores: hyScores });

  const byName = new Map(configs.map((c) => [c.name, new Map(c.scores.map((s) => [s.caseId, s]))]));

  const header = `${"config".padEnd(24)}   n   rec@1  rec@5 rec@10     MRR`;
  const slices: [string, string | undefined][] = [
    ["OVERALL", undefined],
    ["A — vocabulary-mismatch seeds", "A"],
    ["B — mined paraphrases", "B"],
    ["C — exact-token controls", "C"],
  ];
  const got: Record<string, Record<string, Metrics>> = {};
  for (const [label, prov] of slices) {
    say(`### ${label}`);
    say(header);
    say("-".repeat(header.length));
    const ids = new Set(cases.filter((c) => !prov || c.provenance === prov).map((c) => c.id));
    for (const cfg of configs) {
      const m = aggregate(cfg.scores.filter((s) => ids.has(s.caseId)));
      (got[cfg.name] ??= {})[prov ?? "overall"] = m;
      say(metricsRow(cfg.name, m));
    }
    say();
  }

  // --- comparison against the harness numbers that justified this build ---
  // These are the measured targets from scripts/bakeoff/results/report.json. Production
  // landing materially below them means a wiring bug, not a tuning preference.
  const TARGET = {
    "bm25-fallback": { overall: 0.2587, A: 0.1581, B: 0.0736, C: 0.8338 },
    "harrier-hybrid": { overall: 0.4426, A: 0.293, B: 0.3683, C: 0.8155 },
  };
  say(`### vs the harness (scripts/bakeoff/results/report.json)`);
  say(`${"".padEnd(24)} ${"overall".padStart(9)} ${"A".padStart(9)} ${"B".padStart(9)} ${"C".padStart(9)}`);
  const cmp = (label: string, m: Record<string, Metrics>, t: Record<string, number>): void => {
    const cells = (["overall", "A", "B", "C"] as const).map((k) => {
      const d = m[k].mrr - t[k];
      return `${m[k].mrr.toFixed(4)}${d >= 0 ? "+" : "-"}`.padStart(9);
    });
    say(`${label.padEnd(24)} ${cells.join(" ")}`);
  };
  say(`harness bm25-fallback    ${["overall", "A", "B", "C"].map((k) => TARGET["bm25-fallback"][k as "A"].toFixed(4).padStart(9)).join(" ")}`);
  say(`harness harrier-hybrid   ${["overall", "A", "B", "C"].map((k) => TARGET["harrier-hybrid"][k as "A"].toFixed(4).padStart(9)).join(" ")}`);
  say("-".repeat(66));
  cmp("production-keyword", got["production-keyword"], TARGET["bm25-fallback"]);
  if (got["production-hybrid"]) cmp("production-hybrid", got["production-hybrid"], TARGET["harrier-hybrid"]);
  say();

  // --- the hard requirement ---
  if (got["production-hybrid"]) {
    const cHybrid = got["production-hybrid"].C.mrr;
    const cKeyword = got["production-keyword"].C.mrr;
    say(`### category C requirement: hybrid MRR >= fixed-bm25 baseline`);
    say(`  production-keyword C: ${cKeyword.toFixed(4)}`);
    say(`  production-hybrid  C: ${cHybrid.toFixed(4)}`);
    say(`  ${cHybrid >= cKeyword ? "PASS" : "FAIL"} — exact-token controls ${cHybrid >= cKeyword ? "did not regress" : "REGRESSED"}`);
    say();

    // Per-case regressions, so a win-on-average that quietly breaks a case is visible.
    const kw = byName.get("production-keyword")!;
    const hy = byName.get("production-hybrid")!;
    const worse = cases.filter((c) => {
      const a = kw.get(c.id)!.rank || Infinity;
      const b = hy.get(c.id)!.rank || Infinity;
      return b > a;
    });
    say(`### where hybrid is WORSE than the production keyword path (${worse.length} case(s))`);
    for (const c of worse) {
      say(`   ${c.id} [${c.provenance}] "${c.query}"  keyword rank ${kw.get(c.id)!.rank || "miss"} -> hybrid rank ${hy.get(c.id)!.rank || "miss"}`);
    }
    if (!worse.length) say("   (none)");
    say();
  }

  // --- per case ---
  say(`### per-case ranks (0 = not in top ${SCORE_K})`);
  say(`${"case".padEnd(5)} ${"prov".padEnd(4)} ${configs.map((c) => c.name.padStart(20)).join("")}  query`);
  say("-".repeat(12 + configs.length * 20 + 40));
  for (const c of cases) {
    const cells = configs.map((cfg) => String(byName.get(cfg.name)!.get(c.id)?.rank ?? "-").padStart(20));
    say(`${c.id.padEnd(5)} ${c.provenance.padEnd(4)} ${cells.join("")}  ${c.query}`);
  }
  say();

  idx.close();

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "production.txt"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(outDir, "production.json"),
    `${JSON.stringify(
      {
        contract: CONTRACT,
        index: { path: idx.dbPath, documents: stats.documents, chunks: stats.chunks, vectors: vstat.vectors },
        fusion: idx.fusion,
        timing: { keywordMsPerQuery: kwMs / cases.length, hybridMsPerQuery: hyMs / cases.length },
        metrics: got,
        ranks: Object.fromEntries(
          configs.map((cfg) => [cfg.name, Object.fromEntries(cfg.scores.map((s) => [s.caseId, s.rank]))]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${path.relative(REPO_ROOT, outDir)}/production.txt and production.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
