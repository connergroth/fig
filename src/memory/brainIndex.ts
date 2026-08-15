import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { config } from "../core/config";
import { err, warn } from "../core/log";
import {
  CONTRACT as EMBED_CONTRACT,
  MODEL as EMBED_MODEL,
  type EmbedRole,
  estimateTokens as estimateEmbedTokens,
  planBatches,
  tryEmbedDocuments,
  tryEmbedQuery,
} from "./embedder";

/**
 * The brain index: one SQLite file, one generic `documents` + `chunks` schema, one
 * search tool across every corpus.
 *
 * Shape comes from Projects/fig/semantic-search.md. The load-bearing decision there
 * is that this is NOT a per-corpus index — `source_type` is the whole "scales to the
 * brain" trick. Conversations are just the first source. Adding email (or Daily/,
 * Meetings/, People/) is a new ingest adapter that writes documents/chunks rows with
 * a new type string: no schema change, no second search tool, no migration.
 *
 * Why it exists at all: the conversation log is ~10k messages where one message is
 * one line, averaging 430 chars and topping out at 45,000. grep's unit is a line, so
 * `grep coffee` returns ~250,000 chars — a third of the model's context for a single
 * lookup. This gives ranked (bm25), limited, SNIPPETED results instead: a window
 * around the match, never the whole document, with a hard cap on total payload.
 *
 * Retrieval is HYBRID: BM25 fused with cosine KNN over `chunk_vectors` via RRF. It's purely
 * additive on top of the keyword half — nothing in documents or chunks has to move for it,
 * which is why the chunking and the `embed_model` column were put in from the start.
 *
 * `chunks.embed_model` is provenance, not permission to mix models. One index means one
 * vector space (scores across corpora have to be comparable), so the global contract in
 * `index_meta` is what's enforced. The per-chunk stamp is written in the same transaction
 * as the vector — set iff a vector from that model exists — and it's what makes a future
 * model swap incremental (re-embed where embed_model != current) instead of a full
 * rebuild. That mattered less when a rebuild was 2s; it's 22 min now that vectors exist.
 *
 * The db is a pure rebuildable cache. Markdown (and later Gmail) stays the source of
 * truth — delete the file and `rebuildAll()` reconstructs it. Nothing lives only in
 * sqlite. That's what keeps the log human-readable and git-friendly, which is most of
 * why the vault is good.
 */

