import assert from "node:assert/strict";

import { buildDelegatePrompt, delegateWorkflow } from "./delegate";
import { buildCodexPrompt } from "../runtimes/codex";

// The workflow is the whole point: every delegated coding run walks the same steps, so
// consistency stops depending on how carefully THAT request happened to be worded.
const code = delegateWorkflow("code");
for (const step of ["ORIENT", "CHANGE", "TEST", "GREEN", "COMMIT", "REPORT"]) {
  assert.ok(
    code.some((line) => line.includes(step)),
    `code workflow is missing the ${step} step`,
  );
}

// The two failures this exists to prevent, asserted by name so a future trim can't
// quietly drop them: a job that leaves the tree broken, and a job that pushes.
const codeText = code.join("\n");
assert.match(codeText, /do NOT report success/);
assert.match(codeText, /never `git push`/);

// Review is read-only — it must NOT be told to change, commit, or push anything.
const review = delegateWorkflow("review").join("\n");
assert.match(review, /ORIENT/);
assert.doesNotMatch(review, /COMMIT/);
assert.doesNotMatch(review, /git push/);

// Both ENGINES get the identical steps. A workflow that reached only the Claude lane
// would make the same task behave differently depending on which engine picked it up.
const claude = buildDelegatePrompt("fix the bug", ["role line"], "code");
const codex = buildCodexPrompt("fix the bug", "code", "delegated");
for (const step of code) {
  assert.ok(claude.includes(step), "claude delegate prompt is missing a workflow step");
  assert.ok(codex.includes(step), "codex delegate prompt is missing a workflow step");
}

// Mode is respected on both engines.
assert.ok(!buildDelegatePrompt("look", ["r"], "review").includes("COMMIT"));
assert.ok(!buildCodexPrompt("look", "review", "delegated").includes("COMMIT"));

// The task still lands last, after the workflow — the steps are framing, not the ask.
assert.match(claude, /\nTask:\nfix the bug$/);

// fig's MAIN brain on Codex is not a delegated coding job; it must never inherit the
// commit-and-report loop (it has its own operating instructions).
assert.ok(!buildCodexPrompt("what's up?", "code", "main").includes("ORIENT"));
