import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { log, warn } from "../core/log";
import { runBrainTextResult } from "../runtimes/brain";
import { recentHistory } from "./transcript";

/**
 * "Pack our own bags" session-rollover compaction.
 *
 * Fig resumes one persistent SDK session by id; the SDK replays its whole transcript
 * each turn. When live context crosses SESSION_MAX_CONTEXT_TOKENS, loadSession()
 * returns undefined and a FRESH session starts, seeded from recentHistory()'s raw
 * "[HH:MM] speaker: text" tail. That hard-roll keeps recent words but drops the
 * accumulated *understanding* — which files were read, where code lives, decisions
 * made, what was half-done. (That's the failure: spot's code lives in
 * ~/GitHub/spot and the rollover forgot it.)
 *
 * The fix isn't a smoother seam (in-place compaction) — it's a BETTER bag. At
 * rollover we run ONE selected-model extraction pass and carry forward a structured
 * working-state block, persisted OUTSIDE the transcript so it survives many
 * rollovers. The block is prepended to the existing verbatim tail in the seed.
 *
 * Anti-loss design (each part defends a known failure mode from the research):
 *  - INTENT      — recent USER lines kept VERBATIM, sliced in code (never sent to the
 *                  summarizer). Codex's #1 trick: never paraphrase intent into prose.
 *  - OPEN TASK   — the single task in flight + the immediate next step.
 *  + NEXT STEP
 *  - DECISIONS   — choices + WHY, APPEND-ONLY across rollovers (defeats the
 *                  "progressive amnesia" of single-pass summaries). Merged in code so
 *                  a forgetful extraction can't drop prior entries.
 *  - FILE INDEX  — exact paths + one line each, a STRUCTURED field (file paths are the
 *                  worst-preserved item in every system). Merged/deduped in code.
 *
 * Gated behind SESSION_WORKING_STATE (default OFF). When off, buildWorkingState()
 * returns null and the caller keeps the current raw-seed behavior unchanged.
 */

// --- Config / flags ---

/** Feature flag. Default OFF so it can be toggled on after a sanity check. */
export function workingStateEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SESSION_WORKING_STATE || "").trim());
}

const EXTRACTION_TIMEOUT_MS = Number(process.env.WORKING_STATE_TIMEOUT_MS || 45_000);
/** Cap accumulated entries so a long-lived state file stays bounded. */
const MAX_DECISIONS = Number(process.env.WORKING_STATE_MAX_DECISIONS || 60);
const MAX_FILES = Number(process.env.WORKING_STATE_MAX_FILES || 80);
/** Char budget for the verbatim intent slice (codex caps the verbatim tail ~20k tokens). */
const INTENT_CHARS = Number(process.env.WORKING_STATE_INTENT_CHARS || 8_000);
/** Drop accumulated state older than this so a stale task/decisions don't haunt a new stretch. */
const STATE_TTL_MS = Number(process.env.WORKING_STATE_TTL_H || 24) * 3_600_000;

// --- Persistence (lives in .state, OUTSIDE the transcript) ---

interface FileIndexEntry {
  path: string;
  note: string;
}

interface WorkingState {
  updatedAt: number;
  /** How many rollovers this state has survived (for visibility/debugging). */
  rollovers: number;
  openTask: string;
  nextStep: string;
  /** Append-only across rollovers. */
  decisions: string[];
  /** Merged/deduped by path across rollovers. */
  fileIndex: FileIndexEntry[];
}

function stateFile(): string {
  return path.join(config.stateDir, "working-state.json");
}

/** Read + normalize the persisted working state. Returns null if missing/garbage. */
export function readWorkingState(): WorkingState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return {
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      rollovers: typeof raw.rollovers === "number" ? raw.rollovers : 0,
      openTask: typeof raw.openTask === "string" ? raw.openTask : "",
      nextStep: typeof raw.nextStep === "string" ? raw.nextStep : "",
      decisions: Array.isArray(raw.decisions) ? raw.decisions.filter((d: unknown) => typeof d === "string") : [],
      fileIndex: Array.isArray(raw.fileIndex)
        ? raw.fileIndex
            .filter((f: any) => f && typeof f.path === "string")
            .map((f: any) => ({ path: f.path, note: typeof f.note === "string" ? f.note : "" }))
        : [],
    };
  } catch {
    return null;
  }
}

function persist(s: WorkingState): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  } catch (e) {
    warn(`working-state persist failed: ${e}`);
  }
}

