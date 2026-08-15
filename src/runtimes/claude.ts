import { type Options, query } from "@anthropic-ai/claude-agent-sdk";

import { warn } from "../core/log";
import { freshInstances } from "./mcpInstances";
import { summarizeToolUse } from "./progress";
import type { TextRuntime, TextRuntimeResult, TextRunValidation } from "./runtime";
import { toWellFormedUnicode } from "../core/unicode";

export interface ClaudeTextRun {
  label: string;
  prompt: string;
  options: Options;
  /** External abort (e.g. the turn's signal threaded down via detachable) — cancels the run on stop. */
  signal?: AbortSignal;
  /** Per-run runaway cap. Overrides CLAUDE_TEXT_TIMEOUT_MS — long background jobs (browser) need more headroom. */
  timeoutMs?: number;
  /**
   * Cheap "what's it doing right now" sink — fired with a short one-liner each time the
   * run's top-level assistant message makes a tool call. See progress.ts for
   * the summarizer; this is the hook point since tool_use blocks were already being
   * iterated here (just to find text), nothing new to stream.
   */
  onProgress?: (action: string) => void;
  /**
   * PROACTIVE/SCHEDULED runs only — never set for live replies. When present, the final
   * text is validated against the output contract; if it's malformed (unwrapped prose,
   * the narration-leak case) the SAME pass is re-prompted with `correction` up to twice.
   * If it's still malformed, the text is SUPPRESSED (returned as "") and logged loudly —
   * we never deliver raw, unwrapped text. Live replies omit this and are untouched.
   */
  validateOutput?: {
    isValid: (text: string) => boolean;
    correction: string;
  };
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Tool names in one assistant message, counting ONLY the run's own top-level calls.
 *
 * A message carrying `parent_tool_use_id` is a nested subagent/specialist call, and those
 * must not count: the whole point of the scheduler's required-tools guard is "did THIS pass
 * delegate to the specialist", and a specialist's own internal gmail calls would answer a
 * different question. Exported for tests — the exclusion is the part that's easy to get
 * silently wrong, and getting it wrong makes the guard read as satisfied when it isn't.
 */
export function topLevelToolNames(msg: unknown): string[] {
  const m = msg as any;
  if (!m || m.type !== "assistant" || m.parent_tool_use_id) return [];
  const blocks = m.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b: any) => b?.type === "tool_use" && typeof b.name === "string" && b.name)
    .map((b: any) => b.name as string);
}

/** Result of a text run that distinguishes a clean completion from a failed/aborted one. */
export interface ClaudeTextResult extends TextRuntimeResult {
  /** Final text (trimmed); "" if the pass produced none or failed. */
  text: string;
  /**
   * True iff the run reached a normal completion (the query iterator drained without
   * throwing and the SDK didn't report an error result). False on abort, timeout, or
   * any error — i.e. "" text with ok:false means the pass FAILED, vs "" with ok:true
   * means it ran fine and chose to say nothing. Callers that fire-once-per-slot (the
   * scheduler) use this to avoid burning the slot on a transient failure.
   */
  ok: boolean;
}

export type ClaudeRuntimeOptions = Options;

export interface ClaudeRuntimeRun {
  label: string;
  prompt: string;
  providerOptions: ClaudeRuntimeOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (action: string) => void;
  validateOutput?: TextRunValidation;
}

/**
 * Run a scoped Claude pass and report BOTH the final text and whether the run
 * actually completed. This is the source of truth; `runClaudeText` is the thin
 * text-only wrapper over it for callers that don't care about failure vs quiet.
 */
