/**
 * Deterministic forced-rollover test for the working-state compaction (no API needed).
 *
 * Simulates two back-to-back rollovers using the same merge/render code buildWorkingState
 * runs, and asserts the spec's two guarantees:
 *  1. The seed block carries exact file paths, decisions, the open task, and verbatim intent.
 *  2. Append-only: round-1 decisions/files still present after round-2.
 *
 * Run:  node --import tsx --test scripts/tests/compaction.test.ts
 */
import assert from "node:assert";

import { _internals } from "../../src/session/compaction";

const { recentUserIntent, parseExtraction, mergeDecisions, mergeFiles, renderBlock } = _internals;

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("working-state compaction — forced rollover");

// --- parseExtraction: tolerate prose/fences around the JSON ---
check("parseExtraction pulls JSON out of noisy model output", () => {
  const out = parseExtraction(
    'sure! here you go:\n```json\n{"openTask":"build compaction","nextStep":"wire it in",' +
      '"decisions":["use haiku for the pass"],"fileIndex":[{"path":"/repos/bot/src/compaction.ts","note":"new module"}]}\n```',
  );
  assert(out, "should parse");
  assert.equal(out!.openTask, "build compaction");
  assert.equal(out!.fileIndex[0].path, "/repos/bot/src/compaction.ts");
});

check("parseExtraction returns null on garbage", () => {
  assert.equal(parseExtraction("no json here"), null);
});

// --- recentUserIntent: verbatim user lines only, agent lines dropped ---
check("recentUserIntent keeps owner lines verbatim, drops fig lines", () => {
  const history = [
    "[14:01] owner: do a and read what i was talking about",
    "[14:04] fig: done, it's live",
    "[15:00] owner: yo i think we're close to demo screenshots",
  ].join("\n");
  const intent = recentUserIntent(history);
  assert(intent.includes("[14:01] owner: do a and read"), "keeps first user line verbatim");
  assert(intent.includes("[15:00] owner: yo i think we're close"), "keeps later user line");
  assert(!intent.includes("fig:"), "drops agent lines");
});

// --- Simulated ROUND 1 rollover ---
// What the extractor pulls from the dying session's transcript.
const round1 = parseExtraction(
  JSON.stringify({
    openTask: "build pack-our-own-bags compaction",
    nextStep: "run typecheck",
    decisions: [
      "build our own summary, not anthropic server-side — it drops file paths",
      "keep the existing hard-roll; only improve the seed content",
    ],
    fileIndex: [
      { path: "/repos/bot/src/compaction.ts", note: "new module" },
      { path: "/repos/other-project", note: "the other project's code lives here, NOT this repo" },
    ],
  }),
)!;

let decisions = mergeDecisions([], round1.decisions);
let files = mergeFiles([], round1.fileIndex);

// --- Simulated ROUND 2 rollover --- new findings, plus the extractor re-reports one old one.
const round2 = parseExtraction(
  JSON.stringify({
    openTask: "verify append-only behavior",
    nextStep: "write the test",
    decisions: [
      "gate behind SESSION_WORKING_STATE, default OFF",
      "build our own summary, not anthropic server-side — it drops file paths", // duplicate of round 1
    ],
    fileIndex: [
      { path: "/repos/bot/src/session.ts", note: "wired the seed in runTurn" },
      { path: "/repos/bot/src/compaction.ts", note: "added _internals export" }, // refreshed note
    ],
  }),
)!;

decisions = mergeDecisions(decisions, round2.decisions);
files = mergeFiles(files, round2.fileIndex);

check("append-only: round-1 decisions survive round-2", () => {
  assert(decisions.some((d) => d.includes("keep the existing hard-roll")), "round-1 decision retained");
  assert(decisions.some((d) => d.includes("gate behind SESSION_WORKING_STATE")), "round-2 decision added");
});

check("decisions dedupe (the re-reported one isn't doubled)", () => {
  const hits = decisions.filter((d) => d.includes("not anthropic server-side")).length;
  assert.equal(hits, 1, `expected 1, got ${hits}`);
});

check("append-only: round-1 file paths (incl. an out-of-repo one) survive round-2", () => {
  const paths = files.map((f) => f.path);
  assert(paths.includes("/repos/other-project"), "out-of-repo path retained");
  assert(paths.includes("/repos/bot/src/session.ts"), "round-2 path added");
});

check("file index merges by path (compaction.ts not duplicated, note refreshed)", () => {
  const comp = files.filter((f) => f.path === "/repos/bot/src/compaction.ts");
  assert.equal(comp.length, 1, "single entry per path");
  assert.equal(comp[0].note, "added _internals export", "note refreshed to the newer one");
});

// --- Render the final seed block ---
const block = renderBlock(
  {
    updatedAt: 0,
    rollovers: 2,
    openTask: round2.openTask,
    nextStep: round2.nextStep,
    decisions,
    fileIndex: files,
  },
  recentUserIntent("[15:00] owner: verify the append-only behavior please"),
)!;

check("rendered block carries task, decisions, exact paths, and verbatim intent", () => {
  assert(block.includes("OPEN TASK: verify append-only behavior"), "open task");
  assert(block.includes("- keep the existing hard-roll"), "a decision");
  assert(block.includes("/repos/other-project — the other project's code lives here"), "exact path + note");
  assert(block.includes("[15:00] owner: verify the append-only behavior please"), "verbatim intent");
});

console.log(`\n${passed} checks passed ✅`);
