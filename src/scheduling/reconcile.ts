import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../core/config";
import { readJson, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";
import { OUTPUT_CONTRACT, isQuietSentinel } from "../render/chunking";
import type { Transport } from "../transport";
import { deliver, runAgentPassResult } from "./scheduler";
import { skillProcedureBlock } from "./skillBody";

/**
 * Periodic reconcile loop — fig's follow-through safety net.
 *
 * The failure it exists to catch: fig SAYS it did something ("scheduled the poll",
 * "saved that to Feedback") but the actual side effect never landed — a task never
 * armed, a file never written, a loop never logged. The words are in the transcript;
 * the mechanism isn't. A capture-only memory review (à la Hermes) wouldn't notice.
 * This does: every N real user turns it fires a background pass that reads the recent
 * conversation, diffs stated intent against what's actually on disk, and fixes the
 * drift — then surfaces one short line so the owner can see it working.
 *
 * Turn-based (not clock-based) on purpose: it should run when work actually happened,
 * not tick into dead air overnight. Fire-and-forget — it never blocks a user turn.
 */

const FILE = path.join(config.stateDir, "reconcile-counter.json");
const EVERY_TURNS = Math.max(1, Number(process.env.RECONCILE_EVERY_TURNS || 20));

/**
 * Fig's REAL tool calls — not what it said, what it actually did. The text transcript
 * (Conversations/) only holds the messages either side saw; a claim like "scheduled the
 * poll" leaves no trace there of whether the scheduled_tasks tool ever fired. But the
 * Claude Agent SDK writes the full turn stream — every tool_use block — to per-session
 * .jsonl files under ~/.claude/projects/<encoded-cwd>/. This pulls the recent ones into a
 * compact digest so the reconcile pass can check "did I claim a write/schedule that has no
 * matching tool call?" instead of only guessing from disk state.
 */

// Pure-read / no-op tools that never leave a side effect worth reconciling — drop them so
// the digest stays about actions fig took, not what it looked at.
const NOISE_TOOLS = new Set([
  "Read", "Glob", "Grep", "ToolSearch", "WebSearch", "WebFetch", "TodoWrite",
  "mcp__ack__ack", "mcp__jobs__check", "mcp__jobs__list", "mcp__fetch__fetch_url",
  "mcp__scheduled_tasks__list", "mcp__reminders__list",
]);

// Claude Code encodes a session's cwd into its projects/ folder name by swapping every
// "/" and "." for "-" (e.g. /Users/you/GitHub/vault → -Users-you-GitHub-vault).
function claudeProjectDir(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // The most identifying field, in rough priority — a path for writes, the command for
  // Bash, the target for schedule/skill calls. Falls back to a compact JSON dump.
  const key = ["file_path", "path", "command", "prompt", "text", "skill", "when", "id", "query"]
    .find((k) => typeof obj[k] === "string");
  let s = key ? String(obj[key]) : JSON.stringify(obj);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 180 ? `${s.slice(0, 180)}…` : s;
}

/**
 * A compact, chronological digest of fig's recent effectful tool calls, read straight from
 * the SDK session transcripts. Bounded by a time window (only files touched inside it are
 * read) and a max count so the prompt stays lean. Empty string if the transcripts can't be
 * read — the pass just falls back to disk-only verification, same as before.
 */
export function recentToolCalls(windowMs = 6 * 3_600_000, max = 80): string {
  const dir = claudeProjectDir(config.brainDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return "";
  }
  const cutoff = Date.now() - windowMs;
  const calls: { ts: number; name: string; summary: string }[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) continue; // skip files untouched this window
    } catch {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const ln of text.split("\n")) {
      if (!ln.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      if (o?.type !== "assistant" || o?.isSidechain === true) continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (Number.isFinite(ts) && ts < cutoff) continue;
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use" && typeof b.name === "string" && !NOISE_TOOLS.has(b.name)) {
          calls.push({ ts: Number.isFinite(ts) ? ts : 0, name: b.name, summary: summarizeToolInput(b.input) });
        }
      }
    }
  }
  if (!calls.length) return "";
  calls.sort((a, b) => a.ts - b.ts);
  return calls
    .slice(-max)
    .map((c) => `- ${c.name}${c.summary ? ` — ${c.summary}` : ""}`)
    .join("\n");
}

interface Counter {
  count: number;
}

const loadCount = (): number => readJson<Counter>(FILE, { count: 0 }).count;
const saveCount = (count: number): void => writeJson(FILE, { count });

let running = false;

/**
 * Count one completed user turn. Every EVERY_TURNS turns, fire a reconcile pass in
 * the background and deliver its line (if it caught anything). Call this ONLY for
 * genuine user-initiated turns — background injections and the reconcile pass itself
 * must not count, or the window drifts.
 */
