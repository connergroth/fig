/**
 * Bake-off runner.
 *
 * `tsx scripts/bakeoff/run.ts [--models granite,harrier] [--skip-embed] [--rebuild-fts]`
 *
 * Produces recall@1/5/10 + MRR for bm25-only, <model>-vec and <model>-hybrid, broken
 * out by provenance (A = vocabulary-mismatch seeds, B = mined paraphrases, C =
 * exact-token controls), plus a per-case table.
 *
 * Embedding runs in a CHILD PROCESS per model so wall-clock and peak RSS are
 * attributable to one model instead of to whichever loaded first. Vectors are cached
 * per model, so a second run is scoring-only and takes seconds.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config } from "../../src/core/config";
import { loadCorpus, type Corpus } from "./corpus";
import { readEmbedStats, vectorDbPath, type EmbedStats } from "./embedCorpus";
import { loadEvalSet, resolveCases, type ResolvedCase } from "./evalSet";
import { modelSpec, type ModelSpec } from "./models";
import { aggregate, Bm25Searcher, rrf, scoreCase, VecSearcher, type CaseScore, type Metrics, type Ranked } from "./retrieval";
import { textKey, VectorStore } from "./vectorStore";

/** How deep each list goes before RRF fuses them. Deeper than the 10 we score at, so a
 * doc bm25 ranks 30th can still be pulled into the top 10 by the vector list agreeing. */
const FUSE_DEPTH = 50;
const SCORE_K = 10;

