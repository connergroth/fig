import fs from "node:fs";
import path from "node:path";

import { SKILLS_DIR } from "../scheduling/skillBody";
import { inLane } from "../scheduling/lane";
import { renderPersistedWorkingState } from "../session/compaction";
import {
  dynamicSegments,
  loadProjectInstructions,
  readSessionRecord,
  staticSegments,
  SESSION_MAX_AGE_MS,
} from "../session/agent";
import { recentHistory } from "../session/transcript";
import { capabilitySchema, isPinned } from "../tools/define";
import { ALL_SERVERS, IN_PROCESS_SERVERS } from "../tools/registry";
import { config } from "./config";

/**
 * CONTEXT ACCOUNTING — what is actually in front of the model every turn.
 *
 * `/prompt` used to print `buildSystemPrompt()` and nothing else, and reported its size as if
 * that were the context. It isn't: the composed prompt is somewhere between a third and a half
 * of what's loaded. CLAUDE.md and its `@` imports arrive through the SDK's own
 * `settingSources: ["project"]` loader and never touch the prompt string; the skill listing is
 * injected separately and char-budgeted by the CLI; tool schemas are attached alongside the
 * prompt and are plausibly the single biggest block; a fresh session additionally carries the
 * working-state block and a replayed transcript tail.
 *
 * Three rules this module holds itself to, because a measurement that quietly guesses is worse
 * than no measurement:
 *
 *  1. DERIVED, NEVER RE-COMPOSED. The system-prompt numbers come from
 *     `staticSegments()`/`dynamicSegments()` in session/agent.ts — the same lists the real
 *     prompt is joined from — so this file cannot drift into measuring a prompt nobody is
 *     sent. A segment nobody labels fails `contextReport.test.ts` instead of silently going
 *     unmeasured. Same idea for the working-state block (rendered by compaction.ts's own
 *     renderer) and the tool surface (derived from the tool registry).
 *  2. EVERY NUMBER CARRIES ITS BASIS. `measured` = we counted the actual bytes. `estimated` =
 *     computed from a rule rather than the artifact. `unmeasurable` = it exists, it costs
 *     something real, and it cannot be counted from inside this process (SDK built-in tool
 *     descriptions, external mcp.json servers' tools). Those get a row with no number rather
 *     than being left out — an omitted block reads as zero, which is the lie this report
 *     exists to stop telling.
 *  3. THE ANCHOR IS THE API'S OWN NUMBER. Everything above is a char-count heuristic. The
 *     persisted session record carries `contextTokens`, the API's reported input total for the
 *     live session (input + cache_creation + cache_read). That's ground truth, and the
 *     difference between it and our measured sum is reported by SUBTRACTION and labelled as
 *     such — not silently attributed to anything.
 *
 * Nothing here may throw. Every block is computed under `block()`, which turns any failure into
 * a labelled `unavailable: <reason>` row — `/prompt` is a zero-token command the owner runs to
 * look at the machine, and it must not be the thing that breaks a turn.
 */

// --- Types ---

export type BlockOwner = "ours" | "sdk";
export type BlockBasis = "measured" | "estimated" | "unmeasurable";

export interface ContextBlock {
  name: string;
  chars: number;
  tokens: number;
  owner: BlockOwner;
  basis: BlockBasis;
  /**
   * True for a block a RESUMED turn does not re-pay — the fresh-session seed (working state,
   * replayed history). Kept as a flag rather than a separate list so the per-turn subtotal is
   * derived from the same blocks as the total, and a new seed block can't be forgotten.
   */
  freshSessionOnly?: boolean;
  note?: string;
  children?: ContextBlock[];
}

export interface LiveAnchor {
  /** The API's own input-token total for the most recent turn, or null when unknown. */
  tokens: number | null;
  updatedAt: number | null;
  /** Older than the session rollover window — the number describes a session that's gone. */
  stale: boolean;
  /** Why there's no number, when there isn't one. */
  reason?: string;
}

