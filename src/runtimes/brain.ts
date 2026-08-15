import { config } from "../core/config";
import {
  currentCodexReasoning,
  currentModel,
  currentModelRuntime,
  type ModelRuntime,
} from "../core/model";
import { warn } from "../core/log";
import { requiredToolsPreamble, resolveRequirement } from "../scheduling/requiredTools";
import { subQueryDisallowedTools } from "../scheduling/lane";
import { fallbackCapabilityByName } from "../tools/fallback";
import {
  claudeTextRuntime,
  isProviderExhaustion,
  type ClaudeRuntimeOptions,
} from "./claude";
import {
  codexTextRuntime,
  type CodexRuntimeOptions,
} from "./codex";
import type { TextRuntime, TextRuntimeResult, TextRunValidation } from "./runtime";

export type BrainTextLane = "default" | "triage" | "research";

export interface BrainTextRun {
  label: string;
  prompt: string;
  options: ClaudeRuntimeOptions;
  lane?: BrainTextLane;
  /** Scheduled-skill dependencies declared in SKILL.md, not a general-purpose allowlist. */
  requiredTools?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (action: string) => void;
  validateOutput?: TextRunValidation;
}

export interface BrainTextPlan {
  runtimeName: ModelRuntime;
  runtime: TextRuntime<any>;
  prompt: string;
  providerOptions: ClaudeRuntimeOptions | CodexRuntimeOptions;
  /** Why the selected Codex runtime could not safely run this pass. */
  claudePinReason?: string;
}

const CODEX_LIGHT_MODEL = "gpt-5.6-luna";

function claudeProviderOptions(run: BrainTextRun): ClaudeRuntimeOptions {
  const denied = new Set([
    ...(run.options.disallowedTools ?? []),
    // A built-in this pass explicitly named in its own `tools` allowlist is kept — that's how
    // research/workflowRunner holds on to `Workflow`, which the base table denies everywhere else.
    ...subQueryDisallowedTools(run.options.tools),
  ]);
  return {
    ...run.options,
    // Triage follows the selected provider, but never its expensive tier: it runs per email.
    model: run.lane === "triage"
      ? config.emailTriageModel
      : run.options.model ?? currentModel(),
    disallowedTools: [...denied],
  };
}

function codexToolNames(requirement: string): string[] {
  if (process.env.CODEX_FIG_TOOLS === "0") return [];
  return resolveRequirement(requirement)
    .map((name) => fallbackCapabilityByName(name.replace(/^mcp__/, ""))?.fallbackName)
    .filter((name): name is string => !!name);
}

/** The flat fig_tools names that can satisfy every structural requirement, or null if one cannot. */
function codexRequiredToolMap(required: string[]): Map<string, string[]> | null {
  const out = new Map<string, string[]>();
  for (const requirement of required) {
    const names = codexToolNames(requirement);
    if (names.length === 0) return null;
    out.set(requirement, names);
  }
  return out;
}

function codexRequiredToolsPreamble(toolMap: Map<string, string[]>): string {
  if (toolMap.size === 0) return "";
  const lines = [...toolMap].map(([requirement, names]) =>
    `- ${requirement}: ${names.map((name) => `\`${name}\``).join(", ")}`,
  );
  return `REQUIRED TOOLS FOR THIS RUN:
${lines.join("\n")}

These are structural dependencies, published through Codex's flat fig_tools MCP server. Call at
least one listed tool for EACH requirement. Do not substitute shell scripts or raw state files if
a tool is unavailable; stop and report the missing tool instead.