/**
 * Deliberately NOT config.repoRoot. That resolves to `bot/src`, not the repo root — a
 * past refactor left it pointing one level in (there's a comment about it in
 * core/prompt.ts). Using it here would look for tsx at bot/src/node_modules.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function mb(n: number): string {
  return `${(n / 1e6).toFixed(1)} MB`;
}
function secs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}
function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5);
}

// ---------------------------------------------------------------------------

function runEmbed(spec: ModelSpec): EmbedStats {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(__dirname, "embedCorpus.ts"), "--model", spec.key],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const line = out.split("\n").find((l) => l.startsWith("__STATS__"));
  if (!line) throw new Error(`embedCorpus for ${spec.key} produced no stats line`);
  return JSON.parse(line.slice("__STATS__".length)) as EmbedStats;
}

interface ConfigResult {
  name: string;
  scores: CaseScore[];
  byCase: Map<string, CaseScore>;
}

function evaluate(name: string, cases: ResolvedCase[], rank: (c: ResolvedCase) => Ranked[]): ConfigResult {
  const scores = cases.map((c) => scoreCase(c.id, rank(c), c.targetDocIds));
  return { name, scores, byCase: new Map(scores.map((s) => [s.caseId, s])) };
}

function slice(res: ConfigResult, cases: ResolvedCase[], prov?: string): Metrics {
  const ids = new Set(cases.filter((c) => !prov || c.provenance === prov).map((c) => c.id));
  return aggregate(res.scores.filter((s) => ids.has(s.caseId)));
}

function metricsRow(label: string, m: Metrics): string {
  return `${label.padEnd(22)} ${String(m.n).padStart(3)}   ${pct(m.r1)}  ${pct(m.r5)}  ${pct(m.r10)}   ${m.mrr.toFixed(4)}`;
}

// ---------------------------------------------------------------------------

function main(): void {
  const modelKeys = (arg("models") ?? "granite,harrier").split(",").map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  const say = (s = ""): void => {
    console.log(s);
    lines.push(s);
  };

  const corpus: Corpus = loadCorpus();
  const { cases, problems } = resolveCases(loadEvalSet(), corpus);
  if (problems.length) {
    console.error(`eval set has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ! ${p}`);
  }

  say(`# embedding bake-off — conversation recall index`);
  say();
  say(`corpus: ${corpus.docs.length} messages, ${corpus.chunks.length} chunks, ${new Set(corpus.docs.map((d) => d.file)).size} files`);
  say(`eval set: ${cases.length} cases (A=${cases.filter((c) => c.provenance === "A").length} vocabulary-mismatch seeds, B=${cases.filter((c) => c.provenance === "B").length} mined paraphrases, C=${cases.filter((c) => c.provenance === "C").length} exact-token controls), ${cases.reduce((n, c) => n + c.targets.length, 0)} ground-truth targets`);
  say(`scored at k=${SCORE_K}; hybrid fuses the top ${FUSE_DEPTH} of each list with RRF (k=60)`);
  say();

  // --- bm25 baseline -------------------------------------------------------
  const ftsPath = path.join(config.stateDir, "bakeoff-fts.db");
  const t0 = performance.now();
  const bm25 = new Bm25Searcher(corpus, ftsPath);
  const ftsStats = bm25.sync(flag("rebuild-fts") || !fs.existsSync(ftsPath));
  say(`bm25 scratch index: ${ftsStats.documents} docs / ${ftsStats.chunks} chunks, ${mb(ftsStats.dbBytes)}, ${secs(performance.now() - t0)}`);

  const bm25Lists = new Map<string, Ranked[]>();
  const bm25FallbackLists = new Map<string, Ranked[]>();
  const tQ = performance.now();
  let emptyLists = 0;
  for (const c of cases) {
    const list = bm25.search(c.query, FUSE_DEPTH);
    if (!list.length) emptyLists++;
    bm25Lists.set(c.id, list);
    bm25FallbackLists.set(c.id, bm25.search(c.query, FUSE_DEPTH, true));
  }
  say(`bm25 queried ${cases.length} cases in ${secs(performance.now() - tQ)}`);
  say(
    `bm25-only returned ZERO rows on ${emptyLists}/${cases.length} cases — fts5's implicit operator is AND, ` +
      `and BrainIndex.search() only advances the matchCandidates ladder on a THROWN error, never on an empty ` +
      `result set, so the OR fallback at the bottom of the ladder is unreachable for natural-language queries. ` +
      `bm25-fallback below is the same index with the ladder also advancing on empty.`,
  );
  say();

  const results: ConfigResult[] = [];
  results.push(evaluate("bm25-only", cases, (c) => (bm25Lists.get(c.id) ?? []).slice(0, SCORE_K)));
  results.push(evaluate("bm25-fallback", cases, (c) => (bm25FallbackLists.get(c.id) ?? []).slice(0, SCORE_K)));

  // --- per model -----------------------------------------------------------
  const embedStats: EmbedStats[] = [];
  for (const key of modelKeys) {
    const spec = modelSpec(key);
    say(`## ${spec.key} (${spec.upstream}, ${spec.params}, ${spec.license}, ${spec.dim}d, ${spec.dtype})`);
    say(`   ONNX build: ${spec.repo}`);
    say(`   pooling=${spec.pooling}  queryPrefix=${spec.queryPrefix ? JSON.stringify(spec.queryPrefix) : "none"}  docPrefix=${spec.docPrefix ? JSON.stringify(spec.docPrefix) : "none"}`);

    if (!flag("skip-embed")) {
      runEmbed(spec);
    } else {
      say(`   (--skip-embed: reusing ${vectorDbPath(key)})`);
    }
    // Always take cost from the sidecar, never from the run that just skipped the
    // work: a cached pass reports 0.0s, which would read as "free" in the report.
    const st = readEmbedStats(key);
    if (st) embedStats.push(st);
    else say(`   !! no cost stats for ${key} — delete ${vectorDbPath(key)} and re-run to measure`);

    const store = new VectorStore(vectorDbPath(key));
    const chunkKeys = corpus.chunks.map((c) => `d:${textKey(c.text)}`);
    const { matrix, missing } = store.loadMatrix(chunkKeys, spec.dim);
    if (missing) say(`   !! ${missing} chunk vectors missing — run without --skip-embed`);
    const vec = new VecSearcher(corpus, matrix, spec.dim);

    const qVecs = new Map<string, Float32Array>();
    for (const c of cases) {
      const v = store.get(`q:${textKey(c.query)}`, spec.dim);
      if (v) qVecs.set(c.id, v);
      else say(`   !! no query vector for ${c.id}`);
    }
    say(`   loaded ${corpus.chunks.length - missing} chunk vectors + ${qVecs.size} query vectors from ${path.basename(store.dbPath)} (${mb(store.bytes())})`);
    store.close();

    const vecLists = new Map<string, Ranked[]>();
    const tv = performance.now();
    for (const c of cases) {
      const qv = qVecs.get(c.id);
      vecLists.set(c.id, qv ? vec.search(qv, FUSE_DEPTH) : []);
    }
    say(`   brute-force cosine: ${cases.length} queries in ${secs(performance.now() - tv)} (${((performance.now() - tv) / cases.length).toFixed(1)} ms/query)`);
    say();

    results.push(evaluate(`${key}-vec`, cases, (c) => (vecLists.get(c.id) ?? []).slice(0, SCORE_K)));
    results.push(
      evaluate(`${key}-hybrid`, cases, (c) => rrf([bm25Lists.get(c.id) ?? [], vecLists.get(c.id) ?? []], SCORE_K)),
    );
    results.push(
      evaluate(`${key}-hybrid+fb`, cases, (c) =>
        rrf([bm25FallbackLists.get(c.id) ?? [], vecLists.get(c.id) ?? []], SCORE_K),
      ),
    );
  }

  // --- tables --------------------------------------------------------------
  const header = `${"config".padEnd(22)}   n   rec@1  rec@5 rec@10     MRR`;
  for (const [label, prov] of [
    ["OVERALL", undefined],
    ["A — vocabulary-mismatch seeds", "A"],
    ["B — mined paraphrases", "B"],
    ["C — exact-token controls", "C"],
  ] as [string, string | undefined][]) {
    say(`### ${label}`);
    say(header);
    say("-".repeat(header.length));
    for (const r of results) say(metricsRow(r.name, slice(r, cases, prov)));
    say();
  }

  // --- hybrid regressions vs bm25 -----------------------------------------
  // Each hybrid is compared against the bm25 variant it actually fuses, so a regression
  // means "adding the vectors made this case worse", not "the two baselines differ".
  for (const [baseName, suffix] of [
    ["bm25-only", "-hybrid"],
    ["bm25-fallback", "-hybrid+fb"],
  ] as [string, string][]) {
    const base = results.find((r) => r.name === baseName);
    if (!base) continue;
    say(`### where ${suffix.slice(1)} is WORSE than ${baseName} alone`);
    let any = false;
    for (const r of results.filter((x) => x.name.endsWith(suffix))) {
      const worse = cases.filter((c) => {
        const b = base.byCase.get(c.id);
        const h = r.byCase.get(c.id);
        if (!b || !h) return false;
        const br = b.rank === 0 ? Infinity : b.rank;
        const hr = h.rank === 0 ? Infinity : h.rank;
        return hr > br;
      });
      say(`${r.name}: ${worse.length} case(s) regressed`);
      for (const c of worse) {
        const b = base.byCase.get(c.id)!;
        const h = r.byCase.get(c.id)!;
        say(`   ${c.id} [${c.provenance}] "${c.query}"  ${baseName} rank ${b.rank || "miss"} -> ${r.name} rank ${h.rank || "miss"}`);
        any = true;
      }
    }
    if (!any) say("   (none)");
    say();
  }

  // --- per case table ------------------------------------------------------
  say(`### per-case ranks (0 = not in top ${SCORE_K})`);
  const cols = results.map((r) => r.name);
  say(`${"case".padEnd(5)} ${"prov".padEnd(4)} ${cols.map((c) => c.padStart(15)).join("")}  query`);
  say("-".repeat(10 + cols.length * 15 + 40));
  for (const c of cases) {
    const cells = cols.map((n) => String(results.find((r) => r.name === n)!.byCase.get(c.id)?.rank ?? "-").padStart(15));
    say(`${c.id.padEnd(5)} ${c.provenance.padEnd(4)} ${cells.join("")}  ${c.query}`);
  }
  say();

  // --- cost ----------------------------------------------------------------
  if (embedStats.length) {
    say(`### cost`);
    say(`${"model".padEnd(10)} ${"embed wall".padStart(11)} ${"fwd only".padStart(10)} ${"load".padStart(8)} ${"RSS loaded".padStart(11)} ${"peak RSS".padStart(10)} ${"weights".padStart(10)} ${"vec db".padStart(10)} ${"texts".padStart(8)}`);
    for (const s of embedStats) {
      say(
        `${s.model.padEnd(10)} ${secs(s.embedMs).padStart(11)} ${secs(s.forwardMs).padStart(10)} ${secs(s.loadMs).padStart(8)} ${mb(s.rssAfterLoadBytes).padStart(11)} ${mb(s.peakRssBytes).padStart(10)} ${mb(s.weightsBytes).padStart(10)} ${mb(s.dbBytes).padStart(10)} ${String(s.embeddedNow).padStart(8)}`,
      );
    }
    say(`(RSS baseline before loading transformers.js: ${embedStats.map((s) => `${s.model} ${mb(s.rssBaselineBytes)}`).join(", ")}. Peak is the onnxruntime arena at a ${8192}-padded-token batch budget, not the weights.)`);
    say();
  }

  bm25.close();

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.txt"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(
      {
        corpus: { messages: corpus.docs.length, chunks: corpus.chunks.length },
        cases: cases.map((c) => ({ id: c.id, provenance: c.provenance, topic: c.topic, kind: c.kind, query: c.query, note: c.note, targets: c.targets.map((t) => t.hash) })),
        configs: results.map((r) => ({
          name: r.name,
          overall: slice(r, cases),
          A: slice(r, cases, "A"),
          B: slice(r, cases, "B"),
          C: slice(r, cases, "C"),
          ranks: Object.fromEntries(r.scores.map((s) => [s.caseId, s.rank])),
        })),
        embedStats,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${path.relative(REPO_ROOT, outDir)}/report.txt and report.json`);
}

main();