export function noteTurnAndMaybeReconcile(transport: Transport, owner: string): void {
  const n = loadCount() + 1;
  if (n < EVERY_TURNS) {
    saveCount(n);
    return;
  }
  // Reset the window now, regardless of what the pass finds — a run consumes the window
  // even if nothing was out of place, so we don't re-fire every turn after the threshold.
  saveCount(0);
  if (running) return; // never overlap two passes
  running = true;
  void runReconcilePass(transport, owner).finally(() => {
    running = false;
  });
}

function buildReconcilePrompt(): string {
  const toolCalls = recentToolCalls();
  const toolBlock = toolCalls
    ? `\nHere are your REAL recent tool calls, pulled straight from the session transcripts — this is what you ACTUALLY did, not what you said. Use it as ground truth: if you claimed a write/schedule/save but there's no matching tool call here, the side effect never happened.\n${toolCalls}\n`
    : "";
  // The reconcile procedure is INLINED, not invoked. `reconcile` is `internal: true`, so
  // skillOverrides hides it from the skill listing and blocks model invocation — and the
  // summary below is deliberately NOT a substitute for the skill body, which carries steps
  // that live nowhere else. A throw here propagates to runReconcilePass, which
  // logs it and skips the pass — better than a reconcile that reconciles half of itself.
  const procedure = skillProcedureBlock("reconcile");
  return `It's time for your periodic reconcile pass — it fires every ~${EVERY_TURNS} real turns of conversation. Run it now, following the procedure below.

${procedure}

The job: audit the recent conversation against what actually landed on disk, and FIX any follow-through gap where you SAID you did something but the real side effect never happened. Things to catch:
- you said you'd schedule / poll / watch / remind about something, but it's not armed in scheduled-tasks.json or watches.json → arm it now
- you said you saved something (to People/System/Feedback/Wiki/a note), but the file/edit never landed → write it now
- a new open loop came up that has no line in Pending.md / Lists/Todos.md / Tasks.md → add the line
- a correction the owner gave that never made it to System/Feedback/ → log it
- something filed to the wrong spot per Memory.md → move it
- LIST BLOAT — run this first, it is a measurement, not a judgment call:
  \`python3 .claude/skills/vault-lint/scripts/list-bloat.py .\` (from the vault).
  It prints the real per-turn cost of the "## Open" sections of Pending.md, Lists/Todos.md
  and Tasks.md — the regions injected into every single turn verbatim — and names each
  offender. Fix what it lists: an over-budget item gets compressed to a one-liner (what /
  status / next step / clear-condition) with the detail moved to a pointer file
  (Pending/<slug>.md or Tasks/<slug>.md, same pattern as the Finance.md and Projects/*/*.md
  pointers already in use); a tombstone sitting inside "## Open" moves under "## Done" or the
  cleared log; how-to-use prose moves above the heading. Never delete one of the owner's own
  Todos to hit a budget — compress it or move detail out, the items are theirs.
- a Pending.md/Tasks.md "## Open" line is actually done, resolved, or stale (the blocker
  cleared, the date passed with no update since, the owner mentioned it's handled, or nothing's
  moved on it in a long time with no reason it'd still be live) → DELETE it. Read the
  recent transcripts under Conversations/ before deleting anything non-obvious — the point
  is to catch lines that quietly went stale and nobody noticed, not to guess things closed
  that are still live. This list only stays useful if dead weight actually gets removed, not
  just compressed.
${toolBlock}
Fix the clear-cut ones yourself. Only leave a gap unfixed if the intent or the right fix is genuinely ambiguous — never guess an action into existence. If you're unsure what was actually discussed or meant, read the earlier transcripts under Conversations/ before deciding — don't flag drift you haven't confirmed.

When you're done, deliver the owner's line by wrapping the EXACT text they should see in <output></output> tags. ONLY what's inside the tags is sent — narrate freely outside them. If you fixed or caught anything, tell them in ONE short line, straight to them, lowercase, no preamble, LED WITH the 💾 emoji — e.g.:
<output>
💾 reconciled: re-armed the snapchat poll that never actually got scheduled
</output>
If you fixed more than one thing, list them on dashed lines inside the one output block (still lead the block with 💾).

If everything you said you'd do was actually done and nothing was out of place, output exactly: NOTHING (with no <output> tags).`;
}

async function runReconcilePass(transport: Transport, owner: string): Promise<void> {
  try {
    const { text, ok } = await runAgentPassResult(buildReconcilePrompt(), "reconcile", OUTPUT_CONTRACT.quiet);
    if (ok && text && !isQuietSentinel(text)) {
      await deliver(transport, owner, text);
    }
  } catch (e) {
    warn(`reconcile pass failed: ${e}`);
  }
}
