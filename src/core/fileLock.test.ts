import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// isHotFile resolves against config.brainDir, so pin a temp brain BEFORE config loads.
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-filelock-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type FileLock = typeof import("./fileLock");

let mod: FileLock;

const inBrain = (...parts: string[]) => path.join(TMP_BRAIN, ...parts);

/**
 * The vault restructure folded the old top-level Nutrition/ under Health/. The lock has
 * to still cover the food log through the Health/ dir alone, or two lanes clobber the
 * same day-file with nothing anywhere saying why.
 */
function healthTreeIsHot(): void {
  assert.equal(mod.isHotFile(inBrain("Health", "nutrition", "2026-08", "2026-08-05.md")), true);
  assert.equal(mod.isHotFile(inBrain("Health", "sleep", "2026-08", "2026-08-05.md")), true);
  assert.equal(mod.isHotFile(inBrain("Health", "Body Composition.md")), true);
  assert.equal(mod.isHotFile(inBrain("Health")), true);
}

/** The three open-loop lists every skill keeps fresh. */
function openLoopListsAreHot(): void {
  assert.equal(mod.isHotFile(inBrain("Pending.md")), true);
  assert.equal(mod.isHotFile(inBrain("Tasks.md")), true);
  assert.equal(mod.isHotFile(inBrain("Lists", "Todos.md")), true);
}

/** Over-locking is a real cost too — the hot set stays narrow. */
function everythingElseIsCold(): void {
  assert.equal(mod.isHotFile(inBrain("Daily", "2026-08", "2026-08-05.md")), false);
  assert.equal(mod.isHotFile(inBrain("People", "cody.md")), false);
  // A sibling whose name merely starts with "Health" must not be swept in.
  assert.equal(mod.isHotFile(inBrain("Healthcare.md")), false);
}

async function main(): Promise<void> {
  mod = await import("./fileLock");
  try {
    healthTreeIsHot();
    openLoopListsAreHot();
    everythingElseIsCold();
    console.log("core/fileLock.test.ts: 3 passed");
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
