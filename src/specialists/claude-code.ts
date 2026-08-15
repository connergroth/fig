import { config } from "../core/config";
import { toSdkServer } from "../tools/define";
import { makeCanUseTool } from "../runtimes/permissions";
import { currentApprover, requestApproval } from "./approval";
import { buildDelegatePrompt, makeDelegateServer, type DelegateMode } from "./delegate";
import { runSpecialist } from "./run";

/**
 * Max tolerated SILENCE, not max runtime — the runtime arms this as an idle
 * watchdog that refreshes on every stream message. A healthy coding job streams
 * text/tool-calls constantly; the only legit quiet gap is a long bash command
 * (full test suite / typecheck / build), which is minutes not many-minutes. So
 * 5m comfortably covers real work and still reaps a genuine hang 3x faster.
 */
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

export type ClaudeCodeMode = DelegateMode;

/** Coding tools the subagent gets. Review is read-only — no Write/Edit/Bash. */
const CODE_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];

export interface ClaudeCodeOptions {
  /** External abort (turn signal or a job's controller) — kills the run mid-flight. */
  signal?: AbortSignal;
  /** Working root for the run. Defaults to the bot repo; pass another repo (e.g. spot) to work there. */
  cwd?: string;
  /** "code" → can edit files + run bash. "review" → read-only feedback, can't touch the tree. */
  mode?: ClaudeCodeMode;
  timeoutMs?: number;
  /** Approver snapshotted at launch — async jobs outlive their turn, so the per-turn approver
   * is gone by the time a 🔐 fires. Falls back to requestApproval (live global) if not passed. */
  approver?: (question: string) => Promise<boolean>;
  /** Cheap "what's it doing now" sink — see jobs.ts's `report` / progress.ts. */
  report?: (action: string) => void;
}

function buildPrompt(request: string, mode: ClaudeCodeMode): string {
  const role =
    mode === "review"
      ? [
          "You are running as a delegated Claude REVIEW subagent — a second set of eyes for the owner's personal agent.",
          "Inspect the code and give concrete, specific feedback: correctness bugs, risks, simpler approaches, what you'd change and why.",
          "You are READ-ONLY — do NOT edit files or run mutating commands. Return findings, not patches.",
        ]
      : [
          "You are running as a delegated Claude coding subagent for the owner's personal agent.",
          "Do the requested repo/code work directly: inspect, edit files, run checks, commit. Keep the final answer concise and factual.",
        ];
  return buildDelegatePrompt(request, role, mode);
}

/**
 * Run a Claude coding subagent once and return its final message. Mirrors `runCodex`
 * but on the Claude Agent SDK (via runSpecialist) instead of the Codex CLI — this is
 * the DEFAULT coding-delegation engine, with codex as the alternate engine. Scoped to
 * `cwd` (the bot repo by default) with the built-in coding tools, and either
 * read/write ("code") or read-only ("review").
 */
export async function runClaudeCode(request: string, opts: ClaudeCodeOptions = {}): Promise<string> {
  const cwd = opts.cwd?.trim() || config.repoRoot;
  const mode: ClaudeCodeMode = opts.mode || "code";
  return runSpecialist({
    label: mode === "review" ? "claude-review" : "claude-code",
    prompt: buildPrompt(request, mode),
    cwd,
    mcpServers: {},
    allowedTools: mode === "review" ? REVIEW_TOOLS : CODE_TOOLS,
    canUseTool: makeCanUseTool(opts.approver ?? requestApproval),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs || JOB_TIMEOUT_MS,
    ...(opts.report ? { onProgress: opts.report } : {}),
  });
}

export const claudeCodeServerDef = makeDelegateServer<(question: string) => Promise<boolean>>({
  serverName: "code",
  purpose: "delegate coding work to a Claude subagent with real read/write/edit/bash in a repo",
  exposure: "live-only",
  reason:
    "spawns an unattended coding agent that edits repos and burns the owner's shared Claude quota; heavy runs are explicit-ask-only",
  mutates: "write",
  jobLabel: "claude-code",
  toolDescription:
    "Delegate coding work to a Claude subagent — a real coding agent with read/write/edit/bash/grep/glob in a repo. THIS IS THE DEFAULT coding-delegation engine (use the codex tool instead only when you want a separate engine for a second opinion or to spread usage off Claude). Two modes: mode='code' (default) lets it edit files and run checks, mode='review' is a READ-ONLY second-set-of-eyes pass that returns feedback without touching the tree. Defaults to this bot's repo; pass cwd to point it at another repo (e.g. ~/GitHub/<repo>). Live interactive turns RUN ASYNC: returns a job handle immediately and does NOT block — the result arrives as a follow-up when it finishes, and survives across new messages. Headless scheduled/proactive passes BLOCK and return the real subagent result inline. Don't relay a live-turn handle as the answer. To run several in PARALLEL during live turns, fire multiple delegate calls in one turn — each becomes its own background job; just scope them to non-overlapping files/repos so they don't collide.",
  emoji: "🧠",
  engineWord: "claude",
  runnerNoun: "subagent",
  jobTimeoutMs: JOB_TIMEOUT_MS,
  // Snapshot the approver in-turn (see ClaudeCodeOptions.approver) so an async code
  // job that needs a 🔐 after the turn ends still reaches the owner instead of auto-denying.
  prepare: () => currentApprover() ?? (async () => false),
  run: (request, { signal, mode, cwd, timeoutMs, report }, approver) =>
    runClaudeCode(request, { signal, mode, cwd, timeoutMs, approver, report }),
});

export const claudeCodeServer = toSdkServer(claudeCodeServerDef);
