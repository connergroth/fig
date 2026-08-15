/**
 * Embed every corpus chunk + every eval query with ONE model, into that model's own
 * vector cache. Run as its OWN PROCESS (run.ts spawns it) so wall-clock and peak RSS
 * are attributable to a single model rather than to whichever one loaded first.
 *
 * `tsx scripts/bakeoff/embedCorpus.ts --model granite|harrier [--limit N]`
 *
 * Batching is length-sorted with a padded-token budget rather than a fixed batch size.
 * The corpus is a chat log: most messages are one line, a few are 45,000 chars. Fixed
 * batches pad the short ones out to the longest member and burn most of the compute on
 * padding — on this corpus that's the difference between minutes and an hour.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "../../src/core/config";
import { loadCorpus } from "./corpus";
import { createEmbedder, MODEL_CACHE_DIR } from "./embedder";
import { loadEvalSet } from "./evalSet";
import { modelSpec } from "./models";
import { textKey, VectorStore } from "./vectorStore";

/**
 * Padded tokens per forward pass, and a hard row cap.
 *
 * The budget is what bounds memory: attention is quadratic in sequence length, so a
 * batch of twelve 640-token chunks costs far more than a hundred 40-token ones. The row
 * cap only bites on the short tail — and it has to be generous, because this corpus is
 * mostly short tail. At MAX_BATCH=64 the short chunks were running batches of ~2,500
 * padded tokens against an 8,192 budget, paying per-batch overhead three times more
 * often than necessary.
 */
const TOKEN_BUDGET = 8192;
const MAX_BATCH = 256;

export interface EmbedStats {
  model: string;
  repo: string;
  dim: number;
  dtype: string;
  chunks: number;
  queries: number;
  embeddedNow: number;
  cachedAlready: number;
  loadMs: number;
  embedMs: number;
  forwardMs: number;
  totalMs: number;
  paddedTokens: number;
  /** RSS before transformers.js is even required — the node+corpus floor. */
  rssBaselineBytes: number;
  /** RSS right after the weights are resident, before any forward pass. */
  rssAfterLoadBytes: number;
  /** Sampled every 200ms across the whole run. Dominated by the ORT arena, not weights. */
  peakRssBytes: number;
  maxRssBytes: number;
  dbBytes: number;
  dbPath: string;
  weightsBytes: number;
}

export function vectorDbPath(modelKey: string): string {
  return path.join(config.stateDir, `bakeoff-${modelKey}.db`);
}

/**
 * Cost stats live in a sidecar next to the vector cache, not only on stdout.
 *
 * Embedding is the one step here that costs real wall-clock, so it's also the one
 * that gets skipped on a re-run — and a report that silently prints "0.0 s" for a
 * cached model is worse than one that prints nothing. The sidecar is written by the
 * run that actually paid the cost, and read back by every later `--skip-embed`.
 */
export function statsPath(modelKey: string): string {
  return path.join(config.stateDir, `bakeoff-${modelKey}.stats.json`);
}

export function readEmbedStats(modelKey: string): EmbedStats | null {
  try {
    return JSON.parse(fs.readFileSync(statsPath(modelKey), "utf8")) as EmbedStats;
  } catch {
    return null;
  }
}

function dirBytes(dir: string): number {
  let n = 0;
  const walk = (p: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else
        try {
          n += fs.statSync(full).size;
        } catch {
          /* raced */
        }
    }
  };
  walk(dir);
  return n;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Group indices into batches whose PADDED token cost stays under budget. */
