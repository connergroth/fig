import { z } from "zod";

import { isHeadlessAgentPass } from "../core/agentPassContext";
import { defineServer, type Exposure, type Mutates } from "../tools/define";
import { recentHistory } from "../session/transcript";
import { launchJob } from "./jobs";

/**
 * Shared scaffolding for the two coding-delegation engines (Claude subagent + Codex CLI).
 * They are the same contract — a `delegate` tool with the same args schema, a prompt
 * assembled the same way (role lines → guardrail → iMessage context → task), and the same
 * "launched async, here's the job board" return string — differing only by engine wording
 * and the actual runner. Factoring it here means a future contract tweak is made once.
 */

export type DelegateMode = "code" | "review";

/**
 * The WORKFLOW every delegated run walks — the same steps, every job, both engines.
 *
 * This is the difference between prompting an agent and running a process: without it,
 * consistency is a function of how carefully the orchestrator worded THAT request, so
 * whether a job ran the tests or left a half-written test file in the tree is luck. The
 * steps live here rather than in a repo doc because a doc only reaches the engine that
 * reads it (`CLAUDE.md` for Claude, `AGENTS.md` for Codex) in the repo that has one; this
 * reaches both engines in every repo. Repo-SPECIFIC conventions (which commands to run,
 * commit style, what's off-limits) belong in that repo's doc — not here.
 */
export function delegateWorkflow(mode: DelegateMode): string[] {
  if (mode === "review") {
    return [
      "Walk these steps every run:",
      "1. ORIENT — read the code before judging it. Read the files in scope plus their tests and callers; treat the task description as a claim to verify, not ground truth.",
      "2. VERIFY — check the claims you're about to make against the actual source. Don't report a bug you haven't located in a specific file and line.",
      "3. REPORT — findings ordered by severity, each with file:line, why it's wrong, and the concrete fix. Say plainly when something is fine. No patches, no edits.",
    ];
  }
  return [
    "Walk these steps every run, in order:",
    "1. ORIENT — read the files you're about to change plus their existing tests, and check the repo's own conventions doc (CLAUDE.md / AGENTS.md) if it has one. Treat the task description as a claim to verify, not ground truth.",
    "2. CHANGE — the smallest edit that actually does the job. Match the surrounding style. Don't refactor or reformat code the task didn't ask about.",
    "3. TEST — run the repo's typecheck and test suite (infer the commands from package.json / the conventions doc). Add or extend a test whenever you change behavior.",
    "4. GREEN — the tree you leave behind must be green and complete: no half-written test file, no broken import, no debug logging, no commented-out code. If you cannot get it green, stop, revert what you can't finish, and say so — do NOT report success.",
    "5. COMMIT — one focused commit in the repo's existing style (read `git log` for it). Commit only files this task touched; never `git push`, never rewrite history, never revert or amend someone else's work.",
    "6. REPORT — concise and factual: what changed (files + commit subject), exactly which checks you ran and their results, what you deliberately did NOT touch, and anything still uncertain or unverified. State failures and gaps plainly; do not sell the work.",
  ];
}

/**
 * Assemble a delegation prompt. Structure is identical across engines; only the leading
 * `role` lines differ (engine name + read-only wording), so they're passed in pre-resolved.
 */
