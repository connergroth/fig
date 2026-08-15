/**
 * Harness self-checks. `tsx scripts/bakeoff/selftest.ts`
 *
 * Not wired into `npm test` — this is throwaway tooling and the production suite
 * shouldn't grow a dependency on it. But the scoring code is the part where a bug
 * produces a plausible-looking number instead of a crash, so it gets tested.
 */

import assert from "node:assert/strict";

import { loadCorpus } from "./corpus";
import { planBatches } from "./embedCorpus";
import { loadEvalSet, resolveCases } from "./evalSet";
import { MODELS } from "./models";
import { aggregate, rrf, scoreCase } from "./retrieval";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

// --- metrics ---------------------------------------------------------------

test("scoreCase finds the first relevant doc, 1-based", () => {
  const ranked = [7, 3, 9].map((docId) => ({ docId, score: 1 }));
  assert.equal(scoreCase("x", ranked, [9]).rank, 3);
  assert.equal(scoreCase("x", ranked, [7]).rank, 1);
  assert.equal(scoreCase("x", ranked, [9, 3]).rank, 2, "earliest relevant wins, not the listed order");
  assert.equal(scoreCase("x", ranked, [42]).rank, 0);
  assert.equal(scoreCase("x", [], [1]).rank, 0);
});

test("aggregate: recall@k is monotone and MRR matches by hand", () => {
  const m = aggregate([
    { caseId: "a", rank: 1, topDocId: 0 },
    { caseId: "b", rank: 4, topDocId: 0 },
    { caseId: "c", rank: 11, topDocId: 0 },
    { caseId: "d", rank: 0, topDocId: 0 },
  ]);
  assert.equal(m.n, 4);
  assert.equal(m.r1, 0.25);
  assert.equal(m.r5, 0.5);
  assert.equal(m.r10, 0.5, "rank 11 is outside k=10");
  assert.ok(m.r1 <= m.r5 && m.r5 <= m.r10);
  assert.ok(Math.abs(m.mrr - (1 + 1 / 4 + 1 / 11) / 4) < 1e-12);
});

test("aggregate on an empty slice doesn't divide by zero", () => {
  assert.deepEqual(aggregate([]), { n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 });
});

// --- rrf -------------------------------------------------------------------

test("rrf promotes a doc both lists agree on over either list's own #1", () => {
  const a = [{ docId: 1, score: 9 }, { docId: 2, score: 8 }];
  const b = [{ docId: 3, score: 9 }, { docId: 2, score: 8 }];
  const fused = rrf([a, b], 3);
  assert.equal(fused[0].docId, 2, "doc 2 is 2nd in both, so it beats two 1st-and-absent docs");
});

test("rrf with one empty list degrades to that list's order", () => {
  const a = [{ docId: 5, score: 1 }, { docId: 6, score: 1 }];
  assert.deepEqual(rrf([a, []], 5).map((r) => r.docId), [5, 6]);
});

// --- batching --------------------------------------------------------------

test("planBatches never exceeds the padded-token budget", () => {
  const lengths = [640, 12, 300, 640, 5, 5, 5, 128, 400];
  for (const batch of planBatches(lengths, 1024, 64)) {
    const maxLen = Math.max(...batch.map((i) => lengths[i]));
    assert.ok(maxLen * batch.length <= 1024 || batch.length === 1, `batch ${batch} blew the budget`);
  }
});

test("planBatches covers every index exactly once", () => {
  const lengths = Array.from({ length: 257 }, (_, i) => (i % 17) * 40 + 1);
  const seen = planBatches(lengths, 2048, 8).flat().sort((a, b) => a - b);
  assert.deepEqual(seen, lengths.map((_, i) => i));
});

test("planBatches respects maxBatch even for tiny inputs", () => {
  const lengths = Array.from({ length: 100 }, () => 1);
  for (const b of planBatches(lengths, 1e9, 8)) assert.ok(b.length <= 8);
});

// --- model contracts -------------------------------------------------------

test("model contracts are asymmetric in the direction the cards specify", () => {
  assert.equal(MODELS.granite.queryPrefix, null, "granite takes no prompts");
  assert.equal(MODELS.granite.docPrefix, null);
  assert.ok(MODELS.harrier.queryPrefix?.startsWith("Instruct: "), "harrier queries need the instruct prompt");
  assert.ok(MODELS.harrier.queryPrefix?.includes("\nQuery: "), "…and the literal newline before Query:");
  assert.equal(MODELS.harrier.docPrefix, null, "harrier documents are fed bare");
  assert.equal(MODELS.granite.dim, 768);
  assert.equal(MODELS.harrier.dim, 1024);
});

// --- eval set integrity ----------------------------------------------------

test("every eval-set target resolves against the live corpus", () => {
  const corpus = loadCorpus();
  const { cases, problems } = resolveCases(loadEvalSet(), corpus);
  const fatal = problems.filter((p) => !p.includes("drift"));
  assert.deepEqual(fatal, [], `unresolvable targets:\n${fatal.join("\n")}`);
  assert.ok(cases.length >= 60, `expected 60+ cases, got ${cases.length}`);
  for (const c of cases) assert.ok(c.targetDocIds.length > 0, `${c.id} resolved to nothing`);
});

test("category C queries really do share a rare token with their target", () => {
  const corpus = loadCorpus();
  const { cases } = resolveCases(loadEvalSet(), corpus);
  const stop = new Set(["the", "a", "an", "my", "i", "we", "for", "of", "to", "in", "on", "and", "that", "what", "who", "with", "is", "was", "did", "number", "at", "it"]);
  for (const c of cases.filter((x) => x.provenance === "C")) {
    const terms = (c.query.toLowerCase().match(/[a-z0-9][a-z0-9._$-]{2,}/g) ?? []).filter((t) => !stop.has(t));
    const targets = c.targetDocIds.map((id) => corpus.docs[id].text.toLowerCase());
    const shared = terms.some((t) => targets.some((tx) => tx.includes(t)));
    assert.ok(shared, `${c.id} "${c.query}" shares no literal term with its target — that's an A case, not a C case`);
  }
});

console.log(`\n${n} checks passed`);
