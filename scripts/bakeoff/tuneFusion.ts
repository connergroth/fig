/**
 * Grid-search the fusion knobs against the 94-case eval set, through the REAL
 * BrainIndex.searchHybrid() code path.
 *
 * `tsx scripts/bakeoff/tuneFusion.ts [--seed] [--top 15]`
 *
 * Why a scratch index: the production backfill takes ~90 minutes, and a grid search
 * needs the vectors present before it can start. The bake-off already embedded this
 * exact corpus with this exact model, and scripts/dev/verify-contract.ts confirmed the
 * production embedder reproduces those vectors at cosine 1.0000 — so they can be
 * lifted straight into a scratch index, keyed by sha256(chunk text). Same vectors,
 * same code path, ~40 minutes saved.
 *
 * Query vectors also come from the bake-off cache, via the `embed` seam, so a sweep of
 * N configs doesn't re-embed 94 queries N times.
 *
 * The constraint being optimized under is NOT "highest overall MRR". Category C
 * (exact-token controls) must not regress below the fixed-bm25 baseline — a hybrid
 * that improves the average by breaking the half keyword search already does well is
 * not an improvement. Configs that violate it are printed but disqualified.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { BrainIndex, type FusionConfig, type SearchOptions } from "../../src/memory/brainIndex";
import { MODEL } from "../../src/memory/embedder";
import { createConversationSource } from "../../src/memory/conversationSource";
import { config } from "../../src/core/config";
import { loadCorpus, type Corpus } from "./corpus";
import { loadEvalSet, resolveCases, type ResolvedCase } from "./evalSet";
import { aggregate, scoreCase, type CaseScore, type Metrics } from "./retrieval";
import { VectorStore, textKey } from "./vectorStore";

const SCORE_K = 10;
const SCRATCH_DB = path.join(config.stateDir, "bakeoff-production.db");
/** Same path embedCorpus.ts uses — inlined so importing it can't trigger its main(). */
const HARRIER_VECTORS = path.join(config.stateDir, "bakeoff-harrier.db");

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5);
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