export async function runClaudeTextResult({ label, prompt, options, signal, timeoutMs: timeoutOverride, validateOutput, onProgress }: ClaudeTextRun): Promise<ClaudeTextResult> {
  const timeoutMs = timeoutOverride ?? Number(process.env.CLAUDE_TEXT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  // Every TOP-LEVEL tool this pass invokes, in first-call order. Accumulated across the
  // output-contract correction retries below, since a tool called on the first attempt was
  // still genuinely called by this pass. Consumed by the scheduler's required-tools guard
  // (scheduling/requiredTools.ts): "the run never called the tool it depends on" is the one
  // signal that reliably separates a real scheduled run from one that improvised around a
  // missing tool. Cheap — we already walk every content block here for text/progress.
  const toolsUsed = new Set<string>();

  // One Claude pass for a single prompt. Funnels BOTH abort sources into the query: the
  // internal runaway timeout, and the external signal (the turn's abort, threaded down so
  // "stop" can kill a detached/hung specialist mid-call instead of letting it run on).
  async function runOnce(p: string): Promise<ClaudeTextResult> {
    let finalText = "";
    let timedOut = false;
    let errored = false;
    // Why this pass failed, verbatim. Load-bearing, not diagnostics: `runBrainTextResult`'s
    // codex fallback keys off the `error` field of the result, so every failure path here MUST
    // populate it. Returning a bare {ok:false} makes an exhausted account indistinguishable
    // from a transient blip and the background fallback can never fire.
    let errorText: string | undefined;
    const timeout = new AbortController();
    // IDLE watchdog, not a hard wall-clock cap. `timeoutMs` is the max time we tolerate with
    // NO activity from the run — it's refreshed on every stream message below, so a run that's
    // actively producing assistant text / tool calls keeps going as long as it needs, and only
    // a genuinely HUNG run (silent past the window) gets reaped. A hard total cap here used to
    // kill long-but-productive jobs (e.g. a multi-file coding delegate) mid-tool-call.
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, timeoutMs);
    const onAbort = () => timeout.abort();
    if (signal) {
      if (signal.aborted) timeout.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // Mount = clone. An in-process MCP server instance can be held by exactly ONE open
      // query; hand a second query the same instance and it silently gets zero MCP tools.
      // Doing it HERE, at the one place every runtime-driven query is actually created, is
      // what makes that impossible to forget — callers pass module-level `xServer` singletons
      // from object literals all over the codebase (specialists, triage, research), and
      // patching each site would have held only until the next one. See runtimes/mcpInstances.
      const systemPrompt = options.systemPrompt;
      const safeSystemPrompt =
        typeof systemPrompt === "string"
          ? toWellFormedUnicode(systemPrompt)
          : Array.isArray(systemPrompt)
            ? systemPrompt.map(toWellFormedUnicode)
            : systemPrompt?.append
              ? { ...systemPrompt, append: toWellFormedUnicode(systemPrompt.append) }
              : systemPrompt;
      const response = query({
        prompt: toWellFormedUnicode(p),
        options: {
          ...options,
          ...(safeSystemPrompt ? { systemPrompt: safeSystemPrompt } : {}),
          ...(options.mcpServers ? { mcpServers: freshInstances(options.mcpServers as any) } : {}),
          abortController: timeout,
        },
      });
      for await (const msg of response) {
        // Heartbeat: any message means the run is alive and working — restart the idle
        // countdown from now, so the timeout only ever fires on a true silence gap.
        timer.refresh();
        if (msg.type === "assistant") {
          if ((msg as any).parent_tool_use_id) continue;
          for (const name of topLevelToolNames(msg)) toolsUsed.add(name);
          for (const block of (msg as any).message?.content ?? []) {
            if (block.type === "text" && block.text.trim()) finalText = block.text;
            else if (block.type === "tool_use" && onProgress) {
              try {
                onProgress(summarizeToolUse(block.name, block.input));
              } catch {
                /* progress reporting is best-effort, never worth failing the run over */
              }
            }
          }
        } else if (msg.type === "result") {
          const r = (msg as any).result;
          if (typeof r === "string" && r.trim()) finalText = r;
          // The SDK reports a terminal error (e.g. exhausted retries on a 529) via the
          // result subtype / is_error flag rather than throwing — treat that as a failed pass.
          if ((msg as any).is_error || /^error/.test((msg as any).subtype ?? "")) {
            errored = true;
            // The SDK puts the reason in `result` on an error result, so `finalText` above
            // already holds it. Keep the subtype as a floor so `error` is never empty.
            errorText = (typeof r === "string" && r.trim() ? r : (msg as any).subtype) || "claude run returned is_error";
          }
        }
      }
    } catch (e) {
      const why = timedOut ? ` after ${timeoutMs}ms of inactivity` : timeout.signal.aborted ? " (cancelled)" : "";
      warn(`${label} failed${why}: ${e}`);
      return { text: "", ok: false, error: `${e}${why}` };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (isProviderExhaustion(finalText)) {
      warn(`${label} hit provider exhaustion: ${finalText.slice(0, 160)}`);
      return { text: "", ok: false, error: finalText };
    }
    return { text: finalText.trim(), ok: !errored, ...(errored ? { error: errorText } : {}) };
  }

  let result = await runOnce(prompt);

  // Proactive/scheduled output-contract enforcement. Only when the pass actually completed
  // with text — a failed/empty pass is left for the caller's retry-next-tick (and "" is not
  // a leak). If the text is malformed (unwrapped prose), re-prompt with a terse correction
  // up to twice; if still malformed, SUPPRESS rather than deliver raw narration.
  if (validateOutput && result.ok && result.text && !validateOutput.isValid(result.text)) {
    for (let attempt = 1; attempt <= 2 && !validateOutput.isValid(result.text); attempt++) {
      const correctionPrompt = `${validateOutput.correction}\n\nYour previous output was:\n"""\n${result.text}\n"""`;
      const retry = await runOnce(correctionPrompt);
      if (!retry.ok || !retry.text) break; // transient failure — stop retrying, fall to suppression
      result = retry;
    }
    if (!validateOutput.isValid(result.text)) {
      console.error(
        `[OUTPUT-CONTRACT VIOLATION] ${label}: proactive pass produced malformed (unwrapped) output ` +
          `after 2 correction attempts — SUPPRESSING so it can't leak into the thread. ` +
          `Offending text (first 600 chars): ${result.text.slice(0, 600)}`,
      );
      // ok:true → slot consumed (quiet), but nothing sent. toolsUsed still rides along: a
      // suppressed run that skipped a required tool is STILL a degraded run, and the
      // scheduler's guard has to see that rather than reading the silence as a clean no-op.
      return { text: "", ok: true, toolsUsed: [...toolsUsed] };
    }
  }

  return { ...result, toolsUsed: [...toolsUsed] };
}

/**
 * Shared Claude Agent SDK text runner for scoped/background passes. The live chat
 * loop still owns opener/final streaming, but specialist-style runs all want the
 * same behavior: ignore intermediate chatter and return the final result text.
 */
export async function runClaudeText(run: ClaudeTextRun): Promise<string> {
  return (await runClaudeTextResult(run)).text;
}

export const claudeTextRuntime: TextRuntime<ClaudeRuntimeOptions> = {
  name: "claude",
  runTextResult: (run) =>
    runClaudeTextResult({
      label: run.label,
      prompt: run.prompt,
      options: run.providerOptions,
      signal: run.signal,
      timeoutMs: run.timeoutMs,
      onProgress: run.onProgress,
      validateOutput: run.validateOutput,
    }),
};

/**
 * Turn an SDK message's coarse tag plus whatever error payload it carries into ONE
 * string that still contains the provider's own words.
 *
 * Why this exists: a failed turn's `result` message reports a bucket in `subtype`
 * (`error_during_execution`, `error_max_turns`) while the sentence that actually names
 * the failure ("You've hit your session limit · resets 2:50pm") rides in `result` /
 * `error`. Capturing the tag alone discards that sentence, and every downstream
 * predicate here — `isProviderExhaustion`, `isOverload` — is a TEXT match against the
 * provider's phrasing. Starve them of the text and they answer false, so an exhausted
 * account looks like a generic failed turn and the codex fallback never fires.
 *
 * Keep the tag (it's what makes logs greppable) and append the first readable detail.
 */
export function describeSdkError(tag: string, ...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const detail = readableError(candidate);
    if (detail) return `${tag}: ${detail}`;
  }
  return tag;
}

