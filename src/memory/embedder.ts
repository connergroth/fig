/**
 * Local embedding model for the brain index — in-process ONNX, no ollama, no python,
 * no daemon.
 *
 * The daemon call: transformers.js running the ONNX weights inside fig's own node
 * process, rather than talking to an ollama server. Same reasoning that picked
 * node:sqlite over better-sqlite3 — ollama is a second thing that can be down,
 * mid-upgrade, or simply unstarted after a reboot, and if it is, ingest silently
 * stops. In-process means embeddings work exactly when fig works.
 *
 * The model is harrier, picked by measurement rather than by leaderboard. The
 * bake-off (scripts/bakeoff/, 94 cases over this actual corpus) scored it at 0.443
 * MRR against granite's 0.365 and a fixed bm25 baseline's 0.259, with the gap
 * concentrated in the mined-paraphrase category — short chat turns worded differently
 * from the target, which is the realistic query shape for a recall tool. The costs
 * are real and were accepted knowingly: 1024d instead of 768, ~716MB of weights
 * instead of ~161MB, and ~3x the embed time.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT IS THE DANGEROUS PART
 * ---------------------------------------------------------------------------
 * Every field in MODEL below was read off the model card / config_sentence_transformers
 * .json rather than assumed, because getting any of them wrong FAILS SILENTLY. A
 * missing query prefix or the wrong pooling doesn't throw — it just retrieves a bit
 * worse forever, which is indistinguishable from "this model is mediocre".
 *
 * Specifically:
 *   - PREFIXES ARE ASYMMETRIC. Queries get `Instruct: {task}\nQuery: `; documents get
 *     nothing at all. Feeding documents the query prefix, or queries none, degrades
 *     retrieval without any error. The task string is the `web_search_query` prompt
 *     from config_sentence_transformers.json, verbatim, and is kept byte-identical to
 *     the bake-off's so production numbers stay comparable to the harness numbers.
 *   - The ONNX export emits ONLY `sentence_embedding`, which already applies the
 *     model's own last-token pooling head AND L2 normalization. We do not re-implement
 *     pooling off last_hidden_state; there is no last_hidden_state to work from.
 *   - Last-token pooling reads the EOS position, which exists because tokenizer.json
 *     has a TemplateProcessing post_processor appending <|endoftext|> (151643).
 *     transformers.js honours post_processors — verified in the bake-off by inspecting
 *     input_ids. If that ever stops being true, every vector silently becomes the
 *     embedding of the last real word instead of the sequence.
 *
 * ---------------------------------------------------------------------------
 * DIMENSION IS A ONE-WAY DOOR
 * ---------------------------------------------------------------------------
 * 1024, not the 768 the original spec sized the vec column at. Changing it later means
 * re-embedding every corpus, so `CONTRACT` below is stamped into the index metadata and
 * checked on every open — a mismatch fails LOUDLY rather than quietly cosine-ing
 * vectors from two different spaces against each other, which produces plausible
 * garbage and no error.
 */

import os from "node:os";
import path from "node:path";

import { warn } from "../core/log";

// ---------------------------------------------------------------------------
// Model contract
// ---------------------------------------------------------------------------

export const MODEL = {
  key: "harrier",
  /** transformers.js repo id — the ONNX build, not the pytorch original. */
  repo: "onnx-community/harrier-oss-v1-0.6b-ONNX",
  upstream: "microsoft/harrier-oss-v1-0.6b",
  license: "mit",
  /** ONNX dtype variant. q8 = model_quantized.onnx. */
  dtype: "q8",
  /** NOT 768. See the one-way-door note above. */
  dim: 1024,
  /** Prepended to QUERIES ONLY. Byte-identical to the bake-off's. */
  queryPrefix:
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
  /** Documents are fed bare. Not "unset" — deliberately empty. */
  docPrefix: null as string | null,
  pooling: "lasttoken",
  /** Tokenizer truncation. Chunks cap at 2048 chars ≈ 512 tokens, so 640 has headroom. */
  maxLength: 640,
} as const;

/**
 * The identity of the vector space, stamped into the index and re-checked on open.
 *
 * Everything that changes what a vector MEANS belongs in this string. Two vectors are
 * only comparable if they were produced under the same contract, and the failure mode
 * of mixing them is silent — cosine still returns a number, the number is just wrong.
 */
export const CONTRACT = `${MODEL.repo}|${MODEL.dtype}|${MODEL.dim}|${MODEL.queryPrefix}`;

export type EmbedRole = "query" | "document";