`;
}

function codexPinReason(run: BrainTextRun): string | undefined {
  if (run.lane === "triage" && process.env.TRIAGE_RUNTIME?.trim().toLowerCase() === "claude") {
    return "TRIAGE_RUNTIME=claude";
  }
  if (run.lane === "research" && process.env.RESEARCH_MODEL?.trim()) {
    return `RESEARCH_MODEL pins ${process.env.RESEARCH_MODEL.trim()}`;
  }

  // `tools` is a hard Claude built-in surface, not an auto-approval list. Codex's scoped lane
  // cannot publish Workflow/WebSearch/etc.; silently dropping one changes the job's meaning.
  const builtins = Array.isArray(run.options.tools) ? run.options.tools.filter(Boolean) : [];
  if (builtins.length > 0) {
    return `Claude-only built-in tool surface required: ${builtins.join(", ")}`;
  }

  const required = run.requiredTools ?? [];
  if (required.length > 0 && !codexRequiredToolMap(required)) {
    const missing = required.filter((requirement) => codexToolNames(requirement).length === 0);
    return `selected Codex lane cannot provide required tool(s): ${missing.join(", ")}`;
  }
  return undefined;
}

/**
 * Plan one scoped brain pass without running it. Exported so provider routing and option
 * preservation can be regression-tested without spending an API call.
 */
export function planBrainTextRun(
  run: BrainTextRun,
  selectedRuntime: ModelRuntime = currentModelRuntime(),
): BrainTextPlan {
  const pinReason = selectedRuntime === "codex" ? codexPinReason(run) : undefined;
  if (selectedRuntime === "claude" || pinReason) {
    return {
      runtimeName: "claude",
      runtime: claudeTextRuntime,
      prompt: `${requiredToolsPreamble(run.requiredTools ?? [])}${run.prompt}`,
      providerOptions: claudeProviderOptions(run),
      ...(pinReason ? { claudePinReason: pinReason } : {}),
    };
  }

  const requiredToolMap = codexRequiredToolMap(run.requiredTools ?? []) ?? new Map();
  const providerOptions: CodexRuntimeOptions = {
    cwd: typeof run.options.cwd === "string" ? run.options.cwd : config.brainDir,
    addDirs: config.writableDirs,
    role: "main",
    reasoning: currentCodexReasoning(),
  };
  if (run.lane === "triage") {
    providerOptions.model = CODEX_LIGHT_MODEL;
    providerOptions.reasoning = "low";
  }
  return {
    runtimeName: "codex",
    runtime: codexTextRuntime,
    prompt: `${codexRequiredToolsPreamble(requiredToolMap)}${run.prompt}`,
    providerOptions,
  };
}

/**
 * Every scoped brain pass (triage, proactive voicing, research, news, compaction, a scheduled
 * task's own run) funnels through here. Provider selection lives here too, so a caller cannot
 * accidentally bypass either `/model` or the required-tool fallback.
 *
 * On Claude, `subQueryDisallowedTools` remains exact: a lane's denylist does NOT reach the
 * queries it spawns, so without this every sub-query carried the full preset
 * (AskUserQuestion's un-clickable picker included). Codex has one fixed stdio MCP surface and
 * cannot honor Claude's per-run allow/deny/system options; structurally required gaps pin that
 * individual pass back to Claude and are logged rather than silently degraded.
 */
export async function runBrainTextResult(run: BrainTextRun): Promise<TextRuntimeResult> {
  const plan = planBrainTextRun(run);
  if (plan.claudePinReason) {
    warn(`${run.label}: ${plan.claudePinReason}; running this pass on Claude`);
  }
  const result = await plan.runtime.runTextResult(runtimeArgs(run, plan));
  if (!shouldFallBackToCodex(plan, result)) return result;

  // The account is tapped out, not blipping: the identical pass will die the identical way on
  // the next tick, so "retry later" silently drops the beat/triage/report entirely. Rerun it
  // once on the other engine. Live turns already do this (session.ts `runCodexFallback`);
  // background passes had no counterpart, which is why an exhausted account looked like fig
  // simply going quiet.
  const fallbackPlan = planBrainTextRun(run, "codex");
  if (fallbackPlan.runtimeName !== "codex") {
    warn(`${run.label}: Claude exhausted, but this pass can't run on Codex (${fallbackPlan.claudePinReason}) — no fallback`);
    return result;
  }
  warn(`${run.label}: Claude exhausted — rerunning this pass on Codex`);
  const fallback = await fallbackPlan.runtime.runTextResult(runtimeArgs(run, fallbackPlan));
  // Keep the ORIGINAL exhaustion string when the fallback also fails: "Codex returned nothing"
  // on its own reads like a Codex bug and hides the reason the pass ever moved engines.
  return fallback.ok ? fallback : { ...fallback, error: fallback.error ?? result.error };
}

/** The provider-neutral half of a pass — identical for whichever runtime ends up running it. */
function runtimeArgs(run: BrainTextRun, plan: BrainTextPlan) {
  return {
    label: run.label,
    prompt: plan.prompt,
    signal: run.signal,
    timeoutMs: run.timeoutMs,
    onProgress: run.onProgress,
    validateOutput: run.validateOutput,
    providerOptions: plan.providerOptions,
  };
}

/**
 * Does a finished pass deserve a second run on the other engine? Exported pure so the
 * decision is regression-testable without spending an API call.
 *
 * Deliberately narrow — ONLY account exhaustion. A timeout, an abort, or a model that
 * simply had nothing to say are all things the caller's own retry-next-tick handles fine,
 * and paying for a full second run on every one of those would double the cost of every
 * flaky pass. Exhaustion is the one failure where waiting provably doesn't help.
 */
export function shouldFallBackToCodex(plan: BrainTextPlan, result: TextRuntimeResult): boolean {
  if (result.ok) return false;
  // Already on Codex — there is nowhere left to fall.
  if (plan.runtimeName !== "claude") return false;
  return isProviderExhaustion(result.error);
}

export async function runBrainText(run: BrainTextRun): Promise<string> {
  return (await runBrainTextResult(run)).text;
}
