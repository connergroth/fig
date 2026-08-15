import { config } from "../core/config";
import { currentCodexReasoning, currentModelRuntime, type ModelRuntime } from "../core/model";
import type { ClaudeRuntimeOptions } from "./claude";
import { codexLiveRuntime, codexTextRuntime, type CodexRuntimeOptions } from "./codex";
import type { LiveRuntime, TextRuntime } from "./runtime";

export type RuntimeProviderOptions = ClaudeRuntimeOptions | CodexRuntimeOptions;

export interface RuntimeSelection {
  runtime: TextRuntime<any>;
  providerOptions: RuntimeProviderOptions;
  name: ModelRuntime;
}

export interface LiveRuntimeSelection {
  runtime: LiveRuntime<any>;
  providerOptions: RuntimeProviderOptions;
  name: ModelRuntime;
}

export function codexRuntimeSelection(): RuntimeSelection {
  return {
    name: "codex",
    runtime: codexTextRuntime,
    providerOptions: {
      // Vault as the working root (fig's home), with every other root fig may write in —
      // the bot repo included — granted alongside it. See codexAddDirArgs: a vault-only
      // sandbox is what made main Codex unable to edit its own runtime.
      cwd: config.brainDir,
      addDirs: config.writableDirs,
      role: "main",
      reasoning: currentCodexReasoning(),
    },
  };
}

export function codexLiveRuntimeSelection(): LiveRuntimeSelection {
  return {
    name: "codex",
    runtime: codexLiveRuntime,
    providerOptions: {
      // Vault as the working root (fig's home), with every other root fig may write in —
      // the bot repo included — granted alongside it. See codexAddDirArgs: a vault-only
      // sandbox is what made main Codex unable to edit its own runtime.
      cwd: config.brainDir,
      addDirs: config.writableDirs,
      role: "main",
      reasoning: currentCodexReasoning(),
    },
  };
}

/**
 * The runtime selected for top-level fig turns outside the serial conversation loop
 * (for example `/bg`). Claude returns null because those lanes already own their native
 * Agent SDK orchestration; a Codex selection must replace that path rather than quietly
 * falling back to Claude.
 *
 * Deliberately not used by delegated specialists: `/model` chooses fig's brain, not the
 * model behind independently configured subagents.
 */
export function selectedLiveRuntimeSelection(): LiveRuntimeSelection | null {
  return currentModelRuntime() === "codex" ? codexLiveRuntimeSelection() : null;
}

/** Text-only counterpart for top-level scheduled/proactive fig passes. */
export function selectedTextRuntimeSelection(): RuntimeSelection | null {
  return currentModelRuntime() === "codex" ? codexRuntimeSelection() : null;
}