// --- Verbatim intent (sliced in code; never summarized) ---

/**
 * The most recent USER (owner) lines from the transcript tail, kept byte-for-byte
 * and bounded by char budget. Agent lines are dropped — this is intent, not the
 * back-and-forth (the full tail rides separately in the seed).
 */
function recentUserIntent(history: string): string {
  if (!history) return "";
  const agent = config.agentName.trim().toLowerCase();
  const userLines = history.split("\n").filter((ln) => {
    const m = ln.match(/^\[\d{2}:\d{2}\]\s+([^:]+):/);
    return m ? m[1].trim().toLowerCase() !== agent : false;
  });
  const out: string[] = [];
  let used = 0;
  for (let i = userLines.length - 1; i >= 0; i--) {
    used += userLines[i].length + 1;
    if (used > INTENT_CHARS && out.length) break;
    out.unshift(userLines[i]);
  }
  return out.join("\n");
}

// --- Extraction pass (one cheap LLM call) ---

const EXTRACTION_SYSTEM =
  "You compact a coding-assistant session into a compact working-state record so the " +
  "next session keeps continuity after a context rollover. Output ONLY a single JSON " +
  "object — no prose, no explanation, no markdown fences.";

function extractionPrompt(history: string, prior: WorkingState | null): string {
  const priorDecisions = prior?.decisions.length
    ? prior.decisions.map((d) => `- ${d}`).join("\n")
    : "(none)";
  const priorFiles = prior?.fileIndex.length
    ? prior.fileIndex.map((f) => `- ${f.path} — ${f.note}`).join("\n")
    : "(none)";
  return [
    "Produce the current working state of this session as JSON with EXACTLY this shape:",
    '{"openTask": string, "nextStep": string, "decisions": string[], "fileIndex": [{"path": string, "note": string}]}',
    "",
    "Four directives:",
    "1. Copy every file path EXACTLY as written (full, verbatim). fileIndex = files read/edited/created in this work, one short note each on what the file is or what changed.",
    "2. decisions = concrete choices made and WHY, one line each. List the NEW ones you see in the transcript; prior decisions are merged in automatically, so don't worry about repeating them.",
    "3. openTask = the single task currently in flight; nextStep = the immediate next action. Short and concrete.",
    "4. Do not editorialize. If a field has nothing, use \"\" or [].",
    "",
    "Prior decisions already on record (for context — don't restate them):",
    priorDecisions,
    "",
    "Prior file index already on record (for context):",
    priorFiles,
    "",
    "TRANSCRIPT (most recent conversation):",
    history,
  ].join("\n");
}

interface Extracted {
  openTask: string;
  nextStep: string;
  decisions: string[];
  fileIndex: FileIndexEntry[];
}

/** Pull the first {...} JSON object out of the model's text and normalize it. */
function parseExtraction(text: string): Extracted | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return {
    openTask: typeof parsed.openTask === "string" ? parsed.openTask.trim() : "",
    nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : "",
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.filter((d: unknown) => typeof d === "string").map((d: string) => d.trim())
      : [],
    fileIndex: Array.isArray(parsed.fileIndex)
      ? parsed.fileIndex
          .filter((f: any) => f && typeof f.path === "string")
          .map((f: any) => ({ path: String(f.path).trim(), note: typeof f.note === "string" ? f.note.trim() : "" }))
      : [],
  };
}

// --- Merge (append-only / dedupe in code, so a forgetful extraction can't lose history) ---

function mergeDecisions(prior: string[], next: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...prior, ...next]) {
    const t = d.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  // Keep the most recent if we blow the cap (prior entries are oldest, listed first).
  return out.slice(-MAX_DECISIONS);
}

function mergeFiles(prior: FileIndexEntry[], next: FileIndexEntry[]): FileIndexEntry[] {
  // Map preserves insertion order; updating an existing key keeps its original slot,
  // so prior paths stay first and only their note refreshes when a newer one arrives.
  const map = new Map<string, string>();
  for (const f of [...prior, ...next]) {
    const p = f.path.trim();
    if (!p) continue;
    const note = f.note.trim();
    map.set(p, note || map.get(p) || "");
  }
  return [...map.entries()].slice(-MAX_FILES).map(([p, note]) => ({ path: p, note }));
}

// --- Render the seed block ---