/** Copy bake-off vectors into the scratch index, matching chunks by text hash. */
function seedVectors(dbPath: string): { seeded: number; missing: number } {
  const store = new VectorStore(HARRIER_VECTORS);
  const { DatabaseSync } = loadSqlite();
  const db: DatabaseSync = new DatabaseSync(dbPath);
  const chunks = db.prepare("SELECT id, text FROM chunks").all() as { id: number; text: string }[];

  const ins = db.prepare("INSERT OR REPLACE INTO chunk_vectors (chunk_id, vec) VALUES (?, ?)");
  let seeded = 0;
  let missing = 0;
  db.exec("BEGIN");
  for (const c of chunks) {
    const v = store.get(`d:${textKey(c.text)}`, MODEL.dim);
    if (!v) {
      missing++;
      continue;
    }
    ins.run(c.id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    seeded++;
  }
  db.prepare("INSERT INTO index_meta (k, v) VALUES ('embed_contract', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(
    `${MODEL.repo}|${MODEL.dtype}|${MODEL.dim}|${MODEL.queryPrefix}`,
  );
  db.exec("COMMIT");
  db.close();
  store.close();
  return { seeded, missing };
}

async function main(): Promise<void> {
  const corpus: Corpus = loadCorpus();
  const { cases } = resolveCases(loadEvalSet(), corpus);

  // --- scratch index ---
  const needsBuild = flag("seed") || !fs.existsSync(SCRATCH_DB);
  if (needsBuild) {
    console.log(`building scratch index at ${SCRATCH_DB}…`);
    const build = new BrainIndex({ dbPath: SCRATCH_DB, sources: [createConversationSource()] });
    build.rebuildAll();
    build.close();
    const { seeded, missing } = seedVectors(SCRATCH_DB);
    console.log(`  seeded ${seeded} chunk vectors from the bake-off cache (${missing} missing)\n`);
  }

  // --- query vectors, from the bake-off cache, embedded once ---
  const qstore = new VectorStore(HARRIER_VECTORS);
  const qvecs = new Map<string, Float32Array>();
  for (const c of cases) {
    const v = qstore.get(`q:${textKey(c.query)}`, MODEL.dim);
    if (v) qvecs.set(c.query, v);
  }
  qstore.close();
  console.log(`loaded ${qvecs.size}/${cases.length} cached query vectors`);
  if (qvecs.size < cases.length) {
    console.error(`  !! missing query vectors — run the bake-off first`);
    process.exit(1);
  }

  const docIdMap = (() => {
    const { DatabaseSync } = loadSqlite();
    const db: DatabaseSync = new DatabaseSync(SCRATCH_DB);
    const rows = db.prepare("SELECT id, source_id FROM documents").all() as { id: number; source_id: string }[];
    db.close();
    const m = new Map<number, number>();
    for (const r of rows) {
      const d = corpus.bySourceId.get(r.source_id);
      if (d) m.set(r.id, d.id);
    }
    return m;
  })();

  const cachedEmbed = async (texts: string[], role: "query" | "document"): Promise<Float32Array[] | null> => {
    if (role !== "query") return null;
    const v = qvecs.get(texts[0]);
    return v ? [v] : null;
  };

  async function evaluate(fusion: Partial<FusionConfig>): Promise<Record<string, Metrics>> {
    const idx = new BrainIndex({
      dbPath: SCRATCH_DB,
      sources: [createConversationSource()],
      embed: cachedEmbed,
      fusion,
    });
    const scores: CaseScore[] = [];
    for (const c of cases) {
      const opts: SearchOptions = { query: c.query, sourceTypes: ["conversation"], k: SCORE_K };
      const res = await idx.searchHybrid(opts);
      scores.push(
        scoreCase(
          c.id,
          res.results.map((h) => ({ docId: docIdMap.get(h.document_id) ?? -1, score: 0 })),
          c.targetDocIds,
        ),
      );
    }
    idx.close();
    const out: Record<string, Metrics> = {};
    for (const prov of [undefined, "A", "B", "C"] as (string | undefined)[]) {
      const ids = new Set(cases.filter((c: ResolvedCase) => !prov || c.provenance === prov).map((c) => c.id));
      out[prov ?? "overall"] = aggregate(scores.filter((s) => ids.has(s.caseId)));
    }
    return out;
  }

  // --- the baseline the C constraint is measured against ---
  const kwIdx = new BrainIndex({ dbPath: SCRATCH_DB, sources: [createConversationSource()] });
  const kwScores: CaseScore[] = cases.map((c) =>
    scoreCase(
      c.id,
      kwIdx
        .search({ query: c.query, sourceTypes: ["conversation"], k: SCORE_K })
        .results.map((h) => ({ docId: docIdMap.get(h.document_id) ?? -1, score: 0 })),
      c.targetDocIds,
    ),
  );
  kwIdx.close();
  const kwC = aggregate(kwScores.filter((s) => cases.find((c) => c.id === s.caseId)?.provenance === "C"));
  const kwAll = aggregate(kwScores);
  console.log(`\nkeyword baseline (production bm25, empty-fallback fix in place):`);
  console.log(`  overall MRR ${kwAll.mrr.toFixed(4)}   C MRR ${kwC.mrr.toFixed(4)} (r@10 ${pct(kwC.r10)}%)`);
  console.log(`\nconstraint: hybrid C MRR must be >= ${kwC.mrr.toFixed(4)}\n`);

  // --- grid ---
  const grid: Partial<FusionConfig>[] = [];
  for (const vecDepth of [10, 20, 30, 50]) {
    for (const agreeDepth of [0, 3]) {
      for (const bm25Weight of [1.0, 1.2]) {
        for (const bm25Depth of [5, 20]) {
          grid.push({
            bm25Source: "strict",
            bm25Depth,
            vecDepth,
            rrfK: 60,
            bm25Weight,
            pinTopBm25: true,
            floorStrictRanks: false,
            agreeDepth,
          });
        }
      }
    }
  }

  const rows: { cfg: Partial<FusionConfig>; m: Record<string, Metrics>; ok: boolean }[] = [];
  for (const cfg of grid) {
    const m = await evaluate(cfg);
    rows.push({ cfg, m, ok: m.C.mrr >= kwC.mrr - 1e-9 });
    process.stdout.write(
      `  vd=${String(cfg.vecDepth).padStart(2)} agree=${String(cfg.agreeDepth).padStart(2)} w=${String(cfg.bm25Weight).padEnd(3)} bd=${String(cfg.bm25Depth).padStart(2)}  ` +
        `overall ${m.overall.mrr.toFixed(4)}  A ${m.A.mrr.toFixed(4)}  B ${m.B.mrr.toFixed(4)}  ` +
        `C ${m.C.mrr.toFixed(4)} ${m.C.mrr >= kwC.mrr - 1e-9 ? "ok " : "VIOL"}\n`,
    );
  }

  const top = Number(arg("top") ?? 15);
  const eligible = rows.filter((r) => r.ok).sort((a, b) => b.m.overall.mrr - a.m.overall.mrr);
  console.log(`\n=== eligible configs (C constraint satisfied), best first ===`);
  console.log(
    `${"vecD".padStart(5)} ${"agree".padStart(6)} ${"w".padStart(5)} ${"bmD".padStart(4)}  ` +
      `${"overall".padStart(8)} ${"A".padStart(7)} ${"B".padStart(7)} ${"C".padStart(7)}`,
  );
  for (const r of eligible.slice(0, top)) {
    console.log(
      `${String(r.cfg.vecDepth).padStart(5)} ${String(r.cfg.agreeDepth).padStart(6)} ${String(r.cfg.bm25Weight).padStart(5)} ${String(r.cfg.bm25Depth).padStart(4)}  ` +
        `${r.m.overall.mrr.toFixed(4).padStart(8)} ${r.m.A.mrr.toFixed(4).padStart(7)} ` +
        `${r.m.B.mrr.toFixed(4).padStart(7)} ${r.m.C.mrr.toFixed(4).padStart(7)}`,
    );
  }
  if (!eligible.length) console.log("  (none — every config regressed category C)");

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "tuning.json"),
    `${JSON.stringify({ keywordBaseline: { overall: kwAll, C: kwC }, grid: rows }, null, 2)}\n`,
  );
  console.log(`\nwrote results/tuning.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
