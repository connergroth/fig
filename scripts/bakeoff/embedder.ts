/**
 * transformers.js embedder — in-process ONNX, no ollama, no python, no daemon.
 *
 * transformers.js is loaded through a plain `require` behind a hand-written minimal
 * interface rather than an `import`, on purpose: a real import would make
 * `npm run typecheck` depend on the package being installed, and this harness has to stay
 * runnable (and typecheckable) on a tree that doesn't have the ONNX runtime pulled down.
 * The surface we use is four calls wide, so the cost of typing it by hand is near zero.
 */

import os from "node:os";
import path from "node:path";

import type { ModelSpec } from "./models";

// ---------------------------------------------------------------------------
// Minimal hand-typed surface of @huggingface/transformers
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
type Tokenizer = (texts: string[], opts: { padding: boolean; truncation: boolean; max_length: number }) => Promise<TokenizerOutput>;
type Model = (inputs: TokenizerOutput) => Promise<Record<string, OnnxTensor | undefined>>;
interface TransformersModule {
  env: { cacheDir: string; allowLocalModels: boolean };
  AutoTokenizer: { from_pretrained(id: string): Promise<Tokenizer> };
  AutoModel: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<Model> };
}

/** Where ONNX weights land. Outside both git repos on purpose — ~900MB for the pair. */
export const MODEL_CACHE_DIR = path.join(os.homedir(), ".cache", "fig-bakeoff-models");

function loadTransformers(): TransformersModule {
  let mod: TransformersModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@huggingface/transformers") as TransformersModule;
  } catch {
    throw new Error(
      "@huggingface/transformers is not installed. It IS a declared dependency (production " +
        "uses it too), so this means the tree is incomplete:\n\n" +
        "  npm install\n",
    );
  }
  mod.env.cacheDir = MODEL_CACHE_DIR;
  mod.env.allowLocalModels = false;
  return mod;
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export interface Embedder {
  readonly spec: ModelSpec;
  /** Returns one L2-normalized Float32Array per input, each `spec.dim` long. */
  encode(texts: string[], role: "query" | "document"): Promise<Float32Array[]>;
  /** Wall-clock ms spent inside model forward passes. */
  forwardMs: number;
  /** Total tokens fed (padded), for a tokens/sec number. */
  paddedTokens: number;
}

export async function createEmbedder(spec: ModelSpec): Promise<Embedder> {
  const t = loadTransformers();
  const tokenizer = await t.AutoTokenizer.from_pretrained(spec.repo);
  const model = await t.AutoModel.from_pretrained(spec.repo, { dtype: spec.dtype, device: "cpu" });

  const state = { forwardMs: 0, paddedTokens: 0 };

  return {
    spec,
    get forwardMs() {
      return state.forwardMs;
    },
    get paddedTokens() {
      return state.paddedTokens;
    },
    async encode(texts: string[], role: "query" | "document"): Promise<Float32Array[]> {
      if (!texts.length) return [];
      const prefix = (role === "query" ? spec.queryPrefix : spec.docPrefix) ?? "";
      const prepared = prefix ? texts.map((s) => prefix + s) : texts;

      const inputs = await tokenizer(prepared, { padding: true, truncation: true, max_length: spec.maxLength });
      const t0 = performance.now();
      const out = await model(inputs);
      state.forwardMs += performance.now() - t0;
      state.paddedTokens += inputs.input_ids.dims[0] * inputs.input_ids.dims[1];

      const se = out.sentence_embedding;
      if (!se) {
        throw new Error(
          `${spec.repo} exposed no sentence_embedding output (got: ${Object.keys(out).join(", ")}). ` +
            "This harness relies on the ONNX export carrying the model's own pooling head.",
        );
      }
      const [b, d] = se.dims;
      if (d !== spec.dim) throw new Error(`${spec.key}: expected dim ${spec.dim}, model returned ${d}`);
      const data = se.data as Float32Array;

      const vecs: Float32Array[] = [];
      for (let i = 0; i < b; i++) {
        const v = data.slice(i * d, i * d + d) as Float32Array;
        // granite is unnormalized, harrier already is. Normalizing both keeps cosine a
        // plain dot product downstream and is a no-op on the one that's already unit.
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
}