/** Best-effort human text out of a string | Error | {message} | arbitrary object. */
function readableError(value: unknown): string | undefined {
  const cap = (s: string): string | undefined => {
    const t = s.trim();
    return t ? t.slice(0, 500) : undefined;
  };
  if (typeof value === "string") return cap(value);
  if (value instanceof Error) return cap(value.message);
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      const m = cap(message);
      if (m) return m;
    }
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" && json !== "null" ? cap(json) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isProviderExhaustion(error: string | undefined): boolean {
  // Anchor on the ACTUAL terminal messages the account prints when it's tapped out,
  // not loose "usage/limit" soup that would eat fig's own prose.
  return (
    !!error &&
    /(monthly\s+spend\s+limit|claude\.ai\/settings\/usage|you(?:'|’)ve\s+hit\s+your\s+session\s+limit|you(?:'|’)re\s+out\s+of\s+usage\s+credits|out\s+of\s+usage\s+credits)/i.test(
      error,
    )
  );
}

/**
 * Same exhaustion sniff, but for text fig is about to DELIVER (assistant/result text),
 * not for raw SDK error strings. A real exhaustion notice surfaced as text is a terse raw
 * dump; fig's substantive replies are long prose. A long reply that merely quotes the
 * spend-limit phrase or settings URL (e.g. fig explaining its own fallback code) must not
 * be swallowed as a fake provider error, so only treat delivered text as exhaustion when
 * it's short enough to be a raw error string. Misclassifying a long error as non-exhaustion
 * just shows the user the raw text (recoverable); misclassifying a real reply as an error
 * eats the answer.
 */
export function deliveredTextIsExhaustion(text: string | undefined): boolean {
  return !!text && text.trim().length <= 400 && isProviderExhaustion(text);
}