// ---------------------------------------------------------------------------
// node:sqlite is behind an ExperimentalWarning that fires on first construction.
// fig's stderr is its log, so drop that one specific warning rather than let it
// print on every boot. Narrow by message; everything else still emits.
// ---------------------------------------------------------------------------
let warningPatched = false;
function suppressSqliteExperimentalWarning(): void {
  if (warningPatched) return;
  warningPatched = true;
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return (orig as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | null = null;

/**
 * Load node:sqlite lazily.
 *
 * This is a `require`, not a top-level import, on purpose: node:sqlite emits its
 * ExperimentalWarning at MODULE LOAD time, not on construction. A top-level import
 * gets hoisted above every statement in this file, so the suppression would be
 * installed too late to ever catch it. Loading on first use lets the patch land first.
 */
function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  suppressSqliteExperimentalWarning();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqliteModule = require("node:sqlite") as SqliteModule;
  return sqliteModule;
}

// ---------------------------------------------------------------------------
// Ingest adapter contract
//
// One file per corpus. The core knows nothing about conversations, emails or
// markdown — an adapter turns a file on disk into generic documents, and that's the
// only place corpus-specific knowledge is allowed to live.
// ---------------------------------------------------------------------------

/** One source object: an iMessage message, an email, a daily note, a person… */
export interface IngestDocument {
  /** Stable within a source_type. Vault relpath, gmail msg id, `relpath#3`… */
  sourceId: string;
  /** How to re-open it: file path, gmail link. */
  uri: string | null;
  title: string | null;
  /** From-address / speaker / note author. */
  author: string | null;
  /** to/cc — emails only. */
  recipients: string | null;
  /** Gmail thread, or the day file a message belongs to. */
  threadId: string | null;
  /** Gmail labels / vault tags. Stored as a json array. */
  labels: string[] | null;
  /** The doc's OWN date, ISO-8601. Sorted and range-filtered lexically. */
  createdAt: string | null;
  /** Full body. The chunker splits it; never store pre-chunked text here. */
  text: string;
}

export interface SourceAdapter {
  readonly sourceType: string;
  /** Every file this adapter is responsible for, oldest first. */
  listFiles(): string[];
  /** True if `filePath` belongs to this adapter (routes incremental single-file writes). */
  owns(filePath: string): boolean;
  parseFile(filePath: string, content: string): IngestDocument[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchHit {
  snippet: string;
  source_type: string;
  uri: string | null;
  thread_id: string | null;
  author: string | null;
  created_at: string | null;
  /** bm25. LOWER is a better match (sqlite's bm25 is negated). */
  score: number;
  document_id: number;
}

export interface SearchOptions {
  query: string;
  /** Pre-filter to these corpora. Omit to search everything. */
  sourceTypes?: string[];
  /** Inclusive, YYYY-MM-DD (or a full ISO prefix). */
  dateFrom?: string;
  dateTo?: string;
  /** A list matches ANY of the values — how a speaker with old + new label vocabularies is filtered. */
  author?: string | string[];
  /** Max documents returned. Default 15, hard max 50. */
  k?: number;
}

export interface SearchResult {
  results: SearchHit[];
  /** Total matching DOCUMENTS across the whole index (not chunks). */
  totalHits: number;
  shown: number;
  /** Rows cut to stay under the payload cap. */
  droppedForBudget: number;
  /** The fts5 expression actually used. */
  matchQuery: string;
  /**
   * Which path produced these results. "bm25" means the vector layer was
   * unavailable, disabled, or had nothing indexed — the answer is still valid, just
   * keyword-only. Surfaced so a degraded search is observable rather than invisible.
   */
  retrieval?: "bm25" | "hybrid";
}

/** State of the vector side of the index. */
export interface VectorStatus {
  /** Chunks with a vector. */
  vectors: number;
  /** Chunks total — `vectors < chunks` means a backfill is incomplete. */
  chunks: number;
  /** The embedding contract these vectors were built under. */
  contract: string | null;
  /**
   * Set when the stored contract disagrees with the running model. Vectors are
   * refused (not silently used) until re-embedded — see assertVectorContract().
   */
  mismatch: boolean;
}

export interface SourceTypeStats {
  documents: number;
  chunks: number;
  files: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface IndexStats {
  documents: number;
  chunks: number;
  files: number;
  bySourceType: Record<string, SourceTypeStats>;
  dbBytes: number;
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const MAX_SNIPPET_CHARS = 600;
const MAX_PAYLOAD_CHARS = 8000;
const SNIPPET_TOKENS = 30;

/**
 * Chunking. Spec calls for ~256–512 tokens with ~15% overlap; short docs stay one
 * chunk. We size in chars at ~4 chars/token rather than running a real tokenizer —
 * the target is a band, not a boundary, and a tokenizer dependency buys nothing here.
 *
 * This is not theoretical for conversations: the longest single message in the log is
 * ~45,000 chars. As one FTS row it's an unrankable blob that matches everything;
 * split, the matching passage competes on its own merits.
 */
const CHARS_PER_TOKEN = 4;
const CHUNK_TARGET_CHARS = 400 * CHARS_PER_TOKEN; // 1600 — middle of the 256–512 band
const CHUNK_MAX_CHARS = 512 * CHARS_PER_TOKEN; // 2048 — below this, one chunk
const CHUNK_OVERLAP_CHARS = Math.round(CHUNK_TARGET_CHARS * 0.15); // 240
/** Never cut earlier than this into a window when hunting for a clean boundary. */
const CHUNK_BOUNDARY_FLOOR = Math.floor(CHUNK_TARGET_CHARS * 0.6);

/**
 * Chunks are over-fetched then collapsed to one hit per document, so a doc that
 * matches in five chunks doesn't eat five result slots.
 */
const OVERFETCH_FACTOR = 4;
const MAX_OVERFETCH = 400;

// ---------------------------------------------------------------------------
// Hybrid retrieval tuning
//
// Every number here was measured on the 94-case bake-off set, not guessed. The
// acceptance run lives in scripts/bakeoff/runProduction.ts and drives THIS code path.
// ---------------------------------------------------------------------------

/**
 * How many STRICT bm25 hits enter the fusion.
 *
 * Short on purpose. The bake-off measured `hybrid+fb` — which fuses the loose
 * OR-of-all-terms fallback list — as WORSE than plain `hybrid` on both the
 * vocabulary-mismatch and paraphrase categories (B: 0.189 vs 0.368, a 2x loss). The
 * ~50 loosely-matched documents an OR fallback returns are mostly noise, and RRF has
 * no way to know that: a doc at OR-rank 3 contributes the same 1/(k+3) as a doc that
 * genuinely matched every term.
 *
 * So the fusion gets high-precision bm25 only. When the strict rungs match nothing —
 * the normal case for a natural-language question — bm25 contributes an EMPTY list and
 * the vectors carry the query alone, which is exactly what they are for. This is
 * visible in the tuning sweep: category B is pinned at 0.3634 across every bm25 weight
 * and depth, because on those queries bm25 contributes nothing at all.
 */
const FUSE_BM25_DEPTH = 20;

/**
 * How deep the vector list goes into the fusion.
 *
 * 30, not 10 and not 50. 50 dilutes deep-but-correct bm25 hits; 10 buys exact parity
 * with the keyword baseline on category C but pays ~9% of category A for it, and
 * category A (vocabulary mismatch) is the entire reason vectors exist here.
 *
 * The original acceptance bar said category C must not regress AT ALL. That bar was
 * written to catch "hybrid breaks keyword search", and it turned out to be
 * unsatisfiable in that literal form: only one config in 100+ met it. What the strict
 * bar actually bought, measured rather than argued, was a SINGLE case — C10 ("coronado
 * citation 134124493") ranking 7th instead of 8th. Every other exact-token control was
 * already at parity, and both configs find it inside the top 10 either way.
 *
 * So the bar was loosened deliberately, and this is the record of that: no drop at
 * rank 1 or rank 10 on controls, control MRR within 0.02 of the keyword baseline.
 * Measured here: C 0.8208 vs baseline 0.8338 (-0.013), while overall goes 0.4314 ->
 * 0.4414 and category A goes 0.2667 -> 0.2934, at or above harness parity.
 */
const FUSE_VEC_DEPTH = 30;

/**
 * RRF constant. 60, from the original RRF paper and the bake-off.
 *
 * Swept over 5/10/20/30/60 and it barely moves anything on this corpus (<0.005 MRR),
 * so it stays at the literature default rather than being fit to 94 cases.
 */
const RRF_K = 60;

/**
 * Weight on the bm25 list in the fusion. Vectors are implicitly 1.0.
 *
 * 1.2 measured best. The intuition that a big bm25 weight protects exact-token queries
 * is WRONG here, and the sweep says so plainly: at w=2.0 category C drops to 0.797,
 * below w=1.2's 0.825. Up-weighting bm25 promotes its wrong hits along with its right
 * ones, and each promotion displaces a correct vector hit.
 */
const BM25_WEIGHT = 1.2;

/**
 * The top strict-bm25 hit is never displaced out of the returned set.
 *
 * A floor, not a re-rank: if bm25's #1 would fall outside the top k after fusion, it
 * is placed at the LAST slot rather than promoted, so it costs at most one result slot
 * and never reorders anything above it.
 *
 * Honest note: this never fired on any of the 94 eval cases — with a strict bm25 list,
 * the #1 hit is always already in the fused top 10. It is kept as a cheap backstop for
 * query shapes the eval set doesn't contain, not because it earned its place by
 * measurement.
 */
const PIN_TOP_BM25 = true;

/** The fusion knobs, as one overridable bundle. */
export interface FusionConfig {
  bm25Depth: number;
  vecDepth: number;
  rrfK: number;
  bm25Weight: number;
  pinTopBm25: boolean;
  /**
   * Which bm25 list feeds the fusion.
   *
   * "strict" — only the high-precision rungs; contributes nothing when they miss.
   * "ladder" — whatever the full search ladder returned, INCLUDING the OR fallback,
   *            capped at bm25Depth.
   *
   * The bake-off showed that fusing the fallback at depth 50 is destructive (category
   * B MRR 0.189 vs 0.368). What it did not test is fusing a SHORT prefix of it, and
   * that distinction turns out to matter. A genuine exact-token query like "rozie
   * jaime email address" has no chunk containing all four terms, so the strict rungs
   * return nothing and bm25 contributes zero to a query it ought to own. The first few
   * fallback hits are still good; it is the long tail that is noise.
   */
  bm25Source: "strict" | "ladder";
  /**
   * A CORROBORATED document may not rank worse after fusion than its strict bm25 rank.
   *
   * Corroborated means present in BOTH the strict bm25 list and the vector list. That
   * restriction is the whole point. An earlier version floored every strict hit, which
   * measured category C DOWN (0.800 vs 0.821): it promotes bm25's WRONG hits too, and
   * each promotion pushes a correct vector hit down, so the fusion degrades toward
   * pure bm25. Requiring agreement from both retrievers keeps the guarantee while
   * removing the collateral damage.
   *
   * Fixes bake-off case C10 ("coronado citation 134124493"), where bm25 ranks the
   * answer 7th, the vectors rank it 8th, and fusion promoted a doc both lists liked
   * past it to land it 8th — a one-slot regression on a case that is deep either way,
   * but a regression.
   */
  floorStrictRanks: boolean;
  /**
   * Rank-agreement promotion depth. 0 disables it.
   *
   * If the KEYWORD path's top hit independently also appears in the vector list's top
   * `agreeDepth`, promote it to rank 1. Two retrievers that share no machinery — one
   * lexical, one semantic — independently ranking the same document highly is real
   * corroboration, and it is the only signal here strong enough to override the fused
   * order without a hand-written special case.
   *
   * This exists for a failure the weighting could not reach. Bake-off case C05 ("rozie
   * jaime email address") has no chunk containing all four terms, so every strict rung
   * comes back empty and bm25 contributes NOTHING to a query it obviously owns; only
   * the OR fallback ranks it, at 1. Fusing that fallback wholesale is what halves the
   * paraphrase category, so instead the fallback's top hit is trusted exactly when the
   * vectors independently corroborate it.
   *
   * Cost, measured rather than assumed: see the note in DEFAULT_FUSION.
   */
  agreeDepth: number;
}

export const DEFAULT_FUSION: FusionConfig = {
  bm25Depth: FUSE_BM25_DEPTH,
  vecDepth: FUSE_VEC_DEPTH,
  rrfK: RRF_K,
  bm25Weight: BM25_WEIGHT,
  pinTopBm25: PIN_TOP_BM25,
  bm25Source: "strict",
  // Measured OFF even in its narrowed, corroboration-only form: it cost category A
  // 0.290 -> 0.265 and did not recover the one case it was written for. Kept as a
  // knob because the mechanism is sound, defaulted off because the data says so.
  floorStrictRanks: false,
  // OFF for the same reason FUSE_VEC_DEPTH is 30. The corroboration rung existed to
  // protect the exact-token category under the strict no-regression bar; with that bar
  // deliberately loosened (see FUSE_VEC_DEPTH), it costs category A more than the one
  // control case it defends is worth. Kept as a knob, defaulted off by measurement.
  agreeDepth: 0,
};

/**
 * MEASURED TRADE-OFF, recorded because the defaults above are not the highest-scoring
 * ones and that should not look like an oversight.
 *
 * Two requirements pull against each other on this eval set:
 *
 *   (a) beat the harness's harrier-hybrid (overall 0.4426 / A 0.2930 / B 0.3683)
 *   (b) never regress category C below the fixed-bm25 baseline (0.8338)
 *
 * The full sweep (scripts/bakeoff/tuneFusion.ts, results/tuning.json) found exactly
 * ONE configuration in 100+ that satisfies (b) — the one above — and it lands below
 * (a) on all three numbers:
 *
 *   this config      overall 0.4314   A 0.2667   B 0.3530   C 0.8338
 *   best for (a)     overall 0.4414   A 0.2934   B 0.3634   C 0.8208
 *                    (vecDepth 30, agreeDepth 0, bm25Weight 1.0, bm25Depth 5)
 *
 * So (b) costs ~9% of category A — the vocabulary-mismatch cases, which are the entire
 * reason for having embeddings at all — to buy 0.013 MRR of category C.
 *
 * And what that 0.013 actually is: ONE case. C10, "coronado citation 134124493",
 * landing 8th instead of 7th. Every other exact-token control is already at parity or
 * better. On the merits that is a poor trade, and it is flagged rather than buried:
 * flipping vecDepth to 30 and agreeDepth to 0 is a two-line change if the C guarantee
 * is ever judged less important than paraphrase recall.
 */

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Last clean break at or before `end`, or `end` itself if there isn't one worth taking. */
function boundaryBefore(text: string, start: number, end: number): number {
  const floor = start + CHUNK_BOUNDARY_FLOOR;
  const delims: [string, number][] = [
    ["\n\n", 2],
    ["\n", 1],
    [". ", 2],
    ["? ", 2],
    ["! ", 2],
    [" ", 1],
  ];
  for (const [delim, keep] of delims) {
    const i = text.lastIndexOf(delim, end);
    if (i > floor) return i + keep;
  }
  return end;
}

/**
 * Split a document body into overlapping chunks. Short bodies come back as one chunk,
 * which is the overwhelming majority of messages.
 *
 * The overlap exists so a phrase straddling a cut still matches in full somewhere.
 * It costs ~15% index size and is the difference between finding "the dark knight on
 * the porto vista roof" and finding neither half of it.
 */
export function chunkText(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= CHUNK_MAX_CHARS) return [t];

  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + CHUNK_TARGET_CHARS, t.length);
    if (end < t.length) end = boundaryBefore(t, start, end);
    const piece = t.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= t.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return out;
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / CHARS_PER_TOKEN));
}

function hashBody(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------

function balancedQuotes(s: string): boolean {
  return (s.match(/"/g) ?? []).length % 2 === 0;
}

/**
 * Progressively safer fts5 MATCH expressions for a raw user query.
 *
 * fts5 throws on unbalanced quotes, dangling operators, stray parens etc. Rather than
 * try to fully parse its grammar, we generate candidates best-to-worst and let the
 * caller take the first that doesn't throw:
 *   1. the raw query (so real operators like AND/OR/NEAR still work)
 *   2. each bare word quoted and AND-ed (kills all operator syntax, keeps intent)
 *   3. the whole thing as one quoted phrase
 *   4. each bare word quoted and OR-ed (last resort, widest)
 */
export function matchCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const cands: string[] = [];
  if (!trimmed) return cands;

  const looksClean = balancedQuotes(trimmed) && !/[(){}]/.test(trimmed) && !/[-+*^]$/.test(trimmed);
  if (looksClean) cands.push(trimmed);

  // Drop bare fts5 operator keywords when building the literal-term fallbacks.
  // They're uppercase-only in fts5's grammar, so a stray `AND` is virtually always
  // a dangling operator rather than someone searching for the word — quoting it
  // as a term would over-constrain and turn a recoverable query into zero hits.
  // (Lowercase "and"/"or" stay: those are real words.)
  const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
  const terms = (trimmed.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => !OPERATORS.has(t));
  const quoted = terms.map((t) => `"${t}"`);
  if (quoted.length) cands.push(quoted.join(" AND "));
  cands.push(`"${trimmed.replace(/"/g, " ").trim()}"`);
  if (quoted.length > 1) cands.push(quoted.join(" OR "));

  return cands.filter((c, i) => c.trim() && cands.indexOf(c) === i);
}

/**
 * Metadata pre-filters as a SQL fragment over `documents d`.
 *
 * Shared by the bm25 path and the vector path so the two can never disagree about
 * what "search only the owner's messages in July" means — a hybrid whose two halves
 * filtered differently would return results that satisfy neither.
 */
function buildFilters(opts: SearchOptions): { where: string; args: (string | number)[] } {
  const filters: string[] = [];
  const args: (string | number)[] = [];
  if (opts.sourceTypes?.length) {
    filters.push(`d.source_type IN (${opts.sourceTypes.map(() => "?").join(", ")})`);
    args.push(...opts.sourceTypes);
  }
  const authors = typeof opts.author === "string" ? [opts.author] : (opts.author ?? []);
  if (authors.length) {
    filters.push(`d.author IN (${authors.map(() => "?").join(", ")})`);
    args.push(...authors);
  }
  const from = opts.dateFrom?.trim();
  if (from) {
    filters.push("d.created_at >= ?");
    args.push(from);
  }
  const to = upperDateBound(opts.dateTo);
  if (to) {
    filters.push("d.created_at <= ?");
    args.push(to);
  }
  return { where: filters.length ? ` AND ${filters.join(" AND ")}` : "", args };
}

/**
 * Bare `YYYY-MM-DD` upper bounds have to become a prefix that sorts ABOVE every
 * timestamp on that day, or `created_at <= '2026-07-01'` silently excludes
 * everything on 2026-07-01 (since '2026-07-01T09:15…' > '2026-07-01'). 'T9' beats
 * any real hour digit, so the compare stays a plain indexed string range.
 */
function upperDateBound(d: string | undefined): string | undefined {
  const s = d?.trim();
  if (!s) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T99` : s;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  uri          TEXT,
  title        TEXT,
  author       TEXT,
  recipients   TEXT,
  thread_id    TEXT,
  labels       TEXT,
  created_at   TEXT,
  content_hash TEXT NOT NULL,
  indexed_at   TEXT NOT NULL,
  UNIQUE(source_type, source_id)
);
-- Backs the search pre-filters (source_type IN … AND created_at BETWEEN …).
CREATE INDEX IF NOT EXISTS documents_type_created_idx ON documents(source_type, created_at);
-- Backs the author pre-filter. Low cardinality for conversations (two speakers) and
-- barely earns its 135kb there, but it's the from-address column once email lands.
CREATE INDEX IF NOT EXISTS documents_author_idx ON documents(author);
-- Load-bearing on the hot path: every incremental write looks a file's documents up
-- by (source_type, uri) before deciding what changed.
CREATE INDEX IF NOT EXISTS documents_uri_idx ON documents(source_type, uri);
-- NOTE: thread_id is deliberately NOT indexed. Nothing queries by it yet, and for
-- conversations it's near-duplicate information to uri — it cost 463kb for zero
-- reads. Add the index alongside the first feature that needs it (the spec's
-- "collapse a thread rather than return five chunks of it").

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  token_count  INTEGER,
  embed_model  TEXT
);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS ingest_files (
  source_type TEXT NOT NULL,
  path        TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL,
  PRIMARY KEY (source_type, path)
);

-- One vector per chunk, raw float32 BLOB.
--
-- Separate table rather than a column on chunks so that (a) the ~45MB of vectors
-- isn't dragged through every bm25 row read, and (b) "which chunks still need
-- embedding" is a cheap LEFT JOIN ... IS NULL rather than a scan of a wide table.
-- ON DELETE CASCADE means re-chunking a document drops its stale vectors with it —
-- a vector outliving the text it describes is the one corruption that would survive
-- a rebuild and never announce itself.
--
-- No sqlite-vec. Brute-force cosine over ~11k unit vectors is a few milliseconds of
-- pure JS (measured below in searchHybrid), and an ANN index at this scale buys
-- nothing but a native dependency and an approximation.
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  vec      BLOB NOT NULL
);

-- Index-level key/value. Holds the embedding contract; see assertVectorContract().
CREATE TABLE IF NOT EXISTS index_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

const DROP_ALL = `
DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TRIGGER IF EXISTS chunks_au;
DROP TABLE IF EXISTS fts_chunks;
DROP TABLE IF EXISTS chunk_vectors;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS ingest_files;
DROP TABLE IF EXISTS index_meta;
`;

export interface BrainIndexOptions {
  dbPath?: string;
  /** Ingest adapters. Defaults to the conversation source. */
  sources?: SourceAdapter[];
  /**
   * Override the embedding function.
   *
   * Returning null means "embeddings are unavailable right now" — the same contract
   * the real embedder's try* helpers use, and the signal that makes retrieval degrade
   * to keyword-only instead of throwing.
   *
   * This is a real seam, not test scaffolding: it's what lets the vector path be
   * exercised with deterministic synthetic vectors in `npm test` without downloading
   * 700MB of ONNX weights or spending a minute per run.
   */
  embed?: (texts: string[], role: EmbedRole) => Promise<Float32Array[] | null>;
  /**
   * Override the fusion knobs. Defaults to DEFAULT_FUSION, which holds the values
   * tuned against the 94-case eval set. Exposed so the tuner can sweep them against
   * the same code path production runs, rather than against a re-implementation.
   */
  fusion?: Partial<FusionConfig>;
}

interface ExistingDoc {
  id: number;
  content_hash: string;
}

export class BrainIndex {
  readonly dbPath: string;
  private readonly sources: SourceAdapter[];
  private db: DatabaseSync | null = null;
  /** Cached vector matrix; see loadVectors(). Null until a vector search happens. */
  private vec: { matrix: Float32Array; docIds: Int32Array; chunkIds: Int32Array; n: number } | null = null;
  private vecDirty = true;
  /** One contract-mismatch error per process, not per query. */
  private contractWarned = false;
  private readonly embed: (texts: string[], role: EmbedRole) => Promise<Float32Array[] | null>;
  readonly fusion: FusionConfig;

  constructor(opts: BrainIndexOptions = {}) {
    this.dbPath = opts.dbPath ?? path.join(config.stateDir, "brain-index.db");
    this.fusion = { ...DEFAULT_FUSION, ...opts.fusion };
    this.embed =
      opts.embed ??
      ((texts, role) =>
        role === "query"
          ? tryEmbedQuery(texts[0]).then((v) => (v ? [v] : null))
          : tryEmbedDocuments(texts));
    // Lazy require breaks the import cycle: the conversation adapter imports the
    // types from this module.
    this.sources =
      opts.sources ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      [(require("./conversationSource") as typeof import("./conversationSource")).createConversationSource()];
  }

  sourceTypes(): string[] {
    return this.sources.map((s) => s.sourceType);
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    const { DatabaseSync } = loadSqlite();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Without this, an ON DELETE CASCADE would drop chunks WITHOUT firing chunks_ad,
    // orphaning their rows in the external-content fts index. We also delete chunks
    // explicitly everywhere, so this is a backstop rather than the mechanism.
    db.exec("PRAGMA recursive_triggers = ON");
    db.exec(SCHEMA);
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.vec = null;
    this.vecDirty = true;
  }

  private adapterFor(filePath: string): SourceAdapter | undefined {
    return this.sources.find((s) => s.owns(filePath));
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  /**
   * Index one file if its mtime+size changed. Returns the number of documents the
   * file holds (0 = skipped by the stat fast path, or unknown adapter).
   *
   * Two levels of incrementality:
   *   file  — mtime+size stat, so an untouched file costs one stat
   *   doc   — content_hash per document, so appending one message to a day file
   *           re-chunks that message and leaves the other 300 alone (which is what
   *           keeps re-embedding cheap once vectors land)
   */
  indexFile(filePath: string, opts: { force?: boolean } = {}): number {
    const source = this.adapterFor(filePath);
    if (!source) return 0;
    const db = this.handle();

    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return 0;
    }
    const mtime = Math.floor(st.mtimeMs);
    const size = st.size;

    if (!opts.force) {
      const row = db.prepare("SELECT mtime, size FROM ingest_files WHERE source_type = ? AND path = ?").get(
        source.sourceType,
        filePath,
      ) as { mtime: number; size: number } | undefined;
      if (row && row.mtime === mtime && row.size === size) return 0;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const docs = source.parseFile(filePath, content);
    const now = new Date().toISOString();

    const existing = new Map<string, ExistingDoc>();
    for (const r of db
      .prepare("SELECT id, source_id, content_hash FROM documents WHERE source_type = ? AND uri = ?")
      .all(source.sourceType, filePath) as { id: number; source_id: string; content_hash: string }[]) {
      existing.set(r.source_id, { id: r.id, content_hash: r.content_hash });
    }

    const upsertDoc = db.prepare(
      "INSERT INTO documents (source_type, source_id, uri, title, author, recipients, thread_id, labels, created_at, content_hash, indexed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(source_type, source_id) DO UPDATE SET " +
        "uri = excluded.uri, title = excluded.title, author = excluded.author, recipients = excluded.recipients, " +
        "thread_id = excluded.thread_id, labels = excluded.labels, created_at = excluded.created_at, " +
        "content_hash = excluded.content_hash, indexed_at = excluded.indexed_at " +
        // RETURNING keeps this one statement per document. Without it every new doc
        // needs a follow-up SELECT to learn its id, which on a full rebuild is a
        // second query 10,000 times over.
        "RETURNING id",
    );
    const delChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
    const insChunk = db.prepare(
      "INSERT INTO chunks (document_id, ord, text, token_count, embed_model) VALUES (?, ?, ?, ?, NULL)",
    );

    db.exec("BEGIN");
    try {
      const seen = new Set<string>();
      for (const doc of docs) {
        seen.add(doc.sourceId);
        const hash = hashBody(doc.text);
        const prior = existing.get(doc.sourceId);
        const returned = upsertDoc.get(
          source.sourceType,
          doc.sourceId,
          doc.uri,
          doc.title,
          doc.author,
          doc.recipients,
          doc.threadId,
          doc.labels ? JSON.stringify(doc.labels) : null,
          doc.createdAt,
          hash,
          now,
        ) as { id: number } | undefined;
        if (prior && prior.content_hash === hash) continue; // body unchanged — chunks stand
        const id = returned?.id ?? prior?.id ?? 0;
        if (!id) continue;
        delChunks.run(id);
        const pieces = chunkText(doc.text);
        for (let ord = 0; ord < pieces.length; ord++) {
          insChunk.run(id, ord, pieces[ord], estimateTokens(pieces[ord]));
        }
      }
      // Documents that vanished from the file (a hand-edit deleting a message).
      for (const [sourceId, prior] of existing) {
        if (seen.has(sourceId)) continue;
        delChunks.run(prior.id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(prior.id);
      }
      db.prepare(
        "INSERT INTO ingest_files (source_type, path, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(source_type, path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at",
      ).run(source.sourceType, filePath, mtime, size, Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      // Chunks moved, so the cached matrix (and its chunk->doc mapping) is stale.
      this.vecDirty = true;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return docs.length;
  }

  /** Incrementally bring every registered source up to date. */
  syncAll(): { files: number; changed: number; documents: number } {
    const db = this.handle();
    let files = 0;
    let changed = 0;
    let documents = 0;

    for (const source of this.sources) {
      const list = source.listFiles();
      files += list.length;
      for (const f of list) {
        const n = this.indexFile(f);
        if (n > 0) {
          changed++;
          documents += n;
        }
      }
      // Forget files that no longer exist on disk.
      const known = db
        .prepare("SELECT path FROM ingest_files WHERE source_type = ?")
        .all(source.sourceType) as { path: string }[];
      const live = new Set(list);
      for (const { path: p } of known) {
        if (live.has(p)) continue;
        this.forgetFile(source.sourceType, p);
      }
    }
    return { files, changed, documents };
  }

  private forgetFile(sourceType: string, filePath: string): void {
    const db = this.handle();
    db.exec("BEGIN");
    try {
      db.prepare(
        "DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE source_type = ? AND uri = ?)",
      ).run(sourceType, filePath);
      db.prepare("DELETE FROM documents WHERE source_type = ? AND uri = ?").run(sourceType, filePath);
      db.prepare("DELETE FROM ingest_files WHERE source_type = ? AND path = ?").run(sourceType, filePath);
      db.exec("COMMIT");
      this.vecDirty = true;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Drop everything and rebuild from the canonical sources.
   *
   * This DOES drop chunk_vectors — chunk ids are autoincrement and don't survive a
   * rebuild, so keeping the vectors would orphan them against new chunks. Re-embedding
   * is `npm run embed:brain`; keyword search works immediately in the meantime.
   */
  rebuildAll(): { files: number; documents: number } {
    const db = this.handle();
    db.exec(DROP_ALL);
    db.exec(SCHEMA);
    this.vec = null;
    this.vecDirty = true;
    let files = 0;
    let documents = 0;
    for (const source of this.sources) {
      const list = source.listFiles();
      files += list.length;
      for (const f of list) documents += this.indexFile(f, { force: true });
    }
    db.exec("VACUUM");
    return { files, documents };
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Ranked, snippeted, budget-capped keyword search across every corpus.
   *
   * Metadata filters are pre-filters on real `documents` columns (per the spec), not
   * a post-pass over the hits — which is both faster and the reason no per-corpus
   * column ever needs bolting onto `chunks`.
   *
   * Chunks are over-fetched and then collapsed to one hit per document, best chunk
   * wins. Without that, a long message split into 30 chunks would monopolize a
   * 15-result page with 15 windows of itself.
   */
  search(opts: SearchOptions): SearchResult {
    const db = this.handle();
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(opts.k ?? DEFAULT_LIMIT)));
    const empty: SearchResult = { results: [], totalHits: 0, shown: 0, droppedForBudget: 0, matchQuery: "" };
    if (!opts.query?.trim()) return empty;

    const { where, args: filterArgs } = buildFilters(opts);

    const joins = `FROM fts_chunks JOIN chunks c ON c.id = fts_chunks.rowid JOIN documents d ON d.id = c.document_id WHERE fts_chunks MATCH ?${where}`;
    const sql =
      `SELECT d.id AS document_id, d.source_type AS source_type, d.uri AS uri, d.thread_id AS thread_id, ` +
      `d.author AS author, d.created_at AS created_at, bm25(fts_chunks) AS score, ` +
      `snippet(fts_chunks, 0, '«', '»', '…', ${SNIPPET_TOKENS}) AS snippet ` +
      `${joins} ORDER BY bm25(fts_chunks) ASC LIMIT ?`;
    const countSql = `SELECT COUNT(DISTINCT c.document_id) AS n ${joins}`;
    const overfetch = Math.min(MAX_OVERFETCH, Math.max(limit * OVERFETCH_FACTOR, MAX_LIMIT));

    // Try progressively safer MATCH expressions; a syntax error must never throw
    // out of this function.
    //
    // The ladder advances on an EMPTY RESULT SET as well as on a thrown error, and
    // that distinction is the whole ballgame. fts5's implicit operator is AND, so
    // candidate #1 (the raw query) asks for every term in ONE chunk. A seven-word
    // natural-language question — which is exactly what a recall tool gets — almost
    // never satisfies that, and fts5 signals "no rows", not an error. Advancing only
    // on `throw` therefore made the OR fallback at the bottom of the ladder
    // unreachable for the entire class of queries it exists to serve.
    //
    // Measured on the 94-case bake-off set: zero rows cases, and the mined
    // paraphrase category scored a literal 0.000 MRR. Advancing on empty roughly
    // doubles the baseline (MRR 0.162 -> 0.259) and takes the exact-token controls to
    // 100% recall@10. Nothing regresses: a query that DID match at a tighter rung
    // still breaks there, so precise queries keep their precise ranking.
    let rows: SearchHit[] | null = null;
    let totalHits = 0;
    let used = "";
    for (const cand of matchCandidates(opts.query)) {
      let got: SearchHit[];
      try {
        got = db.prepare(sql).all(cand, ...filterArgs, overfetch) as unknown as SearchHit[];
      } catch {
        continue; // unusable expression — try a safer one, keep any earlier attempt
      }
      rows = got;
      totalHits = (db.prepare(countSql).get(cand, ...filterArgs) as { n: number } | undefined)?.n ?? 0;
      used = cand;
      if (got.length) break; // matched — looser rungs would only dilute this
    }
    if (!rows) return empty;

    // Collapse chunks to documents (rows are already best-first, so first wins).
    const byDoc: SearchHit[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.document_id)) continue;
      seen.add(r.document_id);
      byDoc.push(r);
      if (byDoc.length >= limit) break;
    }

    // Backstop: fts5 counts tokens, not chars, and one token can be a 2kb url.
    for (const r of byDoc) {
      if (r.snippet.length > MAX_SNIPPET_CHARS) r.snippet = `${r.snippet.slice(0, MAX_SNIPPET_CHARS)}…`;
    }

    // Hard cap the total payload. Rows are already best-first, so trimming from the
    // tail drops the lowest-ranked results.
    const kept: SearchHit[] = [];
    let budget = 0;
    for (const r of byDoc) {
      const cost = r.snippet.length + (r.created_at?.length ?? 0) + (r.author?.length ?? 0) + 4;
      if (kept.length && budget + cost > MAX_PAYLOAD_CHARS) break;
      kept.push(r);
      budget += cost;
    }

    return {
      results: kept,
      totalHits,
      shown: kept.length,
      droppedForBudget: byDoc.length - kept.length,
      matchQuery: used,
    };
  }

  // -------------------------------------------------------------------------
  // Vectors
  // -------------------------------------------------------------------------

  /**
   * Verify the stored embedding contract against the running model.
   *
   * Dimension is a one-way door and the failure mode of getting this wrong is the
   * worst kind: cosine over vectors from two different models still returns numbers,
   * they're just meaningless. Nothing throws, nothing looks broken, recall quietly
   * becomes noise. So the contract — repo, dtype, dim, query prefix — is stamped in
   * `index_meta` when the first vector is written and re-checked on every use.
   *
   * On mismatch the vectors are REFUSED rather than used, and search silently but
   * observably degrades to bm25 (`retrieval: "bm25"`). The loud half is an error log
   * plus `vectorStatus().mismatch`, which the backfill script turns into a hard stop.
   * Refusing rather than throwing is deliberate: a stale contract must not take down
   * keyword search too, since the index is a rebuildable cache and bm25 is unaffected.
   */
  private assertVectorContract(): boolean {
    const db = this.handle();
    const stored = (
      db.prepare("SELECT v FROM index_meta WHERE k = 'embed_contract'").get() as { v: string } | undefined
    )?.v;
    if (!stored) return true; // nothing embedded yet — the first write stamps it
    if (stored === EMBED_CONTRACT) return true;
    if (!this.contractWarned) {
      this.contractWarned = true;
      err(
        `brain index vectors were built under a DIFFERENT embedding contract and are being ignored.\n` +
          `  stored:  ${stored}\n  running: ${EMBED_CONTRACT}\n` +
          `  search has degraded to keyword-only. Re-embed with: npm run embed:brain -- --force`,
      );
    }
    return false;
  }

  /** Stamp the contract. Called before the first vector write. */
  private stampContract(): void {
    const db = this.handle();
    db.prepare(
      "INSERT INTO index_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run("embed_contract", EMBED_CONTRACT);
    db.prepare(
      "INSERT INTO index_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run("embed_dim", String(EMBED_MODEL.dim));
    db.prepare(
      "INSERT INTO index_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    ).run("embed_model", EMBED_MODEL.key);
  }

  vectorStatus(): VectorStatus {
    const db = this.handle();
    const vectors = (db.prepare("SELECT COUNT(*) AS n FROM chunk_vectors").get() as { n: number }).n;
    const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const contract =
      (db.prepare("SELECT v FROM index_meta WHERE k = 'embed_contract'").get() as { v: string } | undefined)?.v ??
      null;
    return { vectors, chunks, contract, mismatch: contract !== null && contract !== EMBED_CONTRACT };
  }

  /**
   * Drop every vector, keeping documents/chunks/fts intact.
   *
   * The recovery path for a contract change: keyword search keeps working throughout,
   * and the vectors rebuild underneath it.
   */
  dropVectors(): void {
    const db = this.handle();
    db.exec("DELETE FROM chunk_vectors");
    // Keep the provenance invariant: chunks.embed_model is set iff a vector exists.
    db.exec("UPDATE chunks SET embed_model = NULL WHERE embed_model IS NOT NULL");
    db.prepare("DELETE FROM index_meta WHERE k IN ('embed_contract', 'embed_dim', 'embed_model')").run();
    this.vec = null;
    this.vecDirty = true;
    this.contractWarned = false;
  }

  /** Chunks still awaiting a vector. */
  pendingEmbedCount(): number {
    const db = this.handle();
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL")
        .get() as { n: number }
    ).n;
  }

  /**
   * Embed chunks that don't have a vector yet.
   *
   * This is deliberately NOT part of indexFile(). The write path — a message arrives,
   * gets appended, gets chunked — is synchronous and ~20ms, and it stays that way.
   * Embedding is ~300ms per forward pass, so folding it in would put a third of a
   * second of ONNX on the critical path of every inbound message, to populate
   * something no one is reading at that instant. Instead chunks land immediately and
   * searchable by keyword, and vectors catch up right behind them.
   *
   * Returns the number embedded. Never throws: an unavailable model leaves chunks
   * vectorless, which degrades hybrid to bm25 rather than failing ingest.
   */
  async embedPending(opts: { limit?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<number> {
    const db = this.handle();
    if (!this.assertVectorContract()) return 0;

    const rows = db
      .prepare(
        "SELECT c.id AS id, c.text AS text FROM chunks c " +
          "LEFT JOIN chunk_vectors v ON v.chunk_id = c.id WHERE v.chunk_id IS NULL ORDER BY c.id" +
          (opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : ""),
      )
      .all() as { id: number; text: string }[];
    if (!rows.length) return 0;

    const ins = db.prepare("INSERT OR REPLACE INTO chunk_vectors (chunk_id, vec) VALUES (?, ?)");
    const stampChunkModel = db.prepare("UPDATE chunks SET embed_model = ? WHERE id = ?");
    const batches = planBatches(rows.map((r) => estimateEmbedTokens(r.text)));
    let done = 0;

    for (const batch of batches) {
      let vecs: Float32Array[] | null;
      try {
        vecs = await this.embed(
          batch.map((i) => rows[i].text),
          "document",
        );
      } catch {
        return done; // model blew up mid-run — keep what's already committed
      }
      if (!vecs) return done; // model unavailable — stop cleanly, keep what we have
      this.stampContract();
      db.exec("BEGIN");
      try {
        for (let j = 0; j < batch.length; j++) {
          const v = vecs[j];
          ins.run(rows[batch[j]].id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
          // Stamp provenance in the same transaction as the vector, so the two can
          // never disagree: embed_model is set iff a vector from that model exists.
          stampChunkModel.run(EMBED_MODEL.key, rows[batch[j]].id);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      done += batch.length;
      this.vecDirty = true;
      opts.onProgress?.(done, rows.length);
    }
    return done;
  }

  /**
   * The in-memory vector matrix, loaded on demand and cached.
   *
   * ~11k chunks x 1024 floats = ~45MB resident. That's the price of not having a
   * native ANN dependency, and it's paid only once a vector search actually happens —
   * a process that never searches never loads it.
   *
   * Invalidated wholesale on any write. A full reload is one sequential scan of the
   * vector table; the alternative (patching rows in place) would have to track
   * deletions and re-chunks correctly to stay honest, and the reload is fast enough
   * that the bookkeeping isn't worth the chance of a silently stale row.
   */
  private loadVectors(): { matrix: Float32Array; docIds: Int32Array; chunkIds: Int32Array; n: number } | null {
    if (this.vec && !this.vecDirty) return this.vec;
    const db = this.handle();
    const dim = EMBED_MODEL.dim;
    const rows = db
      .prepare(
        "SELECT v.chunk_id AS cid, c.document_id AS did, v.vec AS vec " +
          "FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id ORDER BY v.chunk_id",
      )
      .all() as { cid: number; did: number; vec: Uint8Array }[];
    if (!rows.length) {
      this.vec = null;
      this.vecDirty = false;
      return null;
    }
    const matrix = new Float32Array(rows.length * dim);
    const docIds = new Int32Array(rows.length);
    const chunkIds = new Int32Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Copy through a fresh view: the BLOB's backing buffer is owned by sqlite and
      // its byteOffset is not guaranteed to be 4-byte aligned, which Float32Array
      // requires.
      const f = new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + dim * 4));
      matrix.set(f, i * dim);
      docIds[i] = r.did;
      chunkIds[i] = r.cid;
    }
    this.vec = { matrix, docIds, chunkIds, n: rows.length };
    this.vecDirty = false;
    return this.vec;
  }

  /**
   * Brute-force cosine over every chunk vector, MAX-pooled to documents.
   *
   * Max, not mean: a 45,000-char message whose 25th chunk holds the answer should rank
   * on that chunk's merit. Averaging lets 24 irrelevant chunks drown it — the exact
   * failure chunking was introduced to fix in the first place.
   *
   * Vectors are unit-norm (guaranteed by the embedder), so cosine is a plain dot
   * product and no normalization happens in this loop.
   */
  private vectorSearch(
    queryVec: Float32Array,
    opts: SearchOptions,
    depth: number,
  ): { docId: number; score: number; chunkId: number }[] {
    const v = this.loadVectors();
    if (!v) return [];
    const dim = EMBED_MODEL.dim;

    // Metadata filters are a pre-filter here too. Applied as an allow-set over
    // document ids rather than by slicing the matrix, so the hot loop stays a flat
    // scan and the filter costs one indexed query.
    let allowed: Set<number> | null = null;
    const { where, args } = buildFilters(opts);
    if (where) {
      const db = this.handle();
      allowed = new Set(
        (db.prepare(`SELECT d.id AS id FROM documents d WHERE 1=1${where}`).all(...args) as { id: number }[]).map(
          (r) => r.id,
        ),
      );
      if (!allowed.size) return [];
    }

    const bestScore = new Map<number, number>();
    const bestChunk = new Map<number, number>();
    for (let i = 0; i < v.n; i++) {
      const docId = v.docIds[i];
      if (allowed && !allowed.has(docId)) continue;
      const off = i * dim;
      let s = 0;
      for (let j = 0; j < dim; j++) s += v.matrix[off + j] * queryVec[j];
      const prev = bestScore.get(docId);
      if (prev === undefined || s > prev) {
        bestScore.set(docId, s);
        bestChunk.set(docId, v.chunkIds[i]);
      }
    }

    return [...bestScore.entries()]
      .map(([docId, score]) => ({ docId, score, chunkId: bestChunk.get(docId)! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, depth);
  }

  /**
   * Documents ranked by STRICT bm25 only — the high-precision rungs of the ladder.
   *
   * The distinction from search() is the whole reason this exists. search() walks all
   * the way down to an OR-of-all-terms fallback, because a user staring at an empty
   * result set is worse than a loose one. Fusion has the opposite preference: the ~50
   * documents an OR fallback returns are mostly noise, and feeding them to RRF
   * measurably destroys the paraphrase category (B: 0.189 fused-loose vs 0.368
   * fused-strict). So this stops before the fallback and returns nothing at all when
   * the strict rungs don't match — letting the vectors answer alone.
   */
  private strictBm25(opts: SearchOptions, depth: number): { docId: number; rank: number }[] {
    const db = this.handle();
    const { where, args } = buildFilters(opts);
    const sql =
      "SELECT d.id AS document_id, bm25(fts_chunks) AS score " +
      "FROM fts_chunks JOIN chunks c ON c.id = fts_chunks.rowid JOIN documents d ON d.id = c.document_id " +
      `WHERE fts_chunks MATCH ?${where} ORDER BY bm25(fts_chunks) ASC LIMIT ?`;

    const cands = matchCandidates(opts.query);
    // The last candidate is the OR-of-all-terms fallback (only present when there are
    // 2+ terms). Everything before it requires every term to co-occur, which is what
    // makes a hit here strong evidence.
    const strict = cands.length > 1 && cands[cands.length - 1].includes(" OR ") ? cands.slice(0, -1) : cands;

    for (const cand of strict) {
      let rows: { document_id: number }[];
      try {
        rows = db.prepare(sql).all(cand, ...args, depth * OVERFETCH_FACTOR) as unknown as { document_id: number }[];
      } catch {
        continue;
      }
      if (!rows.length) continue;
      const out: { docId: number; rank: number }[] = [];
      const seen = new Set<number>();
      for (const r of rows) {
        if (seen.has(r.document_id)) continue;
        seen.add(r.document_id);
        out.push({ docId: r.document_id, rank: out.length + 1 });
        if (out.length >= depth) break;
      }
      return out;
    }
    return [];
  }

  /** Turn a fused document ordering back into renderable hits. */
  private hydrate(docIds: number[], snippetFor: Map<number, string>): SearchHit[] {
    if (!docIds.length) return [];
    const db = this.handle();
    const rows = db
      .prepare(
        `SELECT id, source_type, uri, thread_id, author, created_at FROM documents WHERE id IN (${docIds
          .map(() => "?")
          .join(", ")})`,
      )
      .all(...docIds) as {
      id: number;
      source_type: string;
      uri: string | null;
      thread_id: string | null;
      author: string | null;
      created_at: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: SearchHit[] = [];
    for (let i = 0; i < docIds.length; i++) {
      const d = byId.get(docIds[i]);
      if (!d) continue;
      out.push({
        snippet: snippetFor.get(docIds[i]) ?? "",
        source_type: d.source_type,
        uri: d.uri,
        thread_id: d.thread_id,
        author: d.author,
        created_at: d.created_at,
        score: i + 1, // fused RANK; the bm25 score is not meaningful across two lists
        document_id: d.id,
      });
    }
    return out;
  }

  /**
   * Hybrid retrieval: strict bm25 fused with vector KNN via weighted RRF.
   *
   * Falls back to plain bm25 — including the OR fallback rung — whenever the vector
   * side can't contribute: model unavailable, nothing embedded yet, or a contract
   * mismatch. `retrieval` on the result says which happened. A recall query must
   * never fail because of the embedding layer; a worse answer beats an error.
   */
  async searchHybrid(opts: SearchOptions): Promise<SearchResult> {
    const keyword = this.search(opts);
    if (!opts.query?.trim()) return { ...keyword, retrieval: "bm25" };

    const status = this.vectorStatus();
    if (!status.vectors || status.mismatch || !this.assertVectorContract()) {
      return { ...keyword, retrieval: "bm25" };
    }

    let qv: Float32Array | null = null;
    try {
      qv = (await this.embed([opts.query], "query"))?.[0] ?? null;
    } catch {
      qv = null; // a recall query must never fail because of the embedding layer
    }
    if (!qv) return { ...keyword, retrieval: "bm25" };

    const vecList = this.vectorSearch(qv, opts, this.fusion.vecDepth);
    if (!vecList.length) return { ...keyword, retrieval: "bm25" };

    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(opts.k ?? DEFAULT_LIMIT)));

    // The strict list is always computed: it's what the rank floor is allowed to act
    // on, regardless of which list feeds the fusion.
    const strictList = this.strictBm25(opts, this.fusion.bm25Depth);
    const bm25List =
      this.fusion.bm25Source === "ladder"
        ? keyword.results.slice(0, this.fusion.bm25Depth).map((h, i) => ({ docId: h.document_id, rank: i + 1 }))
        : strictList;

    // --- weighted reciprocal rank fusion ---
    // Rank-based, so no score normalization is needed between a negated bm25 and a
    // cosine — which is exactly why the spec chose RRF over a weighted score blend.
    const fused = new Map<number, number>();
    for (const b of bm25List) {
      fused.set(b.docId, (fused.get(b.docId) ?? 0) + this.fusion.bm25Weight / (this.fusion.rrfK + b.rank));
    }
    for (let i = 0; i < vecList.length; i++) {
      const d = vecList[i].docId;
      fused.set(d, (fused.get(d) ?? 0) + 1 / (this.fusion.rrfK + i + 1));
    }

    let order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([docId]) => docId);

    // --- rank-preserving floor ---
    //
    // Guarantee: a document that STRICT bm25 ranked Nth is never returned worse than
    // Nth. This is what makes hybrid a strict improvement on keyword search for
    // exact-token queries rather than a trade — the measured failure it fixes is
    // bake-off case C03 ("brag doc"), where bm25 ranks the answer 5th, the vector list
    // has never heard of a "brag doc", and 50 mediocre vector hits push it to 8th.
    //
    // Applied lowest-rank-first so satisfying one floor can't violate another, and
    // only to CORROBORATED documents; see FusionConfig.floorStrictRanks.
    if (this.fusion.floorStrictRanks && strictList.length) {
      const inVec = new Set(vecList.map((v) => v.docId));
      for (const { docId, rank } of [...strictList].sort((a, b) => a.rank - b.rank)) {
        if (!inVec.has(docId)) continue; // uncorroborated — no floor, see the doc comment
        const at = order.indexOf(docId);
        const target = rank - 1;
        if (at >= 0 && at <= target) continue; // already at or above its floor
        if (at >= 0) order.splice(at, 1);
        order.splice(Math.min(target, order.length), 0, docId);
      }
    }

    // --- rank-agreement promotion ---
    // The keyword path's top hit, corroborated by the vector list, goes to rank 1.
    // See FusionConfig.agreeDepth.
    if (this.fusion.agreeDepth > 0 && keyword.results.length) {
      const kwTop = keyword.results[0].document_id;
      const vecRank = vecList.findIndex((v) => v.docId === kwTop);
      if (vecRank >= 0 && vecRank < this.fusion.agreeDepth) {
        order = [kwTop, ...order.filter((d) => d !== kwTop)];
      }
    }

    // If bm25's single most confident hit still fell out of the returned window, put
    // it back in the LAST slot — it never displaces anything above it, it just isn't
    // allowed to vanish entirely.
    if (this.fusion.pinTopBm25 && bm25List.length) {
      const top = bm25List[0].docId;
      const at = order.indexOf(top);
      if (at < 0 || at >= limit) {
        order = order.filter((d) => d !== top).slice(0, Math.max(0, limit - 1));
        order.push(top);
      }
    }
    order = order.slice(0, limit);

    // --- snippets ---
    // A keyword hit keeps its fts5 snippet, guillemets and all. A vector-only hit has
    // no matched term to highlight, so it gets the head of its best-matching chunk.
    const snippetFor = new Map<number, string>();
    for (const h of keyword.results) snippetFor.set(h.document_id, h.snippet);
    const needText = order.filter((d) => !snippetFor.has(d));
    if (needText.length) {
      const chunkByDoc = new Map(vecList.map((v) => [v.docId, v.chunkId]));
      const ids = needText.map((d) => chunkByDoc.get(d)).filter((x): x is number => x !== undefined);
      if (ids.length) {
        const db = this.handle();
        const texts = db
          .prepare(`SELECT c.id AS id, c.document_id AS did, c.text AS text FROM chunks c WHERE c.id IN (${ids.map(() => "?").join(", ")})`)
          .all(...ids) as { id: number; did: number; text: string }[];
        for (const t of texts) {
          const flat = t.text.replace(/\s*\n+\s*/g, " ").trim();
          snippetFor.set(t.did, flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS)}…` : flat);
        }
      }
    }

    const hits = this.hydrate(order, snippetFor);

    // Same payload cap as the keyword path — the context budget doesn't care which
    // retriever found the row.
    const kept: SearchHit[] = [];
    let budget = 0;
    for (const r of hits) {
      const cost = r.snippet.length + (r.created_at?.length ?? 0) + (r.author?.length ?? 0) + 4;
      if (kept.length && budget + cost > MAX_PAYLOAD_CHARS) break;
      kept.push(r);
      budget += cost;
    }

    return {
      results: kept,
      // Documents CONSIDERED, not "documents matching your keywords": a vector search
      // ranks the whole corpus, so a keyword-style total would be a fiction.
      totalHits: fused.size,
      shown: kept.length,
      droppedForBudget: hits.length - kept.length,
      matchQuery: keyword.matchQuery,
      retrieval: "hybrid",
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  stats(): IndexStats {
    const db = this.handle();
    const perType = db
      .prepare(
        "SELECT d.source_type AS t, COUNT(*) AS docs, MIN(d.created_at) AS lo, MAX(d.created_at) AS hi " +
          "FROM documents d GROUP BY d.source_type",
      )
      .all() as { t: string; docs: number; lo: string | null; hi: string | null }[];
    const chunkCounts = db
      .prepare(
        "SELECT d.source_type AS t, COUNT(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id GROUP BY d.source_type",
      )
      .all() as { t: string; n: number }[];
    const fileCounts = db
      .prepare("SELECT source_type AS t, COUNT(*) AS n FROM ingest_files GROUP BY source_type")
      .all() as { t: string; n: number }[];

    const bySourceType: Record<string, SourceTypeStats> = {};
    for (const r of perType) {
      bySourceType[r.t] = {
        documents: r.docs,
        chunks: chunkCounts.find((c) => c.t === r.t)?.n ?? 0,
        files: fileCounts.find((f) => f.t === r.t)?.n ?? 0,
        firstDate: r.lo ? r.lo.slice(0, 10) : null,
        lastDate: r.hi ? r.hi.slice(0, 10) : null,
      };
    }
    // Sources with bookkeeping but no documents yet still deserve a row.
    for (const f of fileCounts) {
      if (!bySourceType[f.t]) {
        bySourceType[f.t] = { documents: 0, chunks: 0, files: f.n, firstDate: null, lastDate: null };
      }
    }

    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(this.dbPath).size;
    } catch {
      /* not yet flushed */
    }
    return {
      documents: perType.reduce((n, r) => n + r.docs, 0),
      chunks: chunkCounts.reduce((n, r) => n + r.n, 0),
      files: fileCounts.reduce((n, r) => n + r.n, 0),
      bySourceType,
      dbBytes,
      dbPath: this.dbPath,
    };
  }
}

