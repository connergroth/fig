import path from "path";

import { config } from "./config";
import { readJson, writeJson } from "./jsonStore";
import { log } from "./log";
import { CODEX_REASONING_LEVELS, type CodexReasoning } from "../runtimes/codex";

/**
 * Live model/runtime switch. `/model <alias>` flips which Claude model or runtime
 * fig's live reply loop uses — intercepted in Conversation.enqueue() like the kill
 * switch and the fig↔spot command, so it NEVER becomes an agent turn (no tokens
 * spent to change models, which would defeat the point of switching to save usage).
 *
 * The override is persisted to disk (stateDir/model.json) so it survives the
 * auto-restart, and is read fresh per use via currentModel()/currentModelRuntime()
 * — no process bounce needed for it to take. `/model default` clears the override,
 * dropping back to config.model (the AGENT_MODEL env value, i.e. the top of the chain).
 *
 * Scope: the selected runtime follows every fig-brain lane: live conversation, `/bg`,
 * scheduled/proactive passes, triage, compaction, news, and other scoped text work. Triage
 * follows the PROVIDER but deliberately uses that provider's light tier, never the selected
 * flagship. This is an explicit reversal of the old "triage and compaction do not cascade"
 * decision — do not pin them back. Delegated specialists keep their independently configured
 * runtime/model, and research remains independent only when RESEARCH_MODEL explicitly pins it.
 * A scoped pass may still log an individual Claude fallback when its declared tool contract
 * cannot be provided by the selected runtime; that is capability preservation, not scope.
 */

const MODEL_FILE = path.join(config.stateDir, "model.json");

export type ModelRuntime = "claude" | "codex";

interface ModelState {
  model?: unknown;
  runtime?: unknown;
  codexReasoning?: unknown;
}

/** Alias → concrete model id. Bare family names route to the most recent of that family. */
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  sonnet5: "claude-sonnet-5",
  opus: "claude-opus-5",
  opus5: "claude-opus-5",
  "opus4.8": "claude-opus-4-8",
  opus48: "claude-opus-4-8",
  "opus4.7": "claude-opus-4-7",
  opus47: "claude-opus-4-7",
  fable: "claude-fable-5",
  fable5: "claude-fable-5",
};

const RUNTIME_ALIASES: Record<string, ModelRuntime> = {
  claude: "claude",
  codex: "codex",
  codecs: "codex",
};

function readState(): ModelState {
  return readJson<ModelState>(MODEL_FILE, {});
}

function readOverride(): string | null {
  const { model, runtime } = readState();
  if (runtime === "codex") return null;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

/** The model fig's brain should run on right now: the live override, else the configured default. */
export function currentModel(): string {
  return readOverride() ?? config.model;
}

export function currentModelRuntime(): ModelRuntime {
  const { runtime } = readState();
  return runtime === "codex" ? "codex" : "claude";
}

function isReasoning(v: unknown): v is CodexReasoning {
  return typeof v === "string" && (CODEX_REASONING_LEVELS as string[]).includes(v);
}

/** The reasoning depth the live codex runtime should use, if the owner pinned one via `/model codex <effort>`. */
export function currentCodexReasoning(): CodexReasoning | undefined {
  const { codexReasoning } = readState();
  return isReasoning(codexReasoning) ? codexReasoning : undefined;
}

export function currentModelLabel(): string {
  if (currentModelRuntime() !== "codex") return currentModel();
  const eff = currentCodexReasoning();
  return eff ? `codex/${eff}` : "codex";
}

function setClaudeOverride(model: string | null): void {
  writeJson(MODEL_FILE, { runtime: "claude", model, updatedAt: new Date().toISOString() });
}

function setRuntime(runtime: ModelRuntime, codexReasoning?: CodexReasoning): void {
  writeJson(MODEL_FILE, { runtime, model: null, codexReasoning, updatedAt: new Date().toISOString() });
}

const OPTIONS = "sonnet · opus · opus5 · opus4.7 · opus4.8 · fable · codex [low·medium·high·xhigh] · default";

/**
 * If `text` is a bare `/model [arg]` command, apply it and return a short confirmation
 * to send back. Returns null when it isn't, so the normal turn runs untouched.
 * No arg → report what's running. Unknown arg → list the options (never guesses).
 * A raw `claude-*` id is accepted verbatim as an escape hatch. `codex` (and the
 * common typo `codecs`) switches the live reply loop to the Codex runtime instead
 * of pretending Codex is a Claude model id.
 */
export function resolveModelCommand(text: string): string | null {
  const m = text.trim().match(/^\/model\b[ \t]*(.*)$/i);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const arg = (tokens[0] ?? "").toLowerCase();
  const effortArg = (tokens[1] ?? "").toLowerCase();

  if (!arg) {
    const override = readOverride();
    const runtime = currentModelRuntime();
    if (runtime === "codex") return `🤖 ${currentModelLabel()} (default: ${config.model})`;
    return override ? `🤖 ${override} (default: ${config.model})` : `🤖 ${config.model} (default)`;
  }

  if (arg === "default") {
    setClaudeOverride(null);
    log(`model override cleared → ${config.model}`);
    return `🤖 model → ${config.model} (default)`;
  }

  const runtime = RUNTIME_ALIASES[arg];
  if (runtime === "codex") {
    // Optional reasoning level: `/model codex high`. Reject an unknown 2nd token instead of silently dropping it.
    if (effortArg && !isReasoning(effortArg)) {
      return `🤖 don't know reasoning level "${effortArg}" — pick one of ${CODEX_REASONING_LEVELS.join(" · ")}`;
    }
    const reasoning = isReasoning(effortArg) ? effortArg : undefined;
    const before = currentModelLabel();
    const label = reasoning ? `codex/${reasoning}` : "codex";
    if (before === label) return `🤖 already on ${label}`;
    setRuntime("codex", reasoning);
    log(`model runtime override → ${label} (was ${before})`);
    return `🤖 model → ${label}`;
  }
  if (runtime === "claude") {
    const before = currentModelLabel();
    setClaudeOverride(null);
    log(`model runtime override cleared → ${config.model} (was ${before})`);
    return `🤖 model → ${config.model}`;
  }

  const target = ALIASES[arg] ?? (arg.startsWith("claude-") ? arg : null);
  if (!target) return `🤖 don't know "${arg}" — options: ${OPTIONS}`;

  const before = currentModelLabel();
  if (target === before) return `🤖 already on ${target}`;
  setClaudeOverride(target === config.model ? null : target);
  log(`model override → ${target} (was ${before})`);
  return `🤖 model → ${target}`;
}
