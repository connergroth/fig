/**
 * The two candidates, and the contract each one has to be fed under.
 *
 * The contract is the whole reason this file exists separately from the runner. Both
 * of these models fail SILENTLY when you get it wrong — a missing query prefix or the
 * wrong pooling doesn't throw, it just retrieves a bit worse, which is indistinguishable
 * from "this model is worse" in a bake-off. Every field below was read off the model
 * card / 1_Pooling/config.json rather than assumed:
 *
 *   granite-embedding-english-r2  (ibm-granite, apache-2.0, 149M, ModernBERT)
 *     modules.json = Transformer + Pooling{cls}. NO Normalize module — the card says
 *     "the model produces unnormalized vectors", so we L2 them ourselves for cosine.
 *     No prompts anywhere in the repo: queries and documents are fed bare.
 *     768d, max_seq_length 8192.
 *
 *   harrier-oss-v1-0.6b  (microsoft, MIT, 0.6B, Qwen3 decoder)
 *     modules.json = Transformer + Pooling{lasttoken} + Normalize.
 *     ASYMMETRIC prompts: queries get `Instruct: {task}\nQuery: `, documents get
 *     nothing. Task string is the `web_search_query` prompt from
 *     config_sentence_transformers.json verbatim.
 *     1024d — NOT 768. See DIM_NOTE below.
 *     tokenizer.json has a TemplateProcessing post_processor that appends
 *     <|endoftext|> (151643), so the last-token position is the EOS. transformers.js
 *     honours post_processors, verified by inspecting input_ids.
 *
 * Both ONNX exports expose a `sentence_embedding` output that already applies the
 * model's own ST pooling head, so we read that instead of re-implementing pooling off
 * last_hidden_state. Verified for granite: cos(sentence_embedding, CLS of
 * last_hidden_state) = 1.000000. harrier's export exposes ONLY sentence_embedding, so
 * there is no other option there anyway.
 *
 * DIM_NOTE: the production spec (Projects/fig/semantic-search.md) sizes the vec column
 * at 768 for granite. harrier is 1024. Dimension is a one-way door — switching later
 * means a full re-embed of every corpus — so this difference is a real cost on the
 * challenger's side, not a footnote.
 */

export interface ModelSpec {
  key: string;
  /** transformers.js repo id (an ONNX build, not the pytorch original). */
  repo: string;
  /** The upstream model these weights come from. */
  upstream: string;
  license: string;
  params: string;
  dim: number;
  /** ONNX dtype variant. q8 = the `model_quantized.onnx` file. */
  dtype: string;
  /** Prepended to QUERIES only. null = symmetric, feed queries bare. */
  queryPrefix: string | null;
  /** Prepended to DOCUMENTS only. Both candidates want nothing here. */
  docPrefix: string | null;
  pooling: "cls" | "lasttoken";
  /** Tokenizer truncation. Our chunks cap at 2048 chars ≈ 512 tokens. */
  maxLength: number;
  notes: string;
}

export const MODELS: Record<string, ModelSpec> = {
  granite: {
    key: "granite",
    repo: "onnx-community/granite-embedding-english-r2-ONNX",
    upstream: "ibm-granite/granite-embedding-english-r2",
    license: "apache-2.0",
    params: "149M",
    dim: 768,
    dtype: "q8",
    queryPrefix: null,
    docPrefix: null,
    pooling: "cls",
    maxLength: 640,
    notes: "ModernBERT encoder, CLS pooling, unnormalized output (we L2 it), no task prefixes.",
  },
  harrier: {
    key: "harrier",
    repo: "onnx-community/harrier-oss-v1-0.6b-ONNX",
    upstream: "microsoft/harrier-oss-v1-0.6b",
    license: "mit",
    params: "0.6B",
    dim: 1024,
    dtype: "q8",
    queryPrefix:
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
    docPrefix: null,
    pooling: "lasttoken",
    maxLength: 640,
    notes:
      "Qwen3 decoder, last-token pooling on an EOS the tokenizer appends, output already L2-normalized. " +
      "1024d, not 768 — a dimension change is a one-way door for the production vec column.",
  },
};

export function modelSpec(key: string): ModelSpec {
  const m = MODELS[key];
  if (!m) throw new Error(`unknown model "${key}" — known: ${Object.keys(MODELS).join(", ")}`);
  return m;
}