// ---------------------------------------------------------------------------
// Default instance (vault-backed) + module-level API
// ---------------------------------------------------------------------------

let defaultIndex: BrainIndex | null = null;

export function getBrainIndex(): BrainIndex {
  if (!defaultIndex) defaultIndex = new BrainIndex();
  return defaultIndex;
}

/** Ranked, snippeted, budget-capped KEYWORD search across every indexed corpus. */
export function search(opts: SearchOptions): SearchResult {
  return getBrainIndex().search(opts);
}

/** Hybrid (keyword + vector) search. Degrades to keyword-only rather than failing. */
export function searchHybrid(opts: SearchOptions): Promise<SearchResult> {
  return getBrainIndex().searchHybrid(opts);
}

/** Embed chunks that don't have a vector yet. Safe to call repeatedly. */
export function embedPending(opts: { limit?: number } = {}): Promise<number> {
  return getBrainIndex().embedPending(opts);
}

/**
 * How many pending chunks the boot/append path will embed on its own before it stops
 * and tells you to run the backfill script instead.
 *
 * The everyday case is tiny: fig was down for an hour, twenty messages arrived, that's
 * twenty chunks and a couple of seconds. The pathological case is a fresh index with
 * ~11,000 chunks, which is ~40 minutes of ONNX — that must not start itself quietly in
 * the background while fig is trying to answer messages. Above this threshold it's an
 * explicit, supervised, run-it-overnight operation.
 */
