import assert from "node:assert/strict";
import { parsePoll, splitIntoChunks, stripMarkdown } from "./chunking";

/**
 * stripMarkdown removes only syntax the surface cannot render. It must never touch WORDING:
 * em-dashes, capitalization and the model's own punctuation ship exactly as written, because
 * style is the persona file's job and a transport-layer rewrite silently overrides it.
 */
function stripsSyntaxNeverStyle(): void {
  assert.equal(stripMarkdown("**bold** and `code`"), "bold and code");
  assert.equal(stripMarkdown("[docs](https://example.com)"), "https://example.com");
  assert.equal(stripMarkdown("a — b"), "a — b", "em-dash survives");
  assert.equal(stripMarkdown("Let me dig in. It's fine."), "Let me dig in. It's fine.");
  const src = "one —\ntwo — three\n\nfour";
  assert.equal(stripMarkdown(src), src, "line breaks and dashes both untouched");
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
  stripsSyntaxNeverStyle();
  inlinePollTokenGetsItsOwnChunk();
  prosePollProseKeepsAllThree();
  alreadyIsolatedPollIsUnchanged();
  malformedPollStaysInline();
  console.log("chunking.test.ts: 5 passed");
}

main();
