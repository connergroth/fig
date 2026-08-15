import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMessagePreamble,
  buildStaticSystemPrompt,
  dynamicSegments,
  joinSegments,
  staticSegments,
} from "../session/agent";
import {
  buildContextReport,
  estimateTokens,
  measureSkillListing,
  summarizeContextReport,
  SKILL_LISTING_CONTEXT_TOKENS,
  type ContextBlock,
} from "./contextReport";

/**
 * The context accounting, and the one guarantee that keeps it honest.
 *
 * THE POINT OF THE FIRST TWO CHECKS. The report measures the system prompt from the LABELLED
 * SEGMENTS, not from the prompt string — so the only way it can be wrong is if the prompt stops
 * being exactly those segments. That's the drift these two assert away: add a part to the
 * prompt without giving it a label and the join stops matching byte-for-byte, which fails here
 * rather than silently going unmeasured (an unlabelled block reads as zero, which is precisely
 * the lie the whole report exists to stop telling).
 *
 * Everything else here is the never-throw contract. `/prompt` is a zero-token command; a
 * missing vault file or a malformed settings.json must degrade to a labelled row, never take
 * out a turn.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

function flatten(blocks: readonly ContextBlock[]): ContextBlock[] {
  return blocks.flatMap((b) => [b, ...flatten(b.children ?? [])]);
}

async function main(): Promise<void> {
  console.log("prompt segments: the labels ARE the composition");

  await check("staticSegments() joined is byte-for-byte buildStaticSystemPrompt()", () => {
    assert.equal(joinSegments(staticSegments()), buildStaticSystemPrompt());
    // And the labels are real — a segment with an empty label would measure as an anonymous row.
    for (const s of staticSegments()) assert.ok(s.label.trim().length > 0, "a static segment has no label");
  });

  await check("dynamicSegments() joined is byte-for-byte buildMessagePreamble()", () => {
    assert.equal(joinSegments(dynamicSegments()), buildMessagePreamble());
    for (const s of dynamicSegments()) assert.ok(s.label.trim().length > 0, "a dynamic segment has no label");
  });

  await check("every segment's bytes land in the report (no unmeasured remainder inside our prompt)", () => {
    const promptChars = buildStaticSystemPrompt().length + buildMessagePreamble().length;
    const segmentChars = [...staticSegments(), ...dynamicSegments()].reduce((n, s) => n + s.text.length, 0);
    // The only difference between the two is the "\n\n" joins, which are structure, not content.
    const joins = staticSegments().length - 1 + (dynamicSegments().length - 1);
    assert.equal(promptChars, segmentChars + joins * 2);
  });

  console.log("\ncontext report");

  await check("the report builds, totals add up, and every block carries owner + basis", () => {
    const r = buildContextReport();
    assert.ok(r.blocks.length >= 6, `expected the six top-level blocks, got ${r.blocks.length}`);
    assert.equal(
      r.measuredChars,
      r.blocks.reduce((n, b) => n + b.chars, 0),
      "measuredChars must be the sum of the top-level blocks",
    );
    // The per-turn split is DERIVED from the same blocks as the total, so a new seed block
    // can't be counted in one and forgotten in the other.
    assert.equal(r.perTurnTokens + r.freshSessionOnlyTokens, r.measuredTokens);
    for (const b of flatten(r.blocks)) {
      assert.ok(["ours", "sdk"].includes(b.owner), `${b.name} has no owner`);
      assert.ok(["measured", "estimated", "unmeasurable"].includes(b.basis), `${b.name} has no basis`);
      assert.ok(b.name.trim().length > 0, "a block has no name");
      // A number without a basis to read it by is how "0" gets mistaken for "free".
      if (b.basis === "unmeasurable") assert.ok(b.note, `${b.name} is unmeasurable and must say why`);
    }
  });

  await check("a parent block's chars equal the sum of its children", () => {
    for (const b of flatten(buildContextReport().blocks)) {
      if (!b.children?.length) continue;
      assert.equal(b.chars, b.children.reduce((n, c) => n + c.chars, 0), `${b.name} doesn't equal its children`);
    }
  });

  await check("the anchor is the API's own number, or it says it doesn't have one", () => {
    const r = buildContextReport();
    if (r.live.tokens === null) {
      assert.ok(r.live.reason, "no anchor and no reason given");
      assert.equal(r.remainderTokens, null, "a remainder computed against a missing anchor is a fake number");
      assert.match(r.text, /UNKNOWN/);
    } else {
      assert.equal(r.remainderTokens, r.live.tokens - r.measuredTokens);
      assert.match(r.text, /live session total \(real, from the API\)/);
    }
  });

  await check("the rendered table is plain aligned text, not markdown", () => {
    const { text } = buildContextReport();
    const header = text.split("\n").find((l) => l.includes("chars") && l.includes("tokens"));
    assert.ok(header, "no table header");
    // It gets read in a plain viewer — a markdown table renders there as pipe soup.
    assert.ok(!header!.includes("|"), "the table header uses markdown pipes");
    assert.match(text, /LEGEND/);
    assert.match(text, /unmeasurable/);
    assert.match(text, /THE FULL PROMPT TEXT FOLLOWS BELOW/);
  });

  await check("the iMessage summary stays short, lowercase and markdown-free", () => {
    const s = summarizeContextReport(buildContextReport());
    const lines = s.split("\n");
    assert.ok(lines.length <= 10, `summary is ${lines.length} lines, cap is 10`);
    assert.ok(!/[*#`_]|\[.*\]\(.*\)/.test(s), "summary contains markdown syntax");
    assert.equal(s, s.toLowerCase(), "summary must be lowercase");
  });

  console.log("\nskill listing budget");

  await check("measureSkillListing computes the CLI's own formula and hides internal skills", () => {
    const m = measureSkillListing();
    assert.equal(m.budgetChars, Math.floor(SKILL_LISTING_CONTEXT_TOKENS * 4 * m.fraction));
    assert.equal(m.headroomChars, m.budgetChars - m.chars);
    assert.equal(m.wouldTruncate, m.chars > m.budgetChars);
    assert.equal(m.chars, m.text.length);
    if (m.listed.length) {
      // The listing is what the model sees. An internal (automation) skill in it is budget
      // spent on something the owner never invokes, and the whole reason the list once collapsed.
      const names = new Set(m.listed.map((s) => s.name));
      for (const h of m.hidden) assert.ok(!names.has(h), `${h} is hidden AND listed`);
      for (const s of m.listed) assert.match(s.line, /^- [^:]+: /, `"${s.name}" renders without a description`);
    }
  });

  await check("the skill listing costs what it costs, and does not silently truncate", () => {
    const m = measureSkillListing();
    if (!m.listed.length) return console.log("    (skipped — no vault skills)");

    // A COST REPORT, not a size cap. Every skill is deliberate and loading it is the point, so
    // this check must never be the thing that says "no more skills" — the budget fraction is
    // set high enough that it cannot bind. What it exists to catch is the SILENT failure: over
    // budget, the CLI drops descriptions to bare names lowest-usage-first and only warns to a
    // debug log nobody reads, so skill selection quietly starts running on filenames. Print the
    // real cost every run so growth is visible, and fail only when it would actually truncate.
    const pct = Math.round((m.chars / m.budgetChars) * 100);
    const fattest = [...m.listed]
      .sort((a, b) => b.line.length - a.line.length)
      .slice(0, 3)
      .map((s) => `${s.name} ${s.line.length}`)
      .join(", ");
    console.log(
      `    ${m.listed.length} listed / ${m.hidden.length} hidden · ${m.chars.toLocaleString()} chars ` +
        `(~${m.tokens.toLocaleString()} tok) · ${pct}% of ${m.budgetChars.toLocaleString()} · fattest: ${fattest}`,
    );

    assert.ok(
      !m.wouldTruncate,
      `the skill listing is ${m.chars.toLocaleString()} chars against a ${m.budgetChars.toLocaleString()}-char ` +
        `budget, so the CLI is silently cutting descriptions to bare names. Do NOT fix this by deleting or ` +
        `trimming skills — raise skillListingBudgetFraction (currently ${m.fraction}) in .claude/settings.json. ` +
        `Trim a description only where it carries body content that belongs below the frontmatter.`,
    );
  });

  console.log("\nnever throws a turn");

  await check("a missing vault degrades to labelled rows instead of throwing", async () => {
    // BRAIN_DIR is read at module load by core/config, so point a CHILD process at an empty
    // dir — the only way to exercise the degrade path for real rather than by inspection.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxreport-"));
    const { execFileSync } = await import("node:child_process");
    const script = `
      const { buildContextReport } = require(${JSON.stringify(path.join(__dirname, "contextReport.ts"))});
      const r = buildContextReport();
      console.log(JSON.stringify({ blocks: r.blocks.length, text: r.text.length }));
    `;
    const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      env: { ...process.env, BRAIN_DIR: tmp },
      encoding: "utf8",
      cwd: path.join(__dirname, "..", ".."),
    });
    const parsed = JSON.parse(out.trim().split("\n").pop()!);
    assert.ok(parsed.blocks >= 6, "an empty vault should still produce every block, labelled");
    assert.ok(parsed.text > 0, "an empty vault should still render a report");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await check("estimateTokens is the ~chars/4 heuristic, rounded up", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abc"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  if (failures > 0) {
    console.error(`\n${failures} context-report check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${ran} context-report checks passed`);
}

void main();
