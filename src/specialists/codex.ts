import { z } from "zod";

import { runCodex, CODEX_REASONING_LEVELS, type CodexReasoning } from "../runtimes/codex";
import { toSdkServer } from "../tools/define";
import { makeDelegateServer } from "./delegate";

/** Max tolerated SILENCE (idle watchdog), not max runtime — see claude-code.ts. */
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

function asReasoning(v: string | undefined): CodexReasoning | undefined {
  return v && (CODEX_REASONING_LEVELS as string[]).includes(v) ? (v as CodexReasoning) : undefined;
}

export const codexServerDef = makeDelegateServer<void>({
  serverName: "codex",
  purpose: "the same delegated coding work on a separate engine (Codex CLI), for an independent second opinion",
  exposure: "live-only",
  reason:
    "same as code — an unattended coding agent editing repos on shared quota; heavy runs are explicit-ask-only",
  mutates: "write",
  jobLabel: "codex",
  toolDescription:
    "Delegate coding work to Codex — a real coding agent with bash/read/write in a sandboxed repo. Two modes: mode='code' (default) lets it edit files and run checks, mode='review' is a READ-ONLY third-set-of-eyes pass that returns feedback without touching the tree. Defaults to this bot's repo; pass cwd to point it at another repo (e.g. ~/GitHub/<repo>). Runs on gpt-5.6 sol (newest); set reasoning to dial depth for the task — 'medium' (default) for routine work, 'high'/'xhigh' for hard debugging, tricky refactors, or subtle logic. Live interactive turns RUN ASYNC: returns a job handle immediately and does NOT block — the result arrives as a follow-up when it finishes, and survives across new messages. Headless scheduled/proactive passes BLOCK and return the real Codex result inline. Don't relay a live-turn handle as the answer. To run several in PARALLEL during live turns, fire multiple delegate calls in one turn — each becomes its own background job; just scope them to non-overlapping files/repos so they don't collide.",
  emoji: "🛠️",
  engineWord: "codex",
  runnerNoun: "job",
  jobTimeoutMs: JOB_TIMEOUT_MS,
  extraArgs: {
    reasoning: z
      .enum(["low", "medium", "high", "xhigh"])
      .optional()
      .describe("codex reasoning depth: low=fast, medium=default, high/xhigh=deeper for hard tasks"),
  },
  prepare: () => undefined,
  run: (request, { signal, mode, cwd, reasoning, timeoutMs, report }) =>
    runCodex(request, { signal, mode, cwd, reasoning: asReasoning(reasoning), timeoutMs, report }),
});

export const codexServer = toSdkServer(codexServerDef);