/**
 * Where ONNX weights land. Outside the git repos on purpose — ~716MB.
 *
 * Deliberately NOT the bake-off's ~/.cache/fig-bakeoff-models: that directory is
 * documented as deletable (`rm -rf` is in the harness README's teardown), and
 * production must not have its weights removed by someone cleaning up a throwaway
 * harness.
 */
export const MODEL_CACHE_DIR = path.join(os.homedir(), ".cache", "fig-models");

// ---------------------------------------------------------------------------
// Minimal hand-typed surface of @huggingface/transformers
//
// transformers.js is loaded through `require` behind a hand-written interface rather
// than a top-level `import`, for two reasons that both still hold now that it IS a
// real dependency:
//
//   1. Loading it costs real time and memory before a single embedding is asked for.
//      A top-level import would be hoisted and paid at boot by every process that
//      touches the memory module — including short-lived scripts that never search.
//   2. The surface used here is four calls wide, so hand-typing it costs ~15 lines and
//      keeps `tsc --noEmit` independent of the package's own shipped types (which are
//      generated and enormous).
// ---------------------------------------------------------------------------

interface OnnxTensor {
  dims: number[];
  data: Float32Array | BigInt64Array;
  type: string;
}
interface TokenizerOutput {
  input_ids: OnnxTensor;
  attention_mask: OnnxTensor;
}
type Tokenizer = (
  texts: string[],
  opts: { padding: boolean; truncation: boolean; max_length: number },
) => Promise<TokenizerOutput>;
type Model = (inputs: TokenizerOutput) => Promise<Record<string, OnnxTensor | undefined>>;
interface TransformersModule {
  env: { cacheDir: string; allowLocalModels: boolean };
  AutoTokenizer: { from_pretrained(id: string): Promise<Tokenizer> };
  AutoModel: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<Model> };
}

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

export interface Embedder {
  /** One L2-normalized Float32Array per input, each MODEL.dim long. */
  encode(texts: string[], role: EmbedRole): Promise<Float32Array[]>;
}

interface LoadedEmbedder extends Embedder {
  tokenizer: Tokenizer;
  model: Model;
}

/**
 * Module state.
 *
 * `loading` holds the in-flight load so concurrent first-callers share one 716MB load
 * instead of racing into several. `failed` latches: once the model has failed to load
 * we do NOT retry on every subsequent query, because the failure modes here (missing
 * weights, no disk, incompatible runtime) are all persistent, and retrying means
 * paying a multi-second stall on every single search forever.
 */
let loading: Promise<LoadedEmbedder> | null = null;
let loaded: LoadedEmbedder | null = null;
let failed = false;
let failureReason = "";

/** True once the model is resident. Cheap; does not trigger a load. */
export function embedderLoaded(): boolean {
  return loaded !== null;
}

/** False once loading has permanently failed for this process. */
export function embeddingsAvailable(): boolean {
  return !failed;
}

export function embedderFailureReason(): string {
  return failureReason;
}

/** Reset the latch — tests only, so one failure case doesn't poison the rest of a run. */
export function _resetEmbedderForTests(): void {
  loading = null;
  loaded = null;
  failed = false;
  failureReason = "";
}

function loadTransformers(): TransformersModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@huggingface/transformers") as TransformersModule;
  mod.env.cacheDir = MODEL_CACHE_DIR;
  // Weights come from the HF hub into MODEL_CACHE_DIR. Local model dirs are not
  // consulted, so a stray ./models folder can't shadow the pinned repo.
  mod.env.allowLocalModels = false;
  return mod;
}

async function createEmbedder(): Promise<LoadedEmbedder> {
  const t = loadTransformers();
  const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL.repo);
  const model = await t.AutoModel.from_pretrained(MODEL.repo, { dtype: MODEL.dtype, device: "cpu" });

  const self: LoadedEmbedder = {
    tokenizer,
    model,
    async encode(texts: string[], role: EmbedRole): Promise<Float32Array[]> {
      if (!texts.length) return [];
      // ASYMMETRIC. Queries get the instruct prefix, documents get nothing.
      const prefix = (role === "query" ? MODEL.queryPrefix : MODEL.docPrefix) ?? "";
      const prepared = prefix ? texts.map((s) => prefix + s) : texts;

      const inputs = await tokenizer(prepared, {
        padding: true,
        truncation: true,
        max_length: MODEL.maxLength,
      });
      const out = await model(inputs);

      const se = out.sentence_embedding;
      if (!se) {
        throw new Error(
          `${MODEL.repo} exposed no sentence_embedding output (got: ${Object.keys(out).join(", ")}). ` +
            "This model's ONNX export is expected to carry its own pooling head.",
        );
      }
      const [b, d] = se.dims;
      if (d !== MODEL.dim) {
        throw new Error(`${MODEL.key}: expected dim ${MODEL.dim}, model returned ${d}`);
      }
      const data = se.data as Float32Array;

      const vecs: Float32Array[] = [];
      for (let i = 0; i < b; i++) {
        const v = data.subarray(i * d, i * d + d);
        // harrier's export already L2-normalizes, so this is a no-op on a healthy
        // model. It stays because it makes "cosine == dot product" a property this
        // module GUARANTEES rather than one it inherits — every downstream scorer
        // relies on it, and a future model swap shouldn't silently break them.
        let n = 0;
        for (let j = 0; j < d; j++) n += v[j] * v[j];
        n = Math.sqrt(n) || 1;
        const u = new Float32Array(d);
        for (let j = 0; j < d; j++) u[j] = v[j] / n;
        vecs.push(u);
      }
      return vecs;
    },
  };
  return self;
}

