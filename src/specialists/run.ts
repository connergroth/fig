import { type CanUseTool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../core/config";
import { currentModel } from "../core/model";
import { claudeTextRuntime, type ClaudeRuntimeOptions } from "../runtimes/claude";
import { runText, type TextRuntime } from "../runtimes/runtime";
import { subQueryDisallowedTools } from "../scheduling/lane";

/**
 * Run a specialist as a scoped sub-query and return its final text. This is the
 * core of the "thin orchestrator + scoped specialists" design: the heavy MCP tools
 * load only HERE, in this isolated query, on demand — never in the main session's
 * context every turn. Only the orchestrator's own final text reaches the owner; the
 * specialist's answer comes back through the delegating tool's return value.
 */
export async function runSpecialist<ProviderOptions = ClaudeRuntimeOptions>(opts: {
  label: string;
  prompt: string;
  systemPrompt?: string;
  mcpServers: Record<string, McpServerConfig>;
  canUseTool: CanUseTool;
  /**
   * AUTO-APPROVE list, not a tool surface — the Agent SDK's own words for `allowedTools` are
   * "tool names that are auto-allowed without prompting for permission". Anything omitted is
   * still ATTACHED; it just routes through `canUseTool` (i.e. interrupts the owner for a 👍).
   * The built-in surface is capped separately, below, from the non-MCP names in this list.
   */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Working root for the sub-query. Defaults to the brain/vault; coding subagents pass a repo. */
  cwd?: string;
  /** External abort (the turn's signal, via detachable) — kills the sub-query mid-flight on stop. */
  signal?: AbortSignal;
  /** Per-run runaway cap (ms). Long background jobs (browser) pass a larger value than the 2-min default. */
  timeoutMs?: number;
  /**
   * Cheap progress sink — called with a short one-liner each time the specialist makes a
   * tool call (e.g. "navigating to linkedin.com", "reading src/foo.ts"). Overwritten in
   * place by the caller (see jobs.ts's `report`), not accumulated. Optional — omit for
   * blocking specialist calls that don't feed a job board.
   */
  onProgress?: (action: string) => void;
  /** Text runtime to execute this specialist. Defaults to Claude Agent SDK. */
  runtime?: TextRuntime<ProviderOptions>;
  /** Provider-specific options for runtime. Defaults to Claude Agent SDK options. */
  providerOptions?: ProviderOptions;
}): Promise<string> {
  // The built-in surface, derived from the non-MCP names the caller listed. `tools` is the
  // option that actually RESTRICTS ("specify the base set of available built-in tools");
  // `allowedTools` only skips the approval prompt. A caller that lists MCP servers' tools and
  // no built-ins at all is left uncapped rather than silently handed `tools: []`, which would
  // strip Read/Bash out from under it.
  const builtinSurface = (opts.allowedTools ?? []).filter((t) => !t.startsWith("mcp__"));
  const defaultProviderOptions: ClaudeRuntimeOptions = {
    cwd: opts.cwd?.trim() || config.brainDir,
    model: currentModel(),
    mcpServers: opts.mcpServers,
    canUseTool: opts.canUseTool,
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    ...(builtinSurface.length ? { tools: builtinSurface } : {}),
    // A sub-query gets its own query(), so NEITHER lane's denylist reaches it. Applied here,
    // once, rather than per specialist — that gap is what let the code specialist park on an
    // AskUserQuestion picker nobody can click, and what made every specialist run pay for
    // Workflow's ~4,800-token description.
    disallowedTools: [...new Set([...(opts.disallowedTools ?? []), ...subQueryDisallowedTools(builtinSurface)])],
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    settingSources: ["project"],
    permissionMode: "default",
  };
  const runtime = (opts.runtime ?? claudeTextRuntime) as TextRuntime<ProviderOptions>;
  const providerOptions = (opts.providerOptions ?? defaultProviderOptions) as ProviderOptions;

  const finalText = await runText(runtime, {
    label: `${opts.label} specialist`,
    prompt: opts.prompt,
    signal: opts.signal,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    providerOptions,
  });
  return finalText.trim() || `(no answer from the ${opts.label} specialist)`;
}

// Byte-identical to the local one-liner this module used to define; re-exported from the
// shared wrapper so the public `text` surface (handoff.ts and friends) stays unchanged
// while the definition lives in one place.
export { text } from "../core/toolResult";

// No `defineSpecialistServer` factory: mail and calendar tools are mounted directly and
// deferred behind ToolSearch, which costs a name instead of a schema and keeps fig looking at
// raw tool output rather than a subagent's prose. The specialists that remain (browser, coding,
// jobs) each define their own server, because each one's tool is genuinely different — a shared
// factory for a set of one is just indirection.
