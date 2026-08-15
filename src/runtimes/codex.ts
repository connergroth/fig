import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { config } from "../core/config";
import { log } from "../core/log";
import type { LiveRuntime, LiveTurnResult, TextRuntime, TextRuntimeResult } from "./runtime";
import { fallbackToolNames } from "../tools/fallback";
import { figToolsStdioMcpServer } from "../tools/stdio";
import { recentHistory } from "../session/transcript";
import { summarizeCodexEvent } from "./progress";
import { buildCodexMainInstructions } from "../session/agent";
import { requestApproval } from "../specialists/approval";
import { delegateWorkflow } from "../specialists/delegate";
import { startToolBridge, type ToolBridgeHandle, type ToolBridgeLiveHooks } from "./toolBridge";
import { BRIDGE_SOCKET_FLAG, BRIDGE_TOKEN_FLAG } from "./toolBridgeWire";

/** Blocking fallback (usage-limit path) stays snappy. Async delegated jobs get real headroom. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type CodexMode = "code" | "review";
export type CodexRole = "delegated" | "main";

/** Reasoning depth codex runs at. gpt-5.6 supports these four (no "minimal"); default is medium. */
export type CodexReasoning = "low" | "medium" | "high" | "xhigh";
export const CODEX_REASONING_LEVELS: CodexReasoning[] = ["low", "medium", "high", "xhigh"];

/** Newest/strongest codex model on the owner's account (verified via ~/.codex/models_cache.json). Env-overridable.
 *  gpt-5.6 tiers: sol (flagship) > terra > luna. Needs codex CLI ≥ 0.144. */
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export interface CodexOptions {
  /** External abort (turn signal or a job's controller) — kills the child mid-run. */
  signal?: AbortSignal;
  /** Working root for the run. Defaults to the bot repo; pass another repo (e.g. spot) to work there. */
  cwd?: string;
  /** Extra dirs writable alongside `cwd`. Defaults to every root fig may write in when role is "main". */
  addDirs?: readonly string[];
  /** "code" → can edit files (workspace-write). "review" → read-only third-set-of-eyes, can't touch the tree. */
  mode?: CodexMode;
  /** Main fig agent or a delegated coding specialist. Delegation remains the safe default. */
  role?: CodexRole;
  /** Reasoning depth — bump to high/xhigh for hard tasks. Defaults to CODEX_REASONING env, else medium. */
  reasoning?: CodexReasoning;
  /** Codex model for THIS run (e.g. a cheaper tier for a light lane). Defaults to CODEX_MODEL env, else the flagship. */
  model?: string;
  timeoutMs?: number;
  /** Cheap "what's it doing now" sink — see jobs.ts's `report` / progress.ts. */
  report?: (action: string) => void;
  /**
   * A live tool bridge for this run (main role only). Present → the stdio server proxies every
   * tool call back into THIS process; absent → it executes the reduced fallback set in its own,
   * exactly as delegated jobs always have. Started/closed by the caller, because it has to
   * outlive the output-contract retries and own the run's `toolsUsed`.
   */
  toolBridge?: ToolBridgeHandle;
}

function codexAvailable(): boolean {
  return process.env.CODEX_ENABLED !== "0";
}

function codexCommand(): string {
  return process.env.CODEX_COMMAND?.trim() || "codex";
}

/** Per-run model wins over CODEX_MODEL, which wins over the default tier. Lets a lane pick a
 *  cheaper tier (e.g. a light per-email pass) without mutating process-wide env. */
function codexModelArgs(model?: string): string[] {
  const chosen = model?.trim() || process.env.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
  return ["--model", chosen];
}

function isReasoning(v: string | undefined): v is CodexReasoning {
  return !!v && (CODEX_REASONING_LEVELS as string[]).includes(v);
}