export function buildDelegatePrompt(request: string, role: string[], mode: DelegateMode = "code"): string {
  const history = recentHistory();
  return [
    ...role,
    "Do not spend money, operate external accounts, or perform irreversible personal actions.",
    "",
    ...delegateWorkflow(mode),
    "",
    history ? `[recent iMessage context, for grounding only]\n${history}\n[end context]\n` : "",
    "Task:",
    request,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The delegate tool's base arg schema — shared by both engines. Engines may add `extraArgs`. */
const delegateArgs = {
  request: z.string().describe("the complete coding or review task, including files/constraints if known"),
  mode: z
    .enum(["code", "review"])
    .optional()
    .describe("'code' (default) = can edit files; 'review' = read-only feedback pass"),
  cwd: z.string().optional().describe("absolute path to the repo to work in; defaults to the bot repo"),
};

/**
 * Build a coding-delegation MCP server (one async `delegate` tool wrapping `launchJob`).
 *
 * Parameterized by engine: the server/job naming, the cosmetic wording in the launched-job
 * return string, and the actual `run` callback. `prepare()` runs SYNCHRONOUSLY in-turn (its
 * value is threaded into the async `run`) — that's how the Claude engine snapshots the live
 * approver before the turn unwinds; engines that don't need it return nothing.
 */
export function makeDelegateServer<Ctx>(engine: {
  /** MCP server name, e.g. "code" / "codex". */
  serverName: string;
  /** One line: what this engine owns. Becomes the server's and its tool's `purpose`. */
  purpose: string;
  /** Which orchestrator lanes may mount this engine. */
  exposure: Exposure;
  /** Why it isn't in every lane. Required whenever `exposure` isn't "both". */
  reason?: string;
  /** Does the job it launches change anything outside fig? */
  mutates: Mutates;
  /** launchJob label, e.g. "claude-code" / "codex". */
  jobLabel: string;
  /** The `delegate` tool's description. */
  toolDescription: string;
  /** Leading glyph in the return string, e.g. "🧠" / "🛠️". */
  emoji: string;
  /** Engine word in the return string, e.g. "claude" / "codex". */
  engineWord: string;
  /** Noun for the launched unit, e.g. "subagent" / "job". */
  runnerNoun: string;
  /** Per-job runaway cap (ms). */
  jobTimeoutMs: number;
  /** Optional engine-specific args merged into the tool schema (e.g. codex's `reasoning`). */
  extraArgs?: z.ZodRawShape;
  /** Runs in-turn, synchronously, before the job is launched; its result is passed to `run`. */
  prepare: () => Ctx;
  /** The actual engine run, executed inside the background job. */
  run: (
    request: string,
    opts: {
      signal: AbortSignal;
      mode?: DelegateMode;
      cwd?: string;
      /** Engine-specific extras from `extraArgs` (e.g. codex `reasoning`). */
      reasoning?: string;
      timeoutMs: number;
      /** Cheap "what's it doing now" sink — see jobs.ts's `report` / progress.ts. */
      report: (action: string) => void;
    },
    ctx: Ctx,
  ) => Promise<string>;
}) {
  const schema = { ...delegateArgs, ...(engine.extraArgs ?? {}) };
  return defineServer({
    key: engine.serverName,
    kind: "specialist",
    purpose: engine.purpose,
    exposure: engine.exposure,
    ...(engine.reason ? { reason: engine.reason } : {}),
    capabilities: [
      {
        name: "delegate",
        purpose: engine.purpose,
        description: engine.toolDescription,
        input: schema,
        mutates: engine.mutates,
        handler: async (args) => {
          // Snapshot in-turn context (e.g. the Claude approver) BEFORE launchJob's async run,
          // so an async job that needs a 🔐 after the turn ends still reaches the owner.
          const ctx = engine.prepare();
          const reasoning = (args as { reasoning?: string }).reasoning;
          if (isHeadlessAgentPass()) {
            return await engine.run(
              args.request,
              {
                signal: new AbortController().signal,
                mode: args.mode,
                cwd: args.cwd,
                reasoning,
                timeoutMs: engine.jobTimeoutMs,
                report: () => {},
              },
              ctx,
            );
          }
          const job = launchJob({
            label: engine.jobLabel,
            task: args.request,
            run: (signal, report) =>
              engine.run(
                args.request,
                { signal, mode: args.mode, cwd: args.cwd, reasoning, timeoutMs: engine.jobTimeoutMs, report },
                ctx,
              ),
          });
          const where = args.cwd ? ` in ${args.cwd}` : "";
          return (
            `${engine.emoji} ${engine.engineWord} ${args.mode === "review" ? "review" : "coding"} ${engine.runnerNoun} launched in the background (id: ${job.id})${where}. it's running detached — this turn is NOT blocked and the job survives your next messages. ` +
            `its result arrives as a follow-up when it finishes. THIS IS NOT THE ANSWER — don't relay it as if the work is done; just let the owner know you're on it (or carry on), and you'll be pinged when it lands.\n\n` +
            `meanwhile, the unified job board: mcp__jobs__list lists all running jobs, mcp__jobs__check (id: ${job.id}) reads its status/result, mcp__jobs__cancel (id: ${job.id}) aborts it.`
          );
        },
      },
    ],
  });
}
