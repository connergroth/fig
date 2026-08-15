/**
 * Hook tests. Deterministic, no SDK, no network.
 *
 * Run:  npx tsx src/runtimes/hooks.test.ts
 *
 * The thing under test is a boundary, so it's tested from BOTH sides: a rule that only
 * ever gets asserted on its allow cases is how a guard ends up quietly denying real work
 * (or quietly allowing the thing it was written to stop).
 */
import assert from "node:assert/strict";
import os from "node:os";

import { deniesAsConversationSearch, SURFACE_HOOKS } from "./hooks";

/** A realistic absolute vault path, without pinning the test to one machine's home dir. */
const VAULT = `${os.homedir()}/GitHub/vault`;

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

const denies = (tool: string, input: Record<string, unknown>) => deniesAsConversationSearch(tool, input);

console.log("\nconversation-search redirect — DENIES searching:");

check("Grep with path at the log", () => {
  assert.equal(denies("Grep", { pattern: "coffee", path: "Conversations" }), true);
  assert.equal(denies("Grep", { pattern: "coffee", path: `${VAULT}/Conversations/2026-07` }), true);
});

check("Grep scoped by glob instead of path", () => {
  assert.equal(denies("Grep", { pattern: "rooftop", glob: "Conversations/**/*.md" }), true);
});

check("shell search binaries pointed at the log", () => {
  for (const cmd of [
    'grep -rn "coffee" Conversations/',
    "rg rooftop Conversations",
    "grep -ri supabase ./Conversations/2026-07",
    "grep -n dave Conversations/2026-07/*.md",
    "find Conversations -name '*.md' | xargs grep coffee",
  ]) {
    assert.equal(denies("Bash", { command: cmd }), true, cmd);
  }
});

check("cd'ing into the log doesn't launder a whole-log sweep", () => {
  for (const cmd of [
    "cd ~/GitHub/vault/Conversations && grep -rn coffee .",
    `cd ${VAULT}/Conversations/2026-07 && grep -n dave *.md`,
  ]) {
    assert.equal(denies("Bash", { command: cmd }), true, cmd);
  }
});

console.log("\n— and ALLOWS reading:");

check("Read is never touched", () => {
  assert.equal(denies("Read", { file_path: `${VAULT}/Conversations/2026-07/2026-07-28.md` }), false);
});

check("whole-file shell reads — what the nightly skills actually do", () => {
  for (const cmd of [
    "cat Conversations/2026-07/2026-07-28.md",
    "tail -50 Conversations/2026-07/2026-07-28.md",
    "wc -l Conversations/2026-07/*.md",
    "ls Conversations/2026-07",
  ]) {
    assert.equal(denies("Bash", { command: cmd }), false, cmd);
  }
});

check("Glob enumeration still works (dream walks the week's files)", () => {
  assert.equal(denies("Glob", { pattern: "Conversations/*/*.md" }), false);
});

check("a search bounded to ONE named transcript is a read, not a sweep", () => {
  // Both of these were denied by the string-matching version. Bounding a grep to a single
  // day costs the same as `cat`-ing that day, which is already allowed two checks up — and
  // the redirect message itself promises that reading a specific transcript still works.
  for (const cmd of [
    "grep -c dave ~/GitHub/vault/Conversations/2026-07/2026-07-22.md",
    `cd ${VAULT}/Conversations/2026-07 && grep -n "07:0" 2026-07-28.md`,
  ]) {
    assert.equal(denies("Bash", { command: cmd }), false, cmd);
  }
});

check("grepping OTHER trees for the literal string is not a log search", () => {
  // This exact command was run while wiring the redirect. If the rule caught it, the
  // rule would block the work of maintaining the rule.
  assert.equal(denies("Bash", { command: 'grep -rn "Conversations/" src --include="*.ts"' }), false);
  assert.equal(denies("Bash", { command: "grep -rln 'Conversations/' .claude/skills/" }), false);
});

check("ordinary greps elsewhere are untouched", () => {
  assert.equal(denies("Bash", { command: "grep -rn embed_model src/memory" }), false);
  assert.equal(denies("Grep", { pattern: "peekaboo", path: "src/scheduling" }), false);
});

console.log("\nhook wiring:");

check("the PreToolUse matcher only claims Grep and Bash", () => {
  const pre = SURFACE_HOOKS.PreToolUse;
  assert(pre && pre.length === 1);
  assert.equal(pre[0].matcher, "Grep|Bash");
});

check("PostToolUse surface notes survived the addition", () => {
  const post = SURFACE_HOOKS.PostToolUse;
  assert(post && post.length === 1);
  assert.equal(post[0].matcher, "WebSearch|WebFetch");
});

// Exercises the actual hook callback the SDK will invoke, not just the predicate.
const hook = SURFACE_HOOKS.PreToolUse![0].hooks[0] as (
  i: unknown,
  b: undefined,
  o: unknown,
) => Promise<Record<string, unknown>>;
const call = (tool: string, input: Record<string, unknown>) =>
  hook({ tool_name: tool, tool_input: input }, undefined, {});

async function main(): Promise<void> {
  const denied = await call("Grep", { pattern: "x", path: "Conversations" });
  check("a matching call returns a real deny that names the alternative", () => {
    const out = denied.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
    assert.equal(out?.permissionDecision, "deny");
    assert(
      /recall_conversations/.test(out?.permissionDecisionReason ?? ""),
      "the denial names the tool to use instead — a deny with no route is just a wall",
    );
  });

  const allowed = await call("Read", { file_path: "Conversations/2026-07/2026-07-28.md" });
  check("a non-matching call returns no decision at all", () => {
    assert.deepEqual(allowed, {}, "so the normal permission flow continues untouched");
  });

  const malformed = await call("Bash", {});
  check("a malformed tool_input doesn't throw (a hook that throws kills the turn)", () => {
    assert.deepEqual(malformed, {});
  });

  console.log(`\n${passed} checks passed ✅\n`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