/**
 * Get the embedder, loading it on first use.
 *
 * Throws if loading fails. Callers on the search path should use the `try*` helpers
 * below instead — a recall query must degrade to bm25, never fail.
 */
export async function getEmbedder(): Promise<Embedder> {
  if (loaded) return loaded;
  if (failed) throw new Error(`embedder unavailable: ${failureReason}`);
  if (!loading) {
    loading = createEmbedder().then(
      (e) => {
        loaded = e;
        return e;
      },
      (e: unknown) => {
        failed = true;
        failureReason = e instanceof Error ? e.message : String(e);
        loading = null;
        throw e;
      },
    );
  }
  return loading;
}

// ---------------------------------------------------------------------------
// Graceful helpers — the search path uses these
// ---------------------------------------------------------------------------

/**
 * Embed one query, or return null if the embedding layer is unavailable.
 *
 * Null is a normal, expected outcome, not an error: it means "retrieval falls back to
 * bm25 alone". A worse answer beats an exception, because the alternative is
 * `recall_conversations` returning a stack trace for a question bm25 could have
 * answered adequately.
 */
export async function tryEmbedQuery(text: string): Promise<Float32Array | null> {
  if (failed) return null;
  try {
    const e = await getEmbedder();
    const [v] = await e.encode([text], "query");
    return v ?? null;
  } catch (e) {
    // Only the FIRST failure is worth a log line; after that `failed` latches and this
    // returns null without noise on every query.
    if (!failed) {
      failed = true;
      failureReason = e instanceof Error ? e.message : String(e);
    }
    warn(`embedding unavailable, falling back to keyword-only search: ${failureReason}`);
    return null;
  }
}

/** Embed documents, or return null to signal "skip vectors for now". */
export async function tryEmbedDocuments(texts: string[]): Promise<Float32Array[] | null> {
  if (failed) return null;
  try {
    const e = await getEmbedder();
    return await e.encode(texts, "document");
  } catch (e) {
    if (!failed) {
      failed = true;
      failureReason = e instanceof Error ? e.message : String(e);
    }
    warn(`embedding unavailable, chunks will be indexed without vectors: ${failureReason}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/**
 * Padded tokens per forward pass, and a hard row cap.
 *
 * The budget is what bounds MEMORY: attention is quadratic in sequence length, so a
 * batch of twelve 640-token chunks costs far more than a hundred 40-token ones.
 *
 * 2048, not the bake-off's 8192. The harness measured 9.2GB peak RSS at 8192 — fine
 * for a one-off benchmark on an idle machine, a genuine hazard on a 16GB mini that is
 * also running Messages and Chrome. The backfill runs once, overnight, so trading wall
 * clock for headroom is free. See scripts/backfillEmbeddings.ts for the measured
 * numbers at this budget.
 */
export const TOKEN_BUDGET = 2048;
export const MAX_BATCH = 64;

/** Rough token count for batch planning. Deliberately cheap — no tokenizer needed. */
export function estimateTokens(s: string): number {
  return Math.min(MODEL.maxLength, Math.ceil(s.length / 4) + 2);
}

/**
 * Group indices into batches whose PADDED token cost stays under budget.
 *
 * Length-sorted rather than fixed-size: this corpus is a chat log where most messages
 * are one line and a few are 45,000 chars. Fixed batches pad every short member out to
 * the longest one and burn most of the compute on padding.
 */
export function planBatches(lengths: number[], budget = TOKEN_BUDGET, maxBatch = MAX_BATCH): number[][] {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[b] - lengths[a]);
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