function renderBlock(s: WorkingState, intent: string): string | null {
  const parts: string[] = [];
  if (s.openTask) parts.push(`OPEN TASK: ${s.openTask}`);
  if (s.nextStep) parts.push(`NEXT STEP: ${s.nextStep}`);
  if (s.decisions.length) {
    parts.push("", "DECISIONS (append-only history of choices + why):", ...s.decisions.map((d) => `- ${d}`));
  }
  if (s.fileIndex.length) {
    parts.push(
      "",
      "FILE INDEX (exact paths in play — use these, don't re-derive where things live):",
      ...s.fileIndex.map((f) => `- ${f.path}${f.note ? ` — ${f.note}` : ""}`),
    );
  }
  if (intent) {
    parts.push("", "RECENT INTENT (the owner's own recent words, verbatim — do not reinterpret):", intent);
  }
  if (!parts.length) return null;
  return [
    "[working state — your accumulated memory carried across a context rollover. treat this as ground truth for what you were doing and where the code lives:]",
    "",
    ...parts,
    "",
    "[end working state]",
  ].join("\n");
}

// --- Entry point ---

/**
 * Build the working-state seed block for a fresh (rolled-over) session: run the
 * extraction pass over the dying session's recent transcript, merge it append-only
 * into the persisted state, write it back, and render the block.
 *
 * Resilient by construction: returns null (→ caller falls back to the raw seed) when
 * the flag is off, when there's nothing to carry, or when the extraction call fails.
 * The underlying runner never throws (it returns ok:false), and the merge always
 * preserves prior decisions/files even if extraction yields nothing.
 */
export async function buildWorkingState(opts?: { signal?: AbortSignal }): Promise<string | null> {
  if (!workingStateEnabled()) return null;

  const history = recentHistory();
  let prior = readWorkingState();
  // Stale accumulation (e.g. a fresh start after days idle) shouldn't drag old
  // task/decisions into a new stretch.
  if (prior && Date.now() - prior.updatedAt > STATE_TTL_MS) prior = null;
  if (!history && !prior) return null; // nothing to pack

  const intent = recentUserIntent(history);

  let extracted: Extracted = { openTask: "", nextStep: "", decisions: [], fileIndex: [] };
  if (history) {
    const res = await runBrainTextResult({
      label: "working-state compaction",
      prompt: extractionPrompt(history, prior),
      signal: opts?.signal,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
      options: {
        cwd: config.brainDir,
        systemPrompt: EXTRACTION_SYSTEM,
        settingSources: [], // pure text pass — don't load CLAUDE.md/skills
        allowedTools: [], // no tools; just summarize the text we hand it
        permissionMode: "default",
      },
    });
    if (res.ok && res.text) {
      const parsed = parseExtraction(res.text);
      if (parsed) extracted = parsed;
      else warn("working-state extraction returned unparseable output — carrying prior state forward");
    } else if (!res.ok) {
      warn("working-state extraction failed — carrying prior state forward");
    }
  }

  const merged: WorkingState = {
    updatedAt: Date.now(),
    rollovers: (prior?.rollovers ?? 0) + 1,
    openTask: extracted.openTask || prior?.openTask || "",
    nextStep: extracted.nextStep || prior?.nextStep || "",
    decisions: mergeDecisions(prior?.decisions ?? [], extracted.decisions),
    fileIndex: mergeFiles(prior?.fileIndex ?? [], extracted.fileIndex),
  };
  persist(merged);

  const block = renderBlock(merged, intent);
  if (block) {
    log(
      `working-state seed built (rollover #${merged.rollovers}): ${merged.decisions.length} decisions, ${merged.fileIndex.length} files`,
    );
  }
  return block;
}

/**
 * The working-state block as it stands RIGHT NOW, rendered from the persisted state without
 * running an extraction pass — i.e. what a fresh/rolled-over session would be seeded with if it
 * started this instant.
 *
 * Exists for the context accounting (`core/contextReport.ts`), which has to measure this block
 * without spending an LLM call or mutating the state file. It reuses `renderBlock` rather than
 * re-deriving the shape, so the measured bytes are the same bytes. The verbatim-intent tail is
 * included for the same reason — it rides along in the real seed.
 */
export function renderPersistedWorkingState(): string | null {
  try {
    const s = readWorkingState();
    if (!s) return null;
    return renderBlock(s, recentUserIntent(recentHistory()));
  } catch {
    return null;
  }
}

/** Pure helpers exposed for the deterministic rollover test (scripts/tests/compaction.test.ts). */
export const _internals = {
  recentUserIntent,
  parseExtraction,
  mergeDecisions,
  mergeFiles,
  renderBlock,
};
