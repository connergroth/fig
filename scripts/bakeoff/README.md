# embedding bake-off

Throwaway-but-reproducible harness for picking the local embedding model behind the
conversation recall index. Nothing here is imported by `src/` — it reads the production
index code, it doesn't feed it.

## Why it exists

The recall index is a hybrid (bm25 + vectors, fused with RRF). Before wiring an embedder
into the real ingest path, the model choice had to be decided on **this corpus** — ~10k
iMessage messages between the owner and the agent — rather than on someone else's
legal-and-medical retrieval leaderboard. The specific worry: a leaderboard score is
measured on long formal passages, and this corpus is short chat turns about lunch and
whoever texted an hour ago.

## Candidates

| | granite | harrier |
|---|---|---|
| upstream | `ibm-granite/granite-embedding-english-r2` | `microsoft/harrier-oss-v1-0.6b` |
| onnx build | `onnx-community/granite-embedding-english-r2-ONNX` | `onnx-community/harrier-oss-v1-0.6b-ONNX` |
| license | apache-2.0 | mit |
| params | 149M | 0.6B |
| arch | ModernBERT encoder | Qwen3 decoder |
| pooling | CLS | last token (EOS) |
| normalized | no — we L2 it | yes, in the export |
| query prefix | **none** | `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ` |
| doc prefix | none | none |
| dim | 768 | **1024** |

The prefix contract is the thing that silently breaks. Both were read off the model card
and `1_Pooling/config.json`, not assumed — see the header comment in `models.ts`.

## Setup

`@huggingface/transformers` is a **real dependency** in `package.json` — the model this
harness selected is wired into production, so `npm ci` installs it. Nothing extra to do.
(If `npm ci` ever ERESOLVEs on zod, the answer is the `//overrides` note in
`package.json`, not a `--legacy-peer-deps` install here.)

ONNX weights cache to `~/.cache/fig-bakeoff-models` for the harness. **Production uses
a separate `~/.cache/fig-models`** on purpose, so the teardown below can't delete the
weights production depends on.

## Running

```
npx tsx scripts/bakeoff/buildEvalSet.ts        # parts/*.json -> eval-set.json, validating every target
npx tsx scripts/bakeoff/run.ts                 # embed (cached) + score + report
npx tsx scripts/bakeoff/run.ts --skip-embed    # scoring only, seconds
npx tsx scripts/bakeoff/selftest.ts            # harness unit checks
```

`loggrep.ts` is the grounding tool used to author eval cases:

```
npx tsx scripts/bakeoff/loggrep.ts "dark knight" --limit 10
npx tsx scripts/bakeoff/loggrep.ts --hash 6f38c4ad4e37f55e     # dump one message in full
```

## The eval set

> **This is private data.** `eval-set.json`, `parts/*.json` and `results/*` are queries,
> previews and notes lifted from one owner's real conversation log, and every target is a
> hash of a message in a vault that doesn't ship. They're useful to nobody else. Mine your
> own with `loggrep.ts` + `buildEvalSet.ts` against your own log, and don't publish these
> files anywhere.

`eval-set.json` — 94 cases, 138 ground-truth targets. Authored in `parts/`, merged and
validated by `buildEvalSet.ts`. Targets are keyed on `sha256(message text)[0:16]`, not
on file+ord, so a hand-edit in Obsidian that shifts message positions doesn't silently
re-point an answer at the wrong message.

Three provenances, and the split is the point:

- **A (26) — vocabulary-mismatch seeds.** Known real misses. The query deliberately
  avoids the target's words: "the guy four levels up i'm getting coffee with" → a message
  that only ever says someone is "two rungs under" a named exec. This is the half bm25
  structurally cannot do.
- **B (48) — mined paraphrases.** Real messages sampled across the whole date range, then
  a natural query written for each in different vocabulary. Spread across food, gym,
  school, work, finance, travel, people, and the agent's own infra work; a third target
  short messages rather than long agent briefings.
- **C (20) — exact-token controls.** The rare token IS in the target: citation numbers,
  flight numbers, `BlueBubblesHelper.dylib`, "indian rock". bm25 should win or tie
  these. They exist to catch an embedder that regresses the half keyword search already
  does well — if hybrid loses to bm25-only here, that's the finding.

