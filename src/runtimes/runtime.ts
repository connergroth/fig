import type { Approver } from "../specialists/approval";

export interface TextRunValidation {
  isValid: (text: string) => boolean;
  correction: string;
}

export interface TextRuntimeRun<ProviderOptions = unknown> {
  label: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (action: string) => void;
  validateOutput?: TextRunValidation;
  providerOptions: ProviderOptions;
}

export interface TextRuntimeResult {
  text: string;
  ok: boolean;
  /**
   * Why the run failed, verbatim, when `ok` is false. Load-bearing, not diagnostics: a
   * failed pass that swallows its error string is indistinguishable from a transient blip,
   * so nothing downstream can tell "the API is overloaded, retry next tick" apart from
   * "the account is tapped out, switch runtimes". The codex fallback keys off THIS field
   * (see runBrainTextResult) — drop it and the fallback can never fire for a background
   * pass no matter how correct the detector is.
   */
  error?: string;
  /**
   * Distinct TOP-LEVEL tool names the run actually invoked (subagent/specialist-internal
   * calls excluded), in first-call order. This is the observable that distinguishes a
   * scheduled skill that used the tool it structurally depends on from one that silently
   * improvised a workaround — see scheduling/requiredTools.ts. Optional so a runtime that
   * can't report it (the codex/fallback lanes) stays conformant.
   */
  toolsUsed?: string[];
}

export interface TextRuntime<ProviderOptions = unknown> {
  name: string;
  runTextResult(run: TextRuntimeRun<ProviderOptions>): Promise<TextRuntimeResult>;
}

export interface LiveTurnResult {
  ok: boolean;
  aborted?: boolean;
  error?: string;
}

export interface LiveTurnRun<ProviderOptions = unknown> {
  prompt: string;
  providerOptions: ProviderOptions;
  signal: AbortSignal;
  emit: (text: string) => Promise<void>;
  /**
   * React on the owner's latest inbound with one emoji — the `ack({ tapback })` path.
   * False when the lane couldn't react, which makes the ack fall back to a bubble.
   */
  tapback?: (emoji: string) => Promise<boolean>;
  /** `Approver`, so a system-built preview (the rendered card) survives to the transport. */
  askOwner: Approver;
  userInitiated: boolean;
  onWorkStarted?: () => void;
}

export interface LiveRuntime<ProviderOptions = unknown> {
  name: string;
  runLiveTurn(run: LiveTurnRun<ProviderOptions>): Promise<LiveTurnResult>;
}

export async function runText<ProviderOptions>(
  runtime: TextRuntime<ProviderOptions>,
  run: TextRuntimeRun<ProviderOptions>,
): Promise<string> {
  return (await runtime.runTextResult(run)).text;
}