export function planBatches(lengths: number[], budget = TOKEN_BUDGET, maxBatch = MAX_BATCH): number[][] {
  const order = lengths.map((n, i) => i).sort((a, b) => lengths[b] - lengths[a]);
  const batches: number[][] = [];
  let cur: number[] = [];
  let curMax = 0;
  for (const i of order) {
    const nextMax = Math.max(curMax, lengths[i]);
    if (cur.length && (nextMax * (cur.length + 1) > budget || cur.length >= maxBatch)) {
      batches.push(cur);
      cur = [];
      curMax = 0;
    }
    cur.push(i);
    curMax = Math.max(curMax, lengths[i]);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function estTokens(s: string): number {
  return Math.min(640, Math.ceil(s.length / 4) + 2);
}

async function main(): Promise<void> {
  const key = arg("model") ?? "granite";
  const spec = modelSpec(key);
  const limit = Number(arg("limit") ?? 0);
  const t0 = performance.now();

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;
  }, 200);
  sampler.unref();

  const corpus = loadCorpus();
  const evalSet = loadEvalSet();

  let chunkTexts = corpus.chunks.map((c) => c.text);
  if (limit > 0) chunkTexts = chunkTexts.slice(0, limit);
  const queryTexts = evalSet.cases.map((c) => c.query);

  const store = new VectorStore(vectorDbPath(key));
  // Vectors are only comparable within one (repo, dtype, dim, prefix) contract. Mixing
  // a q8 run with a q4 one in the same cache would produce a cosine space that's subtly
  // wrong everywhere and throw no error at all — refuse instead.
  const stamp = `${spec.repo}|${spec.dtype}|${spec.dim}|${spec.queryPrefix ?? ""}`;
  const prior = store.getMeta("contract");
  if (prior && prior !== stamp && store.count() > 0) {
    throw new Error(
      `${vectorDbPath(key)} holds ${store.count()} vectors under a different contract:\n` +
        `  cached: ${prior}\n  now:    ${stamp}\ndelete the file to re-embed.`,
    );
  }
  store.setMeta("contract", stamp);
  store.setMeta("model", spec.key);
  store.setMeta("repo", spec.repo);
  store.setMeta("dim", String(spec.dim));
  store.setMeta("dtype", spec.dtype);
  store.setMeta("queryPrefix", spec.queryPrefix ?? "");

  const rssBaseline = process.memoryUsage().rss;
  const tLoad0 = performance.now();
  const embedder = await createEmbedder(spec);
  const loadMs = performance.now() - tLoad0;
  const rssAfterLoad = process.memoryUsage().rss;
  process.stderr.write(`[${key}] model loaded in ${(loadMs / 1000).toFixed(1)}s\n`);

  // Content-addressed dedupe: identical chunk text (very common in a chat log — "ok",
  // "yeah", repeated briefing boilerplate) is embedded once.
  const work: { key: string; text: string; role: "query" | "document" }[] = [];
  const seen = new Set<string>();
  const push = (text: string, role: "query" | "document"): void => {
    const k = `${role === "query" ? "q:" : "d:"}${textKey(text)}`;
    if (seen.has(k)) return;
    seen.add(k);
    work.push({ key: k, text, role });
  };
  for (const t of chunkTexts) push(t, "document");
  for (const t of queryTexts) push(t, "query");

  const present = store.has(work.map((w) => w.key));
  const todo = work.filter((w) => !present.has(w.key));
  process.stderr.write(
    `[${key}] ${work.length} unique texts, ${present.size} cached, ${todo.length} to embed\n`,
  );

  const tEmbed0 = performance.now();
  const batches = planBatches(todo.map((w) => estTokens(w.text)));
  let done = 0;
  let lastLog = 0;
  for (const batch of batches) {
    // A batch is homogeneous in role by construction only when queries and documents
    // don't mix; they can, so split. Prefixes are asymmetric — mixing would apply the
    // wrong one, which is exactly the silent failure this harness is guarding against.
    for (const role of ["document", "query"] as const) {
      const idx = batch.filter((i) => todo[i].role === role);
      if (!idx.length) continue;
      const vecs = await embedder.encode(
        idx.map((i) => todo[i].text),
        role,
      );
      store.put(idx.map((i, j) => ({ key: todo[i].key, role, vec: vecs[j] })));
      done += idx.length;
    }
    if (done - lastLog >= 500 || done === todo.length) {
      lastLog = done;
      const el = (performance.now() - tEmbed0) / 1000;
      const rate = done / Math.max(el, 0.001);
      const eta = (todo.length - done) / Math.max(rate, 0.001);
      process.stderr.write(
        `[${key}] ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${(eta / 60).toFixed(1)}m  rss ${(peakRss / 1e6).toFixed(0)}MB\n`,
      );
    }
  }
  const embedMs = performance.now() - tEmbed0;

  store.checkpoint();
  const stats: EmbedStats = {
    model: spec.key,
    repo: spec.repo,
    dim: spec.dim,
    dtype: spec.dtype,
    chunks: chunkTexts.length,
    queries: queryTexts.length,
    embeddedNow: todo.length,
    cachedAlready: present.size,
    loadMs,
    embedMs,
    forwardMs: embedder.forwardMs,
    totalMs: performance.now() - t0,
    paddedTokens: embedder.paddedTokens,
    rssBaselineBytes: rssBaseline,
    rssAfterLoadBytes: rssAfterLoad,
    peakRssBytes: peakRss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    dbBytes: store.bytes(),
    dbPath: store.dbPath,
    weightsBytes: dirBytes(path.join(MODEL_CACHE_DIR, spec.repo)),
  };
  store.close();

  // Only overwrite the sidecar when this run actually did the work. A no-op re-run
  // must not clobber the real measurement with zeros.
  if (todo.length > 0 || !readEmbedStats(key)) {
    fs.writeFileSync(statsPath(key), `${JSON.stringify(stats, null, 2)}\n`);
  }
  process.stdout.write(`__STATS__${JSON.stringify(stats)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