Multi-target cases list **every** genuinely-correct answer. Withholding one to make a
case "harder" produces a false miss and corrupts the metric.

## The two bm25 baselines

Measuring the baseline is what surfaced the ladder bug described below, so the harness
reports **two** bm25 configs:

- `bm25-only` — current `BrainIndex.search()` behaviour. Returns **zero rows on 64 of
  94 cases**. `matchCandidates()` builds a ladder ending in an OR-of-all-terms fallback,
  but `search()` stops at the first candidate that doesn't *throw*. Candidate #1 is the
  raw query, fts5's implicit operator is AND, and a seven-word question almost never has
  all seven terms in one chunk — so it returns nothing, without throwing, and the
  fallback is unreachable for exactly the natural-language queries a recall tool gets.
- `bm25-fallback` — same index, ladder also advances on an empty result set. One-line
  change; roughly doubles the baseline (MRR 0.162 → 0.259) and takes the exact-token
  controls to 100% recall@10.

`<model>-hybrid` fuses `bm25-only`; `<model>-hybrid+fb` fuses `bm25-fallback`.

**The bug is fixed.** `BrainIndex.search()` now advances the ladder on an empty result
set as well as on a throw, and `production-keyword` in the acceptance run below
reproduces `bm25-fallback` exactly (0.2587 / 0.1581 / 0.0736 / 0.8338).

## Scoring PRODUCTION (not the harness)

`run.ts` scores a harness re-implementation of retrieval, which is the right thing when
you're choosing a model and the wrong thing once the model is wired in. These two score
the real `BrainIndex` code path:

```
npx tsx scripts/bakeoff/runProduction.ts    # acceptance: real index, real searchHybrid()
npx tsx scripts/bakeoff/tuneFusion.ts       # grid-search the fusion knobs
```

`runProduction.ts` reads the live brain index at `$BRAIN_DIR/.state/brain-index.db` and
calls `BrainIndex.searchHybrid()` — real fusion, real snippets, real payload cap, real
lazily-loaded embedder. It writes `results/production.txt` + `.json`. Fusion overrides
(`--vec-depth`, `--bm25-depth`, `--bm25-weight`, `--agree`) exist so "we're below the
harness" can be distinguished from "we're wired wrong".

`tuneFusion.ts` builds a scratch index at `.state/bakeoff-production.db` and seeds it
from the harrier vector cache rather than re-embedding for 22 minutes. That shortcut is
only legitimate because the production embedder reproduces the harness's vectors at
cosine 1.0000 — `scripts/dev/verify-contract.ts` is what proves it, and it should be
re-run if either contract ever changes.

## Files

- `corpus.ts` — loads the log through the real `conversationSource` parser and the real
  `chunkText`, so the thing being scored is the real corpus
- `loggrep.ts` — grounding CLI
- `evalSet.ts` / `buildEvalSet.ts` — types, loader, validator, merger
- `models.ts` — the two model contracts
- `embedder.ts` — transformers.js behind a hand-typed 4-call interface (so typecheck
  doesn't depend on an unsaved package)
- `vectorStore.ts` — per-model sqlite vector cache, content-addressed on sha256(text)
- `embedCorpus.ts` — one model, one child process (clean wall-clock + RSS attribution)
- `retrieval.ts` — bm25 / vec / RRF + recall\@k and MRR
- `run.ts` — orchestrator, writes `results/report.txt` + `results/report.json`
- `runProduction.ts` — acceptance run against the real production path
- `tuneFusion.ts` — fusion grid search, writes `results/tuning.json`

## Deleting it

`rm -rf scripts/bakeoff ~/.cache/fig-bakeoff-models "$BRAIN_DIR"/.state/bakeoff-*.db*`.

Do **not** delete `~/.cache/fig-models` (production weights) and do not remove
`@huggingface/transformers` from `package.json` — production imports it now. Deleting
this directory also removes the only reproducible check on the fusion tuning, so prefer
keeping it until the eval set is replaced by something better.