export interface ContextReport {
  blocks: ContextBlock[];
  /** Sum over blocks (and their children are already folded into the parent) we could measure. */
  measuredChars: number;
  measuredTokens: number;
  /** Of the measured total, what a RESUMED turn pays again. */
  perTurnTokens: number;
  /** Of the measured total, what only a fresh/rolled-over session pays. */
  freshSessionOnlyTokens: number;
  live: LiveAnchor;
  /** liveTokens - measuredTokens, or null when there's no anchor. */
  remainderTokens: number | null;
  /** The rendered plain-text report. */
  text: string;
}

// --- Token estimate (the ONE implementation) ---

/**
 * Approximate token count for a string. Anthropic's real tokenizer isn't reachable here (auth
 * is the Claude OAuth token, not an API key, and there's no local tokenizer dep), so this uses
 * the standard ~4-chars-per-token heuristic — well-calibrated for English/markdown/code and
 * plenty accurate for eyeballing how big a block is. Always rendered with a `~` so it reads as
 * an estimate. `core/prompt.ts` imports this rather than keeping its own copy.
 */
export function estimateTokens(s: string): number {
  return tokensForChars(s.length);
}

/** Same heuristic, for a total that was summed rather than concatenated. */
function tokensForChars(chars: number): number {
  return Math.ceil(chars / 4);
}

// --- Small helpers ---

function measured(name: string, text: string, owner: BlockOwner = "ours", note?: string): ContextBlock {
  return { name, chars: text.length, tokens: estimateTokens(text), owner, basis: "measured", note };
}

function unavailable(name: string, reason: string, owner: BlockOwner = "ours"): ContextBlock {
  return { name, chars: 0, tokens: 0, owner, basis: "unmeasurable", note: `unavailable: ${reason}` };
}

/** Run a block builder, degrading to an `unavailable:` row instead of throwing. */
function block(name: string, fn: () => ContextBlock): ContextBlock {
  try {
    return fn();
  } catch (e) {
    return unavailable(name, e instanceof Error ? e.message : String(e));
  }
}

function sumChars(blocks: ContextBlock[]): number {
  return blocks.reduce((n, b) => n + b.chars, 0);
}

// --- A. the composed system prompt ---

function systemPromptBlock(): ContextBlock {
  const statics = staticSegments().map((s) => measured(s.label, s.text));
  const dynamics = dynamicSegments().map((s) => measured(s.label, s.text));
  const children = [...statics, ...dynamics];
  const chars = sumChars(children);
  return {
    name: "system prompt (ours — what /prompt used to show)",
    chars,
    tokens: tokensForChars(chars),
    owner: "ours",
    basis: "measured",
    note:
      "static half is frozen at session start and prompt-cached; the dynamic half is rebuilt and re-sent every single turn",
    children,
  };
}

// --- B. project instructions (CLAUDE.md + its @imports) ---

// Shared with the Codex main-agent prompt so the report, Claude SDK project context, and
// provider-neutral Fig context all measure/load the same CLAUDE.md import tree.
function projectInstructionsBlock(): ContextBlock {
  const files = loadProjectInstructions();
  if (!files.length) return unavailable("project instructions (CLAUDE.md + @imports)", `no CLAUDE.md at ${config.brainDir}`);
  const children = files.map((f) => measured(f.rel, f.text));
  const chars = sumChars(children);
  return {
    name: "project instructions (ours — CLAUDE.md + @imports)",
    chars,
    tokens: tokensForChars(chars),
    owner: "ours",
    basis: "measured",
    note:
      'loaded by the SDK itself via settingSources:["project"], NOT by our prompt builder — which is exactly why /prompt never showed it',
    children,
  };
}

// --- C. the skill listing ---

