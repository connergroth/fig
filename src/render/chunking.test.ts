import assert from "node:assert/strict";
import { parsePoll, splitIntoChunks, stripMarkdown } from "./chunking";

/**
 * Regression: the em-dash -> hyphen safety net used `\s*—\s*`, and `\s` includes `\n`.
 * An em-dash ending a lead-in line therefore ate the newline and pulled the next line up,
 * so a bullet list rendered as "...told me - - amazon.com, ...". Horizontal whitespace only.
 */
function emDashNeverEatsNewlines(): void {
  const out = stripMarkdown("what you told me —\n- amazon.com, protector only\n- go");
  assert.equal(out, "what you told me -\n- amazon.com, protector only\n- go");
  assert.ok(!out.includes("- - "), "em-dash swap must not merge a bullet onto the lead-in line");
}

/** A line that STARTS with an em-dash becomes a bullet, keeping its own line and indent. */
function lineStartDashBecomesBullet(): void {
  assert.equal(stripMarkdown("here:\n— one\n— two"), "here:\n- one\n- two");
  assert.equal(stripMarkdown("here:\n  — one"), "here:\n  - one");
}

/** Mid-line em-dashes still become a spaced hyphen, and never gain stray whitespace. */
function midLineDashStillSwaps(): void {
  assert.equal(stripMarkdown("a — b"), "a - b");
  assert.equal(stripMarkdown("a—b"), "a - b");
  assert.equal(stripMarkdown("a — b — c"), "a - b - c");
}

/** Multi-line bodies keep every line break the model wrote. */
function newlineCountIsPreserved(): void {
  const src = "one —\ntwo — three\n\nfour";
  const out = stripMarkdown(src);
  assert.equal((out.match(/\n/g) ?? []).length, (src.match(/\n/g) ?? []).length);
  assert.equal(out, "one -\ntwo - three\n\nfour");
}

/**
 * Regression: a `[[poll:…]]` written at the END of a paragraph, with no `[[split]]`
 * in front of it, shipped as literal token text — delivery only fires a native poll when a
 * chunk is JUST the token. It has to be lifted onto its own chunk wherever it was written.
 */
function inlinePollTokenGetsItsOwnChunk(): void {
  const out = splitIntoChunks(
    "pick one and i'll wrap it as a real tool. [[poll: which voice | michael | george | heart]]",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0], "pick one and i'll wrap it as a real tool.");
  assert.ok(parsePoll(out[1]), "the lifted chunk must parse as a poll");
}

/** Prose on BOTH sides survives as its own bubbles, and the poll stays in the middle. */
function prosePollProseKeepsAllThree(): void {
  const out = splitIntoChunks("before text [[poll: q | a | b]] after text");
  assert.deepEqual(out, ["before text", "[[poll: q | a | b]]", "after text"]);
  assert.ok(parsePoll(out[1]));
}

/** A token already alone (its own line / after a [[split]]) is unchanged — no double-lift. */
function alreadyIsolatedPollIsUnchanged(): void {
  const out = splitIntoChunks("setup line\n[[split]]\n[[poll: q | a | b]]");
  assert.deepEqual(out, ["setup line", "[[poll: q | a | b]]"]);
}

/** Malformed (< 2 options) → left embedded exactly as written, never a bubble of its own. */
function malformedPollStaysInline(): void {
  assert.deepEqual(splitIntoChunks("hey [[poll: only a question]] there"), [
    "hey [[poll: only a question]] there",
  ]);
}

function main(): void {
  emDashNeverEatsNewlines();
  lineStartDashBecomesBullet();
  midLineDashStillSwaps();
  newlineCountIsPreserved();
  inlinePollTokenGetsItsOwnChunk();
  prosePollProseKeepsAllThree();
  alreadyIsolatedPollIsUnchanged();
  malformedPollStaysInline();
  console.log("chunking.test.ts: 8 passed");
}

main();