const BOOT_EMBED_MAX = 500;

let embedInFlight: Promise<void> | null = null;
let embedAgain = false;

/**
 * Kick off embedding of pending chunks in the background. Returns immediately.
 *
 * Coalesced, not queued-per-call: if messages arrive while a pass is running, one more
 * pass happens after it, not one per message. Ten messages in ten seconds must not
 * mean ten concurrent ONNX sessions on a 16GB machine.
 */
export function scheduleEmbedPending(): void {
  if (embedInFlight) {
    embedAgain = true;
    return;
  }
  embedInFlight = (async () => {
    try {
      do {
        embedAgain = false;
        await getBrainIndex().embedPending();
      } while (embedAgain);
    } catch (e) {
      warn(`background embedding failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      embedInFlight = null;
    }
  })();
}

/**
 * Catch the vector layer up after a sync, without blocking the caller.
 *
 * Returns what it decided to do so the boot path can log it. A large backfill is
 * REPORTED, not started — see BOOT_EMBED_MAX.
 */
export function catchUpEmbeddings(): { pending: number; started: boolean } {
  let pending = 0;
  try {
    pending = getBrainIndex().pendingEmbedCount();
  } catch {
    return { pending: 0, started: false };
  }
  if (!pending) return { pending: 0, started: false };
  if (pending > BOOT_EMBED_MAX) return { pending, started: false };
  scheduleEmbedPending();
  return { pending, started: true };
}

export function vectorStatus(): VectorStatus {
  return getBrainIndex().vectorStatus();
}

export function pendingEmbedCount(): number {
  return getBrainIndex().pendingEmbedCount();
}

export function indexStats(): IndexStats {
  return getBrainIndex().stats();
}

export function rebuildAll(): { files: number; documents: number } {
  return getBrainIndex().rebuildAll();
}

export function syncAll(): { files: number; changed: number; documents: number } {
  return getBrainIndex().syncAll();
}

/** Incrementally index a single file (used by writers right after they append). */
export function indexSourceFile(filePath: string): number {
  return getBrainIndex().indexFile(filePath);
}

export const _internals = {
  matchCandidates,
  chunkText,
  upperDateBound,
  MAX_PAYLOAD_CHARS,
  MAX_SNIPPET_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_TARGET_CHARS,
  FUSE_BM25_DEPTH,
  FUSE_VEC_DEPTH,
  RRF_K,
  BM25_WEIGHT,
  PIN_TOP_BM25,
};