/**
 * The context size the CLI multiplies its skill-listing fraction against.
 *
 * MEASURED, not assumed. At `skillListingBudgetFraction: 0.03` the listing silently truncated
 * exactly the 3 lowest-usage skills with 18,700 chars of non-internal description — which puts
 * the real budget at ~18,000 chars, i.e. contextTokens ≈ 150k. The obvious guess (200k) is
 * wrong and produced a "we're comfortably under budget" claim while three skills were being
 * dropped. If the model's window changes, re-derive this the same way (raise the fraction until
 * nothing truncates, then work backwards) rather than reasoning about it.
 */
export const SKILL_LISTING_CONTEXT_TOKENS = 150_000;

/** The CLI's default when the vault doesn't set one. Ours is deliberately far above it. */
export const DEFAULT_SKILL_LISTING_FRACTION = 0.01;

export interface SkillListingMeasurement {
  /** Skills the model actually sees, with the rendered line for each. */
  listed: { name: string; line: string }[];
  /** Skills excluded from the listing: `internal: true` and/or "off" in skillOverrides. */
  hidden: string[];
  /** The rendered listing. */
  text: string;
  chars: number;
  tokens: number;
  fraction: number;
  contextTokens: number;
  /** budget = contextTokens * 4 * fraction — the CLI's own formula. */
  budgetChars: number;
  headroomChars: number;
  /** Over budget the CLI drops descriptions to bare names, lowest-usage first, silently. */
  wouldTruncate: boolean;
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.brainDir, ".claude", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function frontmatterOf(md: string): string | null {
  return md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null;
}

/**
 * A scalar frontmatter field, covering the shapes skills actually use: a plain single line, a
 * quoted line, and the folded/literal block scalars (`>`, `>-`, `|`, `|-`) that every long
 * `description:` in the vault is written as. Folded blocks join with spaces the way YAML does,
 * so the measured chars match what the CLI ends up rendering.
 */
function frontmatterScalar(fm: string, key: string): string | undefined {
  const header = fm.match(new RegExp(`^${key}:[ \\t]*(\\|[-+]?|>[-+]?)?[ \\t]*(.*)$`, "m"));
  if (!header) return undefined;
  const [, style, inline] = header;
  if (!style) {
    const v = inline.trim().replace(/^["']|["']$/g, "").trim();
    return v || undefined;
  }
  const after = fm.slice(header.index! + header[0].length).replace(/^\r?\n/, "");
  const lines: string[] = [];
  for (const ln of after.split("\n")) {
    if (ln.trim() && !/^[ \t]/.test(ln)) break; // next top-level key
    lines.push(ln.replace(/^[ \t]+/, ""));
  }
  // Folded (`>`) joins its lines with spaces, literal (`|`) keeps the newlines — same as YAML,
  // so the char count matches the string the CLI actually renders into the listing.
  const folded = style.startsWith(">");
  const body = folded ? lines.join(" ").replace(/[ \t]+/g, " ") : lines.join("\n");
  return body.trim() || undefined;
}

/**
 * What the skill listing costs and whether it fits.
 *
 * Exported as its own function because the queued suite check needs EXACTLY this computation —
 * a second implementation of the budget formula living in a test is the same rot this whole
 * layer has been digging out of. The check reports the cost and fails only on real truncation;
 * it is not a cap on how many skills the owner may have.
 */
export function measureSkillListing(): SkillListingMeasurement {
  const settings = readSettings();
  const overrides: Record<string, string> = settings.skillOverrides ?? {};
  const fraction =
    typeof settings.skillListingBudgetFraction === "number"
      ? settings.skillListingBudgetFraction
      : DEFAULT_SKILL_LISTING_FRACTION;

  const listed: { name: string; line: string }[] = [];
  const hidden: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR).sort();
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fm = frontmatterOf(raw);
    if (!fm) continue;
    const name = frontmatterScalar(fm, "name") ?? dir;
    // Both halves of "not in the listing": the skill's own `internal: true` flag and the
    // vault's `skillOverrides: {<name>: "off"}`. A test already keeps those two in sync, so
    // either one alone is enough to exclude — but check both, because THIS report is where
    // a drift between them would show up as a wrong number.
    if (/^internal:[ \t]*true[ \t]*$/m.test(fm) || overrides[name] === "off" || overrides[dir] === "off") {
      hidden.push(name);
      continue;
    }
    const description = frontmatterScalar(fm, "description") ?? "";
    listed.push({ name, line: `- ${name}: ${description}` });
  }

  const text = listed.map((s) => s.line).join("\n");
  const budgetChars = Math.floor(SKILL_LISTING_CONTEXT_TOKENS * 4 * fraction);
  return {
    listed,
    hidden: hidden.sort(),
    text,
    chars: text.length,
    tokens: estimateTokens(text),
    fraction,
    contextTokens: SKILL_LISTING_CONTEXT_TOKENS,
    budgetChars,
    headroomChars: budgetChars - text.length,
    wouldTruncate: text.length > budgetChars,
  };
}

function skillListingBlock(): ContextBlock {
  const m = measureSkillListing();
  const pct = m.budgetChars ? Math.round((m.chars / m.budgetChars) * 100) : 0;
  return {
    name: "skills listing (ours — injected by the CLI)",
    chars: m.chars,
    tokens: m.tokens,
    owner: "ours",
    basis: "measured",
    note:
      `${m.listed.length} skills listed, ${m.hidden.length} hidden (internal/off). ` +
      `budget ${m.budgetChars.toLocaleString()} chars (${SKILL_LISTING_CONTEXT_TOKENS.toLocaleString()} ctx x 4 x ${m.fraction}) — ` +
      `using ${pct}%, headroom ${m.headroomChars.toLocaleString()}. ` +
      (m.wouldTruncate
        ? "OVER BUDGET — the CLI is silently cutting descriptions to bare names, lowest-usage first"
        : "would not truncate") +
      ". sent once per session, not per turn",
  };
}

// --- D. tool schemas ---

/** How a capability is serialized into the tool block: name, description, and its JSON schema. */
function serializeCapability(fullName: string, description: string, schema: unknown): string {
  return `${fullName}\n${description}\n${JSON.stringify(schema)}`;
}

function toolSchemaBlock(): ContextBlock {
  // Pinning is per CAPABILITY, not per server — scheduled_tasks pins schedule + list and leaves
  // cancel deferred — so the split has to be taken one capability at a time. Splitting by server
  // would have reported a partly-pinned server as wholly one or the other, i.e. lied about the
  // exact number this block exists to keep honest.
  const liveCaps = IN_PROCESS_SERVERS.filter((s) => inLane(s.exposure, "live")).flatMap((s) =>
    s.capabilities.map((c) => ({ name: `mcp__${s.key}__${c.name}`, pinned: isPinned(s, c), cap: c })),
  );
  const pinned = liveCaps.filter((c) => c.pinned);
  const deferred = liveCaps.filter((c) => !c.pinned);

  const pinnedText = pinned
    .map((c) => serializeCapability(c.name, c.cap.description, capabilitySchema(c.cap)))
    .join("\n");
  // Deferred tools cost only their NAME in the deferred registry — the schema is fetched by
  // ToolSearch on demand and is not in the turn-1 prompt. That asymmetry is the whole cost
  // model lane.ts is built on, so it has to show up as two separate rows here.
  const deferredNames = deferred.map((c) => c.name).join("\n");

  const children: ContextBlock[] = [
    measured(
      `ours, pinned (alwaysLoad: ${pinned.map((c) => c.name.replace(/^mcp__/, "")).join(", ") || "none"}) — ${pinned.length} tools, full schema`,
      pinnedText,
      "ours",
    ),
    measured(
      `ours, deferred behind ToolSearch — ${deferred.length} tools, names only`,
      deferredNames,
      "ours",
      "the schema is fetched on demand and is NOT in the turn-1 prompt; only the name is paid",
    ),
  ];

  const liveExternal = ALL_SERVERS.filter((s) => s.kind === "external" && inLane(s.exposure, "live"));
  const externalRegistered = ALL_SERVERS.filter((s) => s.kind === "external").length;
  children.push(
    liveExternal.length
      ? {
          name: `external mcp.json servers in the live lane — ${liveExternal.length}`,
          chars: 0,
          tokens: 0,
          owner: "ours",
          basis: "unmeasurable",
          note: `their tools live in another process (${liveExternal.map((s) => s.key).join(", ")}) — not statically enumerable from here`,
        }
      : {
          name: "external mcp.json servers in the live lane — 0",
          chars: 0,
          tokens: 0,
          owner: "ours",
          basis: "measured",
          note: `all ${externalRegistered} registered external servers are specialist-only, so none reach an orchestrator context`,
        },
  );

  children.push({
    name: "SDK built-in tools (Read/Write/Edit/Bash/Grep/Glob/ToolSearch/WebSearch/WebFetch/Skill/…)",
    chars: 0,
    tokens: 0,
    owner: "sdk",
    basis: "unmeasurable",
    note:
      "their descriptions ship inside the CLI and are attached above our prompt — not countable from in here. these plus the SDK preamble (an attribution header, one identity sentence, and a parallel-tool-calls instruction — tiny) are the irreducible remainder",
  });

  const chars = sumChars(children);
  return {
    name: "tool schemas (mixed)",
    chars,
    tokens: tokensForChars(chars),
    owner: "ours",
    basis: "measured",
    note: "measured half only — the SDK built-ins below have no number and are real",
    children,
  };
}

// --- E/F. fresh-session-only blocks ---

const FRESH_ONLY = "only paid on a FRESH or rolled-over session — a resumed turn already has it in the replayed transcript";

function workingStateBlock(): ContextBlock {
  const text = renderPersistedWorkingState();
  if (!text) {
    return {
      name: "working state (ours — carried across a rollover)",
      chars: 0,
      tokens: 0,
      owner: "ours",
      basis: "measured",
      note: "nothing persisted right now (SESSION_WORKING_STATE off, or no state file yet)",
    };
  }
  return { ...measured("working state (ours — carried across a rollover)", text, "ours", FRESH_ONLY), freshSessionOnly: true };
}

function replayedHistoryBlock(): ContextBlock {
  return {
    ...measured("replayed history (ours — recentHistory seed)", recentHistory(), "ours", FRESH_ONLY),
    freshSessionOnly: true,
  };
}

// --- The anchor ---

function liveAnchor(): LiveAnchor {
  const rec = readSessionRecord();
  if (!rec) return { tokens: null, updatedAt: null, stale: false, reason: "no session record on disk yet" };
  if (!rec.contextTokens) {
    return { tokens: null, updatedAt: rec.updatedAt, stale: false, reason: "session record carries no context-token count yet (no turn has reported usage)" };
  }
  return { tokens: rec.contextTokens, updatedAt: rec.updatedAt, stale: Date.now() - rec.updatedAt >= SESSION_MAX_AGE_MS };
}

// --- Rendering ---

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

interface Row {
  name: string;
  chars: string;
  tokens: string;
  pct: string;
  owner: string;
  basis: string;
  note?: string;
}

function rowsFor(b: ContextBlock, measuredTokens: number, depth: number): Row[] {
  const numeric = b.basis !== "unmeasurable";
  const rows: Row[] = [
    {
      name: `${"  ".repeat(depth)}${b.name}`,
      chars: numeric ? fmt(b.chars) : "—",
      tokens: numeric ? `~${fmt(b.tokens)}` : "—",
      pct: numeric && measuredTokens ? `${((b.tokens / measuredTokens) * 100).toFixed(1)}%` : "—",
      owner: b.owner,
      basis: b.basis,
      note: b.note,
    },
  ];
  for (const c of b.children ?? []) rows.push(...rowsFor(c, measuredTokens, depth + 1));
  return rows;
}

/**
 * Plain aligned columns, deliberately NOT a markdown table: this lands as a .md attachment that
 * gets read in whatever plain viewer iMessage hands it to, where pipes and dashes are noise.
 */
function renderTable(rows: Row[]): string[] {
  const w = (get: (r: Row) => string, header: string) =>
    Math.max(header.length, ...rows.map((r) => get(r).length));
  const wn = w((r) => r.name, "block");
  const wc = w((r) => r.chars, "chars");
  const wt = w((r) => r.tokens, "tokens");
  const wp = w((r) => r.pct, "% meas");
  const wo = w((r) => r.owner, "owner");

  const out: string[] = [
    `${"block".padEnd(wn)}  ${"chars".padStart(wc)}  ${"tokens".padStart(wt)}  ${"% meas".padStart(wp)}  ${"owner".padEnd(wo)}  basis`,
    "-".repeat(wn + wc + wt + wp + wo + 10 + "basis".length),
  ];
  for (const r of rows) {
    out.push(
      `${r.name.padEnd(wn)}  ${r.chars.padStart(wc)}  ${r.tokens.padStart(wt)}  ${r.pct.padStart(wp)}  ${r.owner.padEnd(wo)}  ${r.basis}`,
    );
    if (r.note) {
      const indent = r.name.length - r.name.trimStart().length;
      out.push(`${" ".repeat(indent + 2)}↳ ${r.note}`);
    }
  }
  return out;
}

function render(
  blocks: ContextBlock[],
  measuredChars: number,
  measuredTokens: number,
  perTurnTokens: number,
  freshOnlyTokens: number,
  live: LiveAnchor,
  remainder: number | null,
): string {
  const rows = blocks.flatMap((b) => rowsFor(b, measuredTokens, 0));
  rows.push({
    name: "TOTAL (ours, measured)",
    chars: fmt(measuredChars),
    tokens: `~${fmt(measuredTokens)}`,
    pct: "100.0%",
    owner: "ours",
    basis: "measured",
  });

  const lines: string[] = [
    "CONTEXT ACCOUNTING",
    "==================",
    `${config.agentName} · generated ${new Date().toLocaleString("en-US")}`,
    "",
    "Every block that is actually in context each turn — not just the part this file's prompt",
    "builder composes. Token figures are ~chars/4 estimates unless stated otherwise; the one",
    "real number is the live-session anchor at the bottom.",
    "",
    ...renderTable(rows),
    "",
    "THE ANCHOR — the only non-estimated number here",
    "-----------------------------------------------",
  ];

  if (live.tokens === null) {
    lines.push(`live session total: UNKNOWN — ${live.reason ?? "no data"}.`);
    lines.push("(so the remainder below can't be computed; nothing fake is printed in its place.)");
  } else {
    lines.push(
      `live session total (real, from the API): ${fmt(live.tokens)} tokens` +
        (live.updatedAt ? ` — as of the last turn, ${ago(live.updatedAt)}` : ""),
    );
    if (live.stale) {
      lines.push("STALE: that record is older than the session rollover window, so it describes a session that has since been replaced.");
    }
    lines.push(`our measured blocks:                    ~${fmt(measuredTokens)} tokens`);
    lines.push(
      `  of that, re-paid on EVERY turn:       ~${fmt(perTurnTokens)} tokens` +
        (freshOnlyTokens ? `\n  of that, fresh-session seed only:     ~${fmt(freshOnlyTokens)} tokens` : ""),
    );
    lines.push(
      `remainder (by subtraction):             ~${fmt(remainder ?? 0)} tokens — SDK-owned + conversation so far`,
    );
    lines.push("");
    lines.push("That remainder is NOT one thing. It is: the SDK's built-in tool descriptions and preamble,");
    lines.push("plus every user/assistant/tool-result message in this session's replayed transcript. It also");
    lines.push("absorbs the error in our ~chars/4 estimate, and is reduced by any block above that a RESUMED");
    lines.push("turn doesn't re-pay (working state, replayed history — flagged in their notes).");
  }

  lines.push(
    "",
    "LEGEND",
    "------",
    "measured     — the actual bytes were counted from the artifact that gets loaded.",
    "estimated    — computed from a rule rather than from the artifact itself.",
    "unmeasurable — real, costs real tokens, and cannot be counted from inside this process.",
    "               (SDK built-in tool descriptions; tools of external mcp.json servers, which",
    "                live in another process.) These rows show no number rather than a zero.",
    "ours / sdk   — who owns the bytes. `ours` is editable from this repo or the vault; `sdk`",
    "               ships inside the Claude Agent SDK and can only be removed by denying a tool.",
    "",
    "THE FULL PROMPT TEXT FOLLOWS BELOW.",
    "",
    "=".repeat(78),
    "",
  );
  return lines.join("\n");
}

// --- Entry point ---

export function buildContextReport(): ContextReport {
  const blocks: ContextBlock[] = [
    block("system prompt (ours — what /prompt used to show)", systemPromptBlock),
    block("project instructions (ours — CLAUDE.md + @imports)", projectInstructionsBlock),
    block("skills listing (ours — injected by the CLI)", skillListingBlock),
    block("tool schemas (mixed)", toolSchemaBlock),
    block("working state (ours — carried across a rollover)", workingStateBlock),
    block("replayed history (ours — recentHistory seed)", replayedHistoryBlock),
  ];

  const measuredChars = sumChars(blocks);
  const measuredTokens = blocks.reduce((n, b) => n + b.tokens, 0);
  const freshSessionOnlyTokens = blocks.filter((b) => b.freshSessionOnly).reduce((n, b) => n + b.tokens, 0);
  const perTurnTokens = measuredTokens - freshSessionOnlyTokens;

  let live: LiveAnchor;
  try {
    live = liveAnchor();
  } catch (e) {
    live = { tokens: null, updatedAt: null, stale: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const remainderTokens = live.tokens === null ? null : live.tokens - measuredTokens;

  return {
    blocks,
    measuredChars,
    measuredTokens,
    perTurnTokens,
    freshSessionOnlyTokens,
    live,
    remainderTokens,
    text: render(blocks, measuredChars, measuredTokens, perTurnTokens, freshSessionOnlyTokens, live, remainderTokens),
  };
}

/**
 * The iMessage-side summary: what to say in the text that carries the attachment. Compact,
 * lowercase, no markdown syntax (it's a bubble, not a document), capped around 10 lines.
 */
export function summarizeContextReport(r: ContextReport): string {
  const biggest = r.blocks
    .filter((b) => b.basis !== "unmeasurable" && b.chars > 0)
    .sort((a, b) => b.tokens - a.tokens)
    // Four, not five: the caller prepends a header line, and the whole thing has to stay a
    // scannable bubble rather than a wall.
    .slice(0, 4);
  const lines: string[] = [];
  lines.push(
    r.live.tokens === null
      ? `real session total: unknown (${r.live.reason})`
      : `real session total: ${fmt(r.live.tokens)} tokens${r.live.stale ? " (stale record)" : ""}`,
  );
  lines.push(
    `ours, measured: ~${fmt(r.measuredTokens)} tokens (${fmt(r.measuredChars)} chars)` +
      (r.freshSessionOnlyTokens
        ? ` — ~${fmt(r.perTurnTokens)} of it every turn, the rest is fresh-session seed`
        : ""),
  );
  if (r.remainderTokens !== null) {
    lines.push(`remainder ~${fmt(r.remainderTokens)} — sdk tools + this conversation, by subtraction`);
  }
  for (const b of biggest) {
    lines.push(`- ${b.name.replace(/\s*\(.*?\)\s*$/, "")}: ~${fmt(b.tokens)}`);
  }
  lines.push("full breakdown + the prompt itself in the file");
  return lines.join("\n");
}
