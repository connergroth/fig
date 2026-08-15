import assert from "node:assert/strict";

import { buildCodexPrompt, codexAddDirArgs, deliverCodexLiveResult } from "./codex";
import { buildCodexMainInstructions } from "../session/agent";
import { config } from "../core/config";
import { codexLiveRuntimeSelection, codexRuntimeSelection } from "./registry";

const delegated = buildCodexPrompt("fix the bug", "code", "delegated");
assert.match(delegated, /delegated Codex coding specialist/);
assert.match(delegated, /\nTask:\nfix the bug$/);

const main = buildCodexPrompt("what's up?", "code", "main");
assert.doesNotMatch(main, /delegated Codex/);
assert.doesNotMatch(main, /requested repo\/code work/);
assert.match(main, /\nCurrent message:\nwhat's up\?$/);

const mainInstructions = buildCodexMainInstructions();
assert.match(mainInstructions, /personal agent/);
assert.match(mainInstructions, /how you work:/);
assert.doesNotMatch(mainInstructions, /delegated Codex coding specialist/);

// Sandbox grants: main fig on Codex works out of the vault but MUST still be able to edit its
// own runtime. Regression for the self-lock where cwd=vault meant the bot repo was read-only.
const mainDirs = codexAddDirArgs(config.brainDir, "code", "main");
assert.ok(mainDirs.includes(config.repoRoot), "main codex must get the bot repo as a writable dir");
assert.ok(!mainDirs.includes(config.brainDir), "the working root is already writable, don't re-add it");
assert.equal(mainDirs.filter((a) => a === "--add-dir").length, mainDirs.length / 2);

// Same guarantee via the selection the /model codex path actually uses.
for (const selection of [codexRuntimeSelection(), codexLiveRuntimeSelection()]) {
  const opts = selection.providerOptions as { cwd?: string; addDirs?: string[]; role?: string };
  assert.equal(opts.cwd, config.brainDir);
  assert.equal(opts.role, "main");
  assert.ok(opts.addDirs?.includes(config.repoRoot), "codex selection must grant bot-repo write");
}

// Delegated runs stay scoped to their own repo, and review runs get nothing writable at all.
assert.deepEqual(codexAddDirArgs(config.repoRoot, "code", "delegated"), []);
assert.deepEqual(codexAddDirArgs(config.brainDir, "review", "main"), []);

// A bare Stop aborts the child. That is control flow, not a failed empty turn: it must not emit
// "codex fallback didn't return anything" or become the session's "no reply generated" warning.
void (async () => {
  const stopped = new AbortController();
  stopped.abort();
  const stopEmits: string[] = [];
  const stopResult = await deliverCodexLiveResult(
    { text: "Codex delegation cancelled.", ok: false },
    stopped.signal,
    async (text) => {
      stopEmits.push(text);
    },
  );
  assert.deepEqual(stopResult, { ok: false, aborted: true });
  assert.deepEqual(stopEmits, []);

  console.log("codex runtime role tests passed");
})();
