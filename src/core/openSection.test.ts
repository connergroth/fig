import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { config } from "./config";
import { readOpenBullets, readOpenSection, stripHtmlComments } from "./openSection";

/** Write a list file into a temp brainDir and point config at it for the duration. */
function withList(name: string, body: string, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensection-"));
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  const original = config.brainDir;
  (config as { brainDir: string }).brainDir = dir;
  try {
    fn();
  } finally {
    (config as { brainDir: string }).brainDir = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("strips multi-line comment blocks, not just single-line ones", () => {
  const out = stripHtmlComments("keep\n<!-- one liner -->\n<!-- line one\n   line two\n   line three -->\nalso keep");
  assert.equal(out.includes("line two"), false);
  assert.equal(out.includes("one liner"), false);
  assert.match(out, /keep/);
  assert.match(out, /also keep/);
});

// The regression that motivated this module: tombstones are ALWAYS multi-line in practice,
// and the old single-line filter injected every one of them into every turn forever.
test("a multi-line tombstone under ## Open is never injected", () => {
  const body = [
    "# Todos",
    "",
    "## Open",
    "",
    "Prose explaining how to use this list, which is taught in the harness already.",
    "",
    "<!-- 2026-08-08: killed at the owner's word — the unused flight booking.",
    "     Durable so it isn't re-litigated: the fare is non-refundable and",
    "     cancelling would only return budget to the employer. -->",
    "",
    "- [ ] a real live todo",
    "",
    "## Done",
    "",
    "- [x] archived thing nobody should see",
  ].join("\n");
  withList("Lists/Todos.md", body, () => {
    const out = readOpenSection("Lists/Todos.md");
    assert.equal(out, "- [ ] a real live todo");
    assert.equal(out.includes("non-refundable"), false);
    assert.equal(out.includes("Prose explaining"), false);
    assert.equal(out.includes("archived thing"), false);
  });
});

test("subheadings survive and preamble above them is dropped", () => {
  const body = "## Open\n\nintro prose\n\n### Dated\n\n- a thing\n\n## Parked\n\n- parked thing";
  withList("Pending.md", body, () => {
    assert.equal(readOpenSection("Pending.md"), "### Dated\n\n- a thing");
  });
});

// Guard the drop-the-preamble rule against eating a section that is only prose.
test("a prose-only Open section is passed through rather than vanishing", () => {
  withList("Tasks.md", "## Open\n\njust a sentence, no bullets\n", () => {
    assert.equal(readOpenSection("Tasks.md"), "just a sentence, no bullets");
  });
});

test("empty markers and missing files return empty", () => {
  withList("Pending.md", "## Open\n\n- (none)\n", () => {
    assert.equal(readOpenSection("Pending.md"), "");
    assert.equal(readOpenSection("Nope.md"), "");
  });
});

test("bullet view keeps top-level bullets and marks truncation", () => {
  const body = `## Open\n\n### Dated\n\n- alpha\n  continuation detail\n- ${"b".repeat(200)}\n`;
  withList("Pending.md", body, () => {
    const out = readOpenBullets("Pending.md", 60);
    assert.match(out, /^- alpha/);
    assert.equal(out.includes("continuation detail"), false);
    assert.match(out, /ask_fig for the rest/);
  });
});
