/**
 * The three retrieval configs under test: bm25-only, vec-only, hybrid (RRF).
 *
 * bm25 is not re-implemented here. The scratch index is built by a real BrainIndex over
 * the real conversation adapter, and queries go through the real matchCandidates()
 * sanitizer ladder against the real `porter unicode61` fts5 table. If the baseline
 * weren't the actual production ranking, "the embedder beat bm25" would be an
 * unfalsifiable claim about a strawman.
 *
 * The one thing this bypasses is the production snippet + 8k payload cap, which exists
 * to protect the model's context and would otherwise silently truncate a top-10 list
 * mid-measurement. We're scoring ranking quality, not payload budgeting.
 */

import type { DatabaseSync } from "node:sqlite";

import { BrainIndex, _internals } from "../../src/memory/brainIndex";
import { createConversationSource } from "../../src/memory/conversationSource";
import type { Corpus } from "./corpus";

export interface Ranked {
  docId: number;
  score: number;
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

// ---------------------------------------------------------------------------
// bm25
// ---------------------------------------------------------------------------

const RANK_SQL =
  "SELECT d.source_id AS source_id, bm25(fts_chunks) AS score " +
  "FROM fts_chunks JOIN chunks c ON c.id = fts_chunks.rowid JOIN documents d ON d.id = c.document_id " +
  "WHERE fts_chunks MATCH ? AND d.source_type = 'conversation' " +
  "ORDER BY bm25(fts_chunks) ASC LIMIT ?";

export class Bm25Searcher {
  readonly dbPath: string;
  private index: BrainIndex;
  private db: DatabaseSync | null = null;

  constructor(
    private corpus: Corpus,
    dbPath: string,
  ) {
    this.dbPath = dbPath;
    this.index = new BrainIndex({ dbPath, sources: [createConversationSource()] });
  }

  /** Build (or incrementally refresh) the scratch fts index, then open it for reads. */
  sync(rebuild = false): { documents: number; chunks: number; dbBytes: number } {
    if (rebuild) this.index.rebuildAll();
    else this.index.syncAll();
    const s = this.index.stats();
    this.index.close();
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.dbPath);
    return { documents: s.documents, chunks: s.chunks, dbBytes: s.dbBytes };
  }

  /**
   * Top-k documents by bm25, chunks collapsed to their best chunk.
   *
   * `fallbackOnEmpty` is the difference between the CURRENT production behaviour and
   * what production arguably should do. `BrainIndex.search()` walks the matchCandidates
   * ladder and stops at the first candidate that doesn't THROW — but candidate #1 is the
   * raw query, and fts5's implicit operator is AND. A seven-word natural-language
   * question almost never has all seven terms in one chunk, so it returns zero rows
   * without throwing, and the OR fallback at the bottom of the ladder is never reached.
   *
   * With the flag on, an empty result set also advances the ladder. Both are measured,
   * because otherwise "embeddings beat bm25" is partly just "bm25 was never asked".
   */
  search(query: string, k: number, fallbackOnEmpty = false): Ranked[] {
    if (!this.db) throw new Error("Bm25Searcher.sync() first");
    // Over-fetch chunks so the collapse to k DOCUMENTS isn't starved by one long
    // message occupying the whole page with windows of itself.
    let rows: { source_id: string; score: number }[] = [];
    for (const cand of _internals.matchCandidates(query)) {
      try {
        rows = this.db.prepare(RANK_SQL).all(cand, k * 8) as unknown as { source_id: string; score: number }[];
        if (rows.length || !fallbackOnEmpty) break;
      } catch {
        rows = [];
      }
    }
    const out: Ranked[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const doc = this.corpus.bySourceId.get(r.source_id);
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push({ docId: doc.id, score: -r.score }); // sqlite bm25 is negated; flip so higher = better
      if (out.length >= k) break;
    }
    return out;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

// ---------------------------------------------------------------------------
// vec
// ---------------------------------------------------------------------------

/**
 * Brute-force cosine over every chunk, then MAX-pool to documents.
 *
 * Max, not mean: a 45,000-char message whose 25th chunk is the answer should rank on
 * that chunk's merit. Averaging lets 24 irrelevant chunks drown it — the exact failure
 * chunking was introduced to fix.
 *
 * 11k × 768 floats is ~34MB and a full scan is tens of ms, so sqlite-vec buys nothing
 * at this scale. Picking a MODEL is the job here; picking an ANN index is not.
 */
export class VecSearcher {
  constructor(
    private corpus: Corpus,
    /** chunks.length * dim, row i = corpus.chunks[i]. Rows are unit-norm. */
    private matrix: Float32Array,
    private dim: number,
  ) {}

  search(queryVec: Float32Array, k: number): Ranked[] {
    const { chunks } = this.corpus;
    const d = this.dim;
    const best = new Map<number, number>();
    for (let i = 0; i < chunks.length; i++) {
      const off = i * d;
      let s = 0;
      for (let j = 0; j < d; j++) s += this.matrix[off + j] * queryVec[j];
      const docId = chunks[i].docId;
      const prev = best.get(docId);
      if (prev === undefined || s > prev) best.set(docId, s);
    }
    return [...best.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

// ---------------------------------------------------------------------------
// hybrid
// ---------------------------------------------------------------------------

/**
 * Reciprocal rank fusion. Rank-based, so it needs no score normalization between a
 * negated bm25 and a cosine — which is exactly why the spec picked it over a weighted
 * score blend.
 */
export function rrf(lists: Ranked[][], k: number, kConst = 60): Ranked[] {
  const acc = new Map<number, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      acc.set(list[i].docId, (acc.get(list[i].docId) ?? 0) + 1 / (kConst + i + 1));
    }
  }
  return [...acc.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

export interface CaseScore {
  caseId: string;
  /** 1-based rank of the first relevant doc, or 0 for "not in the list". */
  rank: number;
  topDocId: number | null;
}

export function scoreCase(caseId: string, ranked: Ranked[], relevant: number[]): CaseScore {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i].docId)) return { caseId, rank: i + 1, topDocId: ranked[0]?.docId ?? null };
  }
  return { caseId, rank: 0, topDocId: ranked[0]?.docId ?? null };
}

export interface Metrics {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  mrr: number;
}

export function aggregate(scores: CaseScore[]): Metrics {
  const n = scores.length;
  if (!n) return { n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 };
  let r1 = 0;
  let r5 = 0;
  let r10 = 0;
  let mrr = 0;
  for (const s of scores) {
    if (s.rank === 0) continue;
    if (s.rank <= 1) r1++;
    if (s.rank <= 5) r5++;
    if (s.rank <= 10) r10++;
    mrr += 1 / s.rank;
  }
  return { n, r1: r1 / n, r5: r5 / n, r10: r10 / n, mrr: mrr / n };
}