/** `--config model_reasoning_effort="<level>"`. Resolves reasoning → CODEX_REASONING env → medium. */
function codexReasoningArgs(reasoning?: CodexReasoning): string[] {
  const envLevel = process.env.CODEX_REASONING?.trim().toLowerCase();
  const level: CodexReasoning = reasoning ?? (isReasoning(envLevel) ? envLevel : "medium");
  return ["--config", `model_reasoning_effort=${JSON.stringify(level)}`];
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * The ONE `mcp_servers` block codex gets (that constraint is documented at the top of
 * tools/fallback.ts and hasn't changed). When a bridge is running, its endpoint rides in the
 * server's own argv — see toolBridgeWire.ts for why argv rather than env.
 */
export function codexFigToolsArgs(bridge?: ToolBridgeHandle): string[] {
  if (process.env.CODEX_FIG_TOOLS === "0") return [];
  const server = figToolsStdioMcpServer();
  const args = bridge
    ? [...server.args, BRIDGE_SOCKET_FLAG, bridge.socketPath, BRIDGE_TOKEN_FLAG, bridge.token]
    : server.args;
  // A bridged call can park on a 🔐 waiting for the owner to answer on their phone, which is minutes,
  // not seconds. 60s is right for the in-child surface (nothing there can ask them anything) and
  // would time out every single approval on the bridged one.
  const toolTimeoutSec = bridge ? 900 : 60;
  return [
    "--config",
    `mcp_servers.${server.name}.command=${tomlString(server.command)}`,
    "--config",
    `mcp_servers.${server.name}.args=[${args.map(tomlString).join(",")}]`,
    "--config",
    `mcp_servers.${server.name}.default_tools_approval_mode="approve"`,
    "--config",
    `mcp_servers.${server.name}.startup_timeout_sec=20`,
    "--config",
    `mcp_servers.${server.name}.tool_timeout_sec=${toolTimeoutSec}`,
  ];
}

/**
 * `--add-dir` args. Codex sandboxes writes to its working root, so when fig's main brain runs on
 * Codex — working root = the vault — everything else fig legitimately writes (its OWN bot repo
 * above all, plus scratch and the other repos) has to be granted explicitly or fig silently loses
 * the ability to edit itself. Read-only "review" runs get nothing: nothing is writable there.
 * Dropped: the working root itself (already writable) and paths that don't exist (codex errors).
 */
export function codexAddDirArgs(cwd: string, mode: CodexMode, role: CodexRole, addDirs?: readonly string[]): string[] {
  if (mode === "review") return [];
  const requested = addDirs ?? (role === "main" ? config.writableDirs : []);
  const root = path.resolve(cwd);
  const seen = new Set<string>([root]);
  const args: string[] = [];
  for (const dir of requested) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (!fs.existsSync(resolved)) continue;
    args.push("--add-dir", resolved);
  }
  return args;
}

export function buildCodexPrompt(request: string, mode: CodexMode, role: CodexRole, bridged = false): string {
  const figTools = fallbackToolNames();
  const roleLines =
    role === "main"
      ? bridged
        ? [
            // The main-role instructions are fig's own system prompt, which names tools the way
            // the Claude lanes publish them (`mcp__ack__ack`). The bridge is one flat server, so
            // the server key is folded into the name instead. Stating the mapping once is cheaper
            // and more reliable than listing ~50 names here.
            "Your own tools are on the `fig_tools` MCP server, which runs them inside fig's main process. Anywhere your instructions name a tool as `mcp__<server>__<tool>`, call it as `<server>__<tool>` there (e.g. `mcp__ack__ack` → `ack__ack`).",
            "That includes `ack__ack` for the opener: call it first whenever this turn will take more than a beat, exactly as your instructions describe. A tool that needs the owner's approval will block until they answer.",
          ]
        : []
      : mode === "review"
      ? [
          "You are running as a delegated Codex REVIEW specialist — a third set of eyes for the owner's personal agent.",
          "Inspect the code and give concrete, specific feedback: correctness bugs, risks, simpler approaches, what you'd change and why.",
          "You are in a READ-ONLY sandbox — do NOT attempt to edit files. Return findings, not patches.",
          `You may have a fig_tools MCP server with safe personal-assistant tools (${figTools}). Use it when the task needs that context; do not launch deep research or coding delegation from it.`,
        ]
      : [
          "You are running as a delegated Codex coding specialist for the owner's personal agent.",
          "Do the requested repo/code work directly: inspect, edit files, run checks, commit. Keep the final answer concise and factual.",
          `You may have a fig_tools MCP server with safe personal-assistant tools (${figTools}). Use it when the task needs that context; do not launch deep research or coding delegation from it.`,
        ];
  const history = recentHistory();
  return [
    ...roleLines,
    role === "delegated" ? "Do not spend money, operate external accounts, or perform irreversible personal actions." : "",
    "",
    // Same steps the Claude engine gets (delegate.ts owns them) — a workflow that only
    // reached one engine would make the two lanes behave differently on the same task.
    ...(role === "delegated" ? delegateWorkflow(mode) : []),
    history ? `[recent iMessage context, for grounding only]\n${history}\n[end context]\n` : "",
    role === "main" ? "Current message:" : "Task:",
    request,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Run Codex once and return its final message. Blocking by design — used directly as the
 * usage-limit fallback, and wrapped in a background job by the delegate tool. The child is
 * sandboxed to `cwd` (the bot repo by default) and either workspace-write ("code") or
 * read-only ("review").
 */
export async function runCodex(request: string, opts: CodexOptions = {}): Promise<string> {
  if (!codexAvailable()) return "Codex delegation is disabled (CODEX_ENABLED=0).";

  const cwd = opts.cwd?.trim() || config.repoRoot;
  const mode: CodexMode = opts.mode || "code";
  const role: CodexRole = opts.role || "delegated";
  const sandbox = mode === "review" ? "read-only" : "workspace-write";

  const outDir = path.join(config.stateDir, "codex");
  fs.mkdirSync(outDir, { recursive: true });
  const runId = `${Date.now()}-${Math.round(process.hrtime()[1])}`;
  const outFile = path.join(outDir, `last-${runId}.txt`);
  // Codex ships with a coding-agent base prompt. That is correct for delegated jobs, but
  // `/model codex` is fig's MAIN brain and must get the same identity/operating/harness
  // prompt as Claude. model_instructions_file replaces the model-family base instructions
  // for this invocation, while the ordinary stdin prompt below remains the live message.
  const mainInstructionsFile = role === "main" ? path.join(outDir, `main-instructions-${runId}.md`) : undefined;
  if (mainInstructionsFile) {
    fs.writeFileSync(mainInstructionsFile, buildCodexMainInstructions());
  }
  const args = [
    "exec",
    "--ignore-user-config",
    "--cd",
    cwd,
    "--sandbox",
    sandbox,
    ...codexAddDirArgs(cwd, mode, role, opts.addDirs),
    "--skip-git-repo-check",
    // JSONL event stream on stdout (thread/turn/item lifecycle) — parsed below purely for
    // job-board progress (last tool call). --output-last-message still carries the actual
    // final answer, untouched by this.
    "--json",
    "--output-last-message",
    outFile,
    ...(mainInstructionsFile
      ? ["--config", `model_instructions_file=${tomlString(mainInstructionsFile)}`]
      : []),
    ...codexFigToolsArgs(opts.toolBridge),
    ...codexModelArgs(opts.model),
    ...codexReasoningArgs(opts.reasoning),
    "-",
  ];
  const timeoutMs = opts.timeoutMs || Number(process.env.CODEX_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const prompt = buildCodexPrompt(request, mode, role, !!opts.toolBridge);
  const signal = opts.signal;
  const report = opts.report;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(message);
    };
    const child = spawn(codexCommand(), args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    // --json makes stdout a JSONL event stream, one event per line — buffer partial lines
    // across chunks and parse each complete one. Two things come out of it: (1) a progress
    // one-liner fed to `report` on each item.started (see summarizeCodexEvent), and (2) the
    // last agent_message text, kept only as a fallback final answer if --output-last-message
    // somehow can't be read back (normal path ignores it, outFile is authoritative).
    let lineBuffer = "";
    let lastAgentMessage = "";
    let lastUsage: Record<string, unknown> | undefined;
    // IDLE watchdog, not a hard wall-clock cap. `timeoutMs` is the max tolerated silence from
    // the child — refreshed on every stdout/stderr chunk below (the JSONL event stream is the
    // heartbeat), so a Codex run that's actively working keeps going as long as it needs and
    // only a genuinely HUNG child (no output past the window) gets killed. A hard total cap
    // here used to reap long-but-productive delegations mid-run.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish("Codex delegation timed out (no activity).");
    }, timeoutMs);
    // External abort (turn signal via the fallback, or the job's controller) → kill the child so
    // a detached/hung Codex run stops burning tokens instead of running to its own timeout.
    const onAbort = () => {
      child.kill("SIGTERM");
      finish("Codex delegation cancelled.");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (d) => {
      timer.refresh(); // heartbeat: child is streaming → restart the idle countdown
      const chunk = String(d);
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue; // not a JSON line (e.g. the "Reading additional input from stdin..." notice)
        }
        if (report) {
          const summary = summarizeCodexEvent(evt);
          if (summary) report(summary);
        }
        if ((evt as { type?: string }).type === "turn.completed") {
          const usage = (evt as { usage?: Record<string, unknown> }).usage;
          if (usage && typeof usage === "object") lastUsage = usage;
        }
        const item = (evt as { item?: { type?: string; text?: string } }).item;
        if ((evt as { type?: string }).type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          lastAgentMessage = item.text;
        }
      }
    });
    child.stderr.on("data", (d) => {
      timer.refresh(); // heartbeat: any child output counts as activity
      stderr += String(d);
    });
    child.on("error", (e) => {
      finish(`Codex delegation failed to start (${codexCommand()}): ${e.message}`);
    });
    child.on("close", (code) => {
      if (mainInstructionsFile) {
        try {
          fs.unlinkSync(mainInstructionsFile);
        } catch {
          /* best-effort cleanup */
        }
      }
      let final = "";
      try {
        final = fs.readFileSync(outFile, "utf8").trim();
      } catch {
        final = (lastAgentMessage || stdout).trim();
      }
      if (lastUsage) log(`codex usage: ${JSON.stringify(lastUsage)}`);
      if (code === 0 && final) return finish(final);
      const detail = (stderr || stdout).trim();
      finish(`Codex delegation failed${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail.slice(0, 1200)}` : "."}`);
    });
    child.stdin.end(prompt);
  });
}

function codexRunSucceeded(text: string): boolean {
  return !!text && !/^Codex delegation (?:failed|timed out|is disabled|cancelled)/.test(text);
}

export interface CodexRuntimeOptions {
  cwd?: string;
  addDirs?: readonly string[];
  mode?: CodexMode;
  role?: CodexRole;
  reasoning?: CodexReasoning;
  model?: string;
  /**
   * The live turn's plumbing for the tool bridge — set by `codexLiveRuntime` from its own
   * `LiveTurnRun`, never by a caller building a selection. Its absence is what makes a
   * main-role TEXT pass (scheduled/proactive) route approvals through the registered approver
   * instead, exactly like the Claude scheduled lane does.
   */
  liveHooks?: ToolBridgeLiveHooks;
}

/**
 * Start the in-process tool bridge for a MAIN-role run, or return null.
 *
 * Scoped to `role: "main"` deliberately: a delegated codex job has no live turn, so there is
 * nobody to route a 🔐 to and no thread to ack into — handing it fig's full surface would give
 * a background job the ability to send mail with an auto-denied approval it never sees. Those
 * runs keep the reduced in-child surface they've always had.
 */
async function startBridgeFor(run: {
  providerOptions: CodexRuntimeOptions;
  signal?: AbortSignal;
  onProgress?: (action: string) => void;
}): Promise<ToolBridgeHandle | null> {
  if (run.providerOptions.role !== "main") return null;
  const hooks = run.providerOptions.liveHooks;
  return startToolBridge({
    // Lane mirrors the Claude side: a live turn gets the live surface, an unattended pass gets
    // the unattended one (no ack, no live-only servers) — same `exposure` decisions, one source.
    lane: hooks ? "live" : "unattended",
    // No live turn → the registered approver (specialists/approval.ts), which a scheduled pass
    // deliberately leaves null so sensitive actions are denied rather than silently taken.
    askOwner: hooks?.askOwner ?? ((question: string) => requestApproval(question)),
    emit: hooks?.emit,
    tapback: hooks?.tapback,
    onWorkStarted: hooks?.onWorkStarted,
    report: run.onProgress,
    signal: run.signal,
  });
}

export const codexTextRuntime: TextRuntime<CodexRuntimeOptions> = {
  name: "codex",
  async runTextResult(run) {
    // One bridge for the whole run, spanning the output-contract retries below: a tool called on
    // the first attempt was still genuinely called by this pass, which is the same accumulation
    // rule the Claude lane uses for `toolsUsed`.
    const bridge = await startBridgeFor(run);
    try {
      const runOnce = async (prompt: string) => {
        const text = await runCodex(prompt, {
          signal: run.signal,
          timeoutMs: run.timeoutMs,
          report: run.onProgress,
          cwd: run.providerOptions.cwd,
          addDirs: run.providerOptions.addDirs,
          mode: run.providerOptions.mode,
          role: run.providerOptions.role,
          reasoning: run.providerOptions.reasoning,
          model: run.providerOptions.model,
          toolBridge: bridge ?? undefined,
        });
        return { text: text.trim(), ok: codexRunSucceeded(text) };
      };
      // Only the bridge can answer "what did this run actually call" — codex's JSONL stream
      // reports its own built-ins, not which fig capability crossed the socket. Omitted entirely
      // when there's no bridge, since an empty array would read as "called nothing" to the
      // scheduler's required-tools guard and manufacture a fake degradation.
      const withTools = <T extends { text: string; ok: boolean }>(r: T) =>
        bridge ? { ...r, toolsUsed: bridge.toolsUsed() } : r;

      let result = await runOnce(run.prompt);
      if (run.validateOutput && result.ok && result.text && !run.validateOutput.isValid(result.text)) {
        for (let attempt = 1; attempt <= 2 && !run.validateOutput.isValid(result.text); attempt++) {
          const retry = await runOnce(
            `${run.validateOutput.correction}\n\nYour previous output was:\n"""\n${result.text}\n"""`,
          );
          if (!retry.ok || !retry.text) break;
          result = retry;
        }
        if (!run.validateOutput.isValid(result.text)) {
          // Suppressed, but `toolsUsed` still rides along: a suppressed run that skipped a
          // required tool is STILL degraded, and the guard has to see that.
          return withTools({ text: "", ok: true });
        }
      }
      return withTools(result);
    } finally {
      bridge?.close();
    }
  },
};

/** Finish a Codex live run without turning an intentional abort into user-facing error text. */
export async function deliverCodexLiveResult(
  res: TextRuntimeResult,
  signal: AbortSignal,
  emit: (text: string) => Promise<void>,
): Promise<LiveTurnResult> {
  if (signal.aborted) return { ok: false, aborted: true };
  await emit(res.text || "codex fallback didn't return anything.");
  return { ok: res.ok, error: res.ok ? undefined : "codex runtime failed" };
}

export const codexLiveRuntime: LiveRuntime<CodexRuntimeOptions> = {
  name: "codex",
  async runLiveTurn(run) {
    const res = await codexTextRuntime.runTextResult({
      label: "codex live turn",
      prompt: run.prompt,
      signal: run.signal,
      // The live turn's approval/ack/work-start hooks, threaded down so the bridge can execute
      // under them. Before this they arrived on the LiveTurnRun and were dropped on the floor:
      // a codex-run tool that needed a 🔐 had no way to ask, and the ack never reached the owner.
      providerOptions: {
        ...run.providerOptions,
        liveHooks: {
          askOwner: run.askOwner,
          emit: run.emit,
          tapback: run.tapback,
          onWorkStarted: run.onWorkStarted,
        },
      },
    });
    // Stop/correction aborts are control flow, not empty failures. The conversation layer
    // decides whether to discard or fold the exchange; emitting here would create a fake
    // fallback bubble and later trigger its generic "no reply generated" warning.
    return deliverCodexLiveResult(res, run.signal, run.emit);
  },
};
