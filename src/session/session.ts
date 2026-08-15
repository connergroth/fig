import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildMessagePreamble, buildSystemPrompt, loadSession, setSession } from "./agent";
import {
  approvalBody,
  approvalIdIn,
  APPROVAL_TIMEOUT_MS,
  expiryNotice,
  lateDecisionNotice,
  matchExpired,
  nextApprovalId,
  noteExpired,
  resolveApprovalImage,
} from "./approvalPrompt";
import { buildWorkingState } from "./compaction";
import { ensureWarmReady, resetWarmSession, runWarmTurn, warmSessionEnabled } from "./warmSession";
import { isSilence, SILENCE_TOKEN, sleep } from "../render/chunking";
import { deliverReply, deliverTapback, withQueuedContext, withReplyContext } from "../render/deliver";
import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { currentModel, currentModelRuntime, resolveModelCommand } from "../core/model";
import { resolvePromptCommand } from "../core/prompt";
import { log, warn } from "../core/log";
import {
  audioMessageHint,
  audioNoteTranscriptBlock,
  partitionAudioNotes,
  videoLinkHints,
  type AudioNoteTranscript,
} from "../render/media-hints";
import { transcribeAudioNotes } from "../stt/transcribe";
import { makeCanUseTool } from "../runtimes/permissions";
import { SURFACE_HOOKS } from "../runtimes/hooks";
import { buildFigMcpServers, disallowedToolsForLane } from "../scheduling/lane";
import { noteTurnAndMaybeReconcile } from "../scheduling/reconcile";
import { resolveSlash } from "../core/slash";
import { resolveVoiceCommand, voiceModeHint } from "../core/voiceMode";
import { isUsageCommand, runUsageCommand } from "../usage/slash";
import { spotLane } from "../spot/lane";
import { setApprover, type ApprovalPrompt, type Approver } from "../specialists/approval";
import { fileAttachmentOpts } from "../image/sink";
import { cancelAllDetached, setBackgroundInjector, setTurnSignal } from "../specialists/detach";
import { cancelAllJobs } from "../specialists/jobs";
import {
  discardUndeliveredJobResults,
  markJobResultDelivered,
  restoreJobResultUndelivered,
} from "../specialists/jobResults";
import { deliveredTextIsExhaustion, describeSdkError, isProviderExhaustion } from "../runtimes/claude";
import { clearCodexFallback, codexFallbackActive, markCodexFallbackActive } from "../runtimes/fallback";
import { codexLiveRuntimeSelection } from "../runtimes/registry";
import { recentHistory } from "./transcript";
import { deliverAck } from "../ack/deliver";
import { ACK_TOOL_NAME } from "../ack/tools";
import type { Transport } from "../transport";
import { toWellFormedUnicode, toWellFormedUnicodeList } from "../core/unicode";
import type { LiveTurnResult } from "../runtimes/runtime";

/** How long to wait for more messages before processing — bundles rapid-fire texts into one turn. */
const BUNDLE_MS = Number(process.env.BUNDLE_MS || 2500);

// Tools that deliver a user-facing payload straight to the owner (bypassing `emit`, so they
// never bump `sent`). A turn whose only output is one of these is still a complete turn, not
// a silent death — used by the failure check at the end of runTurn now that the auto-👍
// backstop (which used to bump `sent` for these) is gone.
const USER_DELIVERING_TOOLS = new Set([
  "mcp__image__generate",
  "mcp__image__send_file",
  "mcp__image__send_carousel",
]);

// SILENCE_TOKEN + isSilence now live in render/chunking.ts (shared with the transport-level
// backstop in transport/index.ts and the scheduler/reconcile quiet-output checks) — see the
// tapbacks rule in agent.ts for how fig is told to use SILENCE_TOKEN.

/**
 * True when the inbound is JUST a tapback notification from the relay and nothing else
 * (e.g. `[Reacted 👍 to "..."]` / `[Removed ❤️ reaction to "..."]`). Used to inject a
 * "you usually don't need to reply" nudge only when it's relevant, rather than carrying
 * it in the static prompt every turn. A reaction bundled with real text won't match.
 */
const isBareReaction = (t: string): boolean => /^\[(?:Reacted|Removed)\b.*\]$/.test(t.trim());

/**
 * Model fallback chain. A 529/5xx/overload is capacity pressure, and it's very often
 * per-model — so a same-model retry hits the same wall while hopping models gets
 * through. We try the primary (config.model) a couple times, then fall DOWN the chain
 * to progressively lighter/less-loaded models. All entries are 1M-context so long
 * sessions don't break on the drop. Fable is deliberately excluded (different API shape
 * — thinking-always-on + refusal handling — that we don't want to deal with mid-outage).
 * Only kicks in when nothing's been delivered yet (sent===0); once an opener is on
 * The owner's screen a retry would double-send, so we never fall back past that point.
 */
const PRIMARY_ATTEMPTS = Math.max(1, Number(process.env.MODEL_PRIMARY_ATTEMPTS || 2));
const MODEL_FALLBACKS = (process.env.MODEL_FALLBACKS || "claude-sonnet-5,claude-opus-4-7")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Extended thinking is pinned ON for every main-loop turn (fixed budget, not adaptive).
 * Two reasons, in order: (1) best-performance — the owner wants reasoning burned on every
 * turn regardless of token cost; (2) it fixes the reasoning-text leak. The reply pipeline
 * already discards thinking blocks, but with `adaptive` the model is free to skip a
 * block on a short turn and narrate its reasoning as plain text instead — on a no-tool
 * turn there's no post-tool buffer reset, so that stray text rode along as the final
 * bubble (the "they already said it..." leak). Forcing `enabled` means reasoning ALWAYS
 * lands in a thinking block we already filter out, so it structurally can't leak.
 * Budget is generous by design. Tune the "reasoning amount" with the THINKING_BUDGET
 * env var — it accepts EITHER a named level (low·medium·high·xhigh·max, the same knob
 * shape as `/model codex <effort>` and Claude Code's effort levels) OR a raw token
 * integer. Named levels map to the budgets below; a positive integer is used verbatim
 * (floored at the SDK's 1024 minimum); anything unrecognized falls back to `high`.
 * Whatever the input, it resolves to ONE budgetTokens number so thinking stays `enabled`
 * (the structural leak fix) rather than switching to adaptive+effort, which would let the
 * model skip a thinking block on a short turn and reintroduce the leak.
 */

/** Named reasoning levels → thinking-token budgets. `high` (16000) is the default. */
export const THINKING_EFFORT_BUDGETS: Record<string, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 48000,
};

function resolveThinkingBudget(): number {
  const raw = (process.env.THINKING_BUDGET || "").trim().toLowerCase();
  if (!raw) return THINKING_EFFORT_BUDGETS.high;
  if (raw in THINKING_EFFORT_BUDGETS) return THINKING_EFFORT_BUDGETS[raw];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1024, Math.floor(n)) : THINKING_EFFORT_BUDGETS.high;
}

/** Per-turn extended-thinking budget for the main loop (and the shared /btw lane). */
export const THINKING_BUDGET = resolveThinkingBudget();

/**
 * Built-in tools denied on every LIVE-lane fig run — the main loop, the warm session, and a
 * /btw background fig. Not a definition: it's `disallowedToolsForLane("live")`, resolved from
 * the one table in scheduling/lane.ts, which now owns per-lane tool surface (servers AND
 * built-ins) for both lanes.
 *
 * It used to be the definition, and its comment claimed it was "shared so both lanes get the
 * exact same denylist". That was never true — all three readers of this const are live-lane,
 * while the unattended lane inlined its own list of just the Cron* three in
 * `scheduledPassOptions`. AskUserQuestion / EnterPlanMode / ExitPlanMode / Agent were
 * therefore denied when the owner was there to be asked and ALLOWED at 3am when they weren't.
 * Re-exported here (not re-implemented) so warmSession/background keep importing it from
 * where they always did, exactly like buildFigMcpServers below.
 */
export const FIG_DISALLOWED_TOOLS = disallowedToolsForLane("live");

/**
 * The main agent's MCP server set — the thin specialist delegators plus the light tools it
 * uses directly. Shared so a /btw background fig gets byte-identical tools + vault access
 * (the whole point: same standing prompt, same capabilities, isolated context).
 *
 * The definition itself now lives in scheduling/lane.ts, which owns membership for BOTH
 * lanes and derives the unattended one from this set minus a documented exclusion table.
 * It used to live here as an object literal, with the unattended lane's near-copy 400 lines
 * away in another file — they drifted, seven servers went missing from scheduled passes,
 * and nothing noticed for six weeks. Re-exported (not re-implemented) so there is exactly
 * one list and warmSession/background keep importing it from where they always did.
 */
export { buildFigMcpServers };

/** Transient capacity/server errors worth hopping models for — NOT usage/billing limits.
 *  Exported so the warm session shares the exact same predicate (no drift). */
export const isOverload = (error: string | undefined): boolean =>
  !!error &&
  /(\b5(?:0[0-46-9]|29)\b|overload|capacity|temporarily unavailable|service unavailable|internal server error|api error:\s*5)/i.test(
    error,
  );

/** Ordered attempt list: primary tried PRIMARY_ATTEMPTS times, then each distinct fallback once. */
function buildModelAttempts(): string[] {
  const primary = currentModel(); // live /model override, else config.model
  const fallbacks = MODEL_FALLBACKS.filter((m) => m !== primary);
  return [...Array(PRIMARY_ATTEMPTS).fill(primary), ...fallbacks];
}

/**
 * The "stop" kill switch. A message that is JUST a bare "stop"/"cancel" (the whole
 * message, optionally with a trailing . or !) is the manual override — it hard-kills
 * everything in flight (active turn + detached background tasks + buffered work). A word
 * inside a sentence ("stop by macs after", "should i stop the run") is NOT the switch —
 * only a standalone word, so this never false-fires on normal text.
 */
const isKillSwitch = (t: string): boolean => /^(?:stop|cancel)[.!]?$/i.test(t.trim());

interface InboundItem {
  text: string;
  media: string[];
  /** True for synthetic background injections (specialist results, proactive nudges).
   * These always run as fig, even in spot mode. */
  background?: boolean;
  /** Text of the message this one is an inline threaded reply to — rendered into the
   *  model-visible turn as a `[replying to "…"]` marker (Feature 1). */
  replyContext?: string;
  /**
   * Epoch ms of arrival, set ONLY when this message was queued behind an already-working
   * turn (or one parked on an approval) — i.e. the owner sent it before that turn's reply
   * existed. Rendered as a `[sent HH:MM, while you were still working…]` marker so the next
   * turn doesn't read a queued message as a response to a reply they never saw. Undefined on
   * the normal path, including abort-and-fold (there the in-flight turn is discarded and
   * everything re-runs folded together, so nothing was sent "before" anything).
   */
  queuedAt?: number;
  /**
   * The background job id this synthetic inbound is relaying the result of, if any. When the
   * item is CONSUMED into a turn, that job's durable ledger entry is marked delivered
   * (specialists/jobResults.ts) — which is what makes "was this result ever relayed?" survive a
   * restart, and what holds the hot-reload gate off during the settle → debounce → turn window.
   */
  jobResultId?: string;
}

interface RunTurnOpts {
  /** `Approver`, not `(q) => …`: a gate can attach a system-built preview to the 🔐 it raises. */
  askOwner: Approver;
  onText: (text: string) => Promise<void>;
  /**
   * React on the owner's latest inbound with one emoji — the `ack({ tapback })` path.
   * Returns false when the reaction couldn't be delivered, and the ack falls back
   * to a text bubble. Omitted by callers with no reaction target.
   */
  onTapback?: (emoji: string) => Promise<boolean>;
  /**
   * True when the owner actually sent something and is waiting on a reply. Gates the
   * auto-ack 👍 backstop: a turn triggered only by background work (a finished job's
   * result injected via enqueueBackground) has nobody staring at silence, so a spurious
   * 👍 tapback on their last message is just noise. The backstop fires only when true.
   */
  userInitiated: boolean;
  /** Aborts the turn mid-flight (e.g. a correction arrived); the SDK stops and cleans up. */
  abortController: AbortController;
  /**
   * Fired once, the first time REAL work starts (the first non-ack tool call). The
   * conversation uses it to flip from abort-and-fold (cheap: nothing's committed yet)
   * to queue-behind-the-turn (a mid-turn message no longer destroys completed work).
   */
  onWorkStarted?: () => void;
}

/**
 * One single-shot agent turn. Resumes the persisted session for continuity, then
 * runs to completion and STOPS — there's no open stream for the model to run past,
 * which is what structurally prevents it from fabricating a follow-up turn. Only the
 * orchestrator's own text (main thread) is delivered; subagent chatter stays internal.
 */
async function runTurn(
  userText: string,
  opts: RunTurnOpts,
): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
  const resumeId = loadSession();

  // The user-message body every path shares: the inbound text plus the two suffix nudges
  // (a bare-tapback hint, an explicit /command). The fresh-session seed prepends to THIS;
  // the warm path additionally prepends the live grounding preamble. Building baseText first
  // (rather than appending the nudges AFTER the seed as the old inline code did) is
  // byte-identical for the cold path — the seed still lands at the very front and the nudges
  // at the very end — but it lets the warm path reuse the exact same body.
  let baseText = userText;
  // A bare tapback on one of fig's own messages rarely needs a reply. Inject the nudge
  // (and the silence escape hatch) only here, when the inbound actually is a reaction —
  // not in the static prompt. fig stays quiet by replying with exactly the SILENCE_TOKEN.
  if (isBareReaction(userText)) {
    baseText += `\n\n[that was just a tapback on one of your messages — usually no reply is needed. respond only if it genuinely calls for one; otherwise make your ENTIRE reply exactly ${SILENCE_TOKEN} and nothing gets sent. they'll text you when they want to keep going.]`;
  }
  // Explicit /command invocation: if the owner leads with `/goal …`, force that exact skill
  // (or, on a miss, tell them there's no such command) instead of trigger-phrase matching.
  const slash = resolveSlash(userText);
  if (slash) baseText += slash;

  // The fresh-session continuity seed (working-state block + raw transcript tail), memoized
  // so it's built at most once even when both the eager cold build and the warm path want it.
  // Only built when a path actually STARTS a fresh session — cold: no persisted id; warm: a
  // fresh or just-rolled-over session — so a normal resumed turn pays nothing for it. The raw
  // transcript tail keeps recent WORDS; the working-state block (when SESSION_WORKING_STATE is
  // on) packs the accumulated UNDERSTANDING the hard-roll would otherwise drop — exact file
  // paths, decisions+why, the open task, verbatim intent. It rides BEFORE the tail.
  // buildWorkingState is resilient (returns null on flag-off / failure), so we always fall
  // back cleanly to the raw seed and never break a turn on a compaction miss.
  let seedMemo: string | undefined;
  const buildSeed = async (): Promise<string> => {
    if (seedMemo !== undefined) return seedMemo;
    const history = recentHistory();
    let workingBlock: string | null = null;
    try {
      workingBlock = await buildWorkingState({ signal: opts.abortController.signal });
    } catch (e) {
      warn(`working-state build threw, using raw seed: ${e}`);
    }
    let seed = "";
    if (workingBlock) seed += `${workingBlock}\n\n`;
    if (history) seed += `[earlier conversation, for context only, do not reply to it:]\n${history}\n[end]\n\n`;
    seedMemo = seed;
    return seed;
  };

  // Cold-path prompt: the fresh-session seed (only when nothing is persisted) + baseText.
  // Byte-identical to the old inline construction. The warm path builds its own prompt below.
  let prompt = baseText;
  if (resumeId === undefined) {
    const seed = await buildSeed();
    if (seed) prompt = `${seed}${baseText}`;
  }

  let sent = 0;
  let silenced = false; // fig chose to stay quiet (the SILENCE_TOKEN) — not an error
  let resultError: string | undefined;
  const forcedCodex = currentModelRuntime() === "codex";
  const fallbackAtStart = codexFallbackActive();
  const probingClaude = !forcedCodex && fallbackAtStart.active && fallbackAtStart.shouldProbeClaude;
  const probeBuffer: string[] = [];
  const emit = async (text: string): Promise<void> => {
    if (probingClaude) {
      probeBuffer.push(text);
      return;
    }
    await opts.onText(text);
  };
  const flushProbeSuccess = async (): Promise<void> => {
    if (!probingClaude) return;
    clearCodexFallback();
    await opts.onText("claude's back — switching back.");
    for (const text of probeBuffer) await opts.onText(text);
  };
  const runCodexDirect = async (): Promise<LiveTurnResult> => {
    const selection = codexLiveRuntimeSelection();
    const before = sent;
    const result = await selection.runtime.runLiveTurn({
      prompt: toWellFormedUnicode(prompt),
      signal: opts.abortController.signal,
      emit: async (text) => {
        await opts.onText(text);
        sent++;
      },
      tapback: opts.onTapback
        ? async (emoji) => {
            const ok = await opts.onTapback!(emoji);
            if (ok) sent++;
            return ok;
          }
        : undefined,
      askOwner: opts.askOwner,
      userInitiated: opts.userInitiated,
      onWorkStarted: opts.onWorkStarted,
      providerOptions: selection.providerOptions,
    });
    // An intentional interrupt is silent. In particular, don't manufacture the generic
    // "codex fallback didn't return anything" bubble after the child was killed by Stop.
    if (sent === before && !result.aborted && !opts.abortController.signal.aborted) {
      await opts.onText("codex fallback didn't return anything.");
      sent++;
    }
    return opts.abortController.signal.aborted ? { ok: false, aborted: true } : result;
  };
  const runCodexFallback = async (announce: boolean, error?: string): Promise<LiveTurnResult> => {
    markCodexFallbackActive(error);
    if (announce) {
      await opts.onText("claude session limit reached — falling back to codex.");
      sent++;
    }
    return runCodexDirect();
  };
  if (forcedCodex) {
    const result = await runCodexDirect();
    if (result.aborted) return result;
    return { ok: result.ok, error: result.ok ? undefined : result.error ?? "codex runtime active" };
  }
  if (fallbackAtStart.active && !fallbackAtStart.shouldProbeClaude) {
    const result = await runCodexDirect();
    if (result.aborted) return result;
    return { ok: result.ok, error: result.ok ? undefined : result.error ?? "codex fallback active" };
  }

  // ── WARM-FIRST ─────────────────────────────────────────────────────────────────────────
  // Run the turn on the persistent, pre-warmed streaming session so the MCP fleet
  // (calendar/email/browse/…) stays connected across turns instead of cold-booting per
  // message. Gated on WARM_SESSION (unset/≠1 → skip entirely → byte-for-byte the old cold path).
  //
  // Scope: only a NORMAL Claude turn. A forced-codex or active-codex-without-probe turn has
  // already returned above; a codex→claude PROBE (fallbackAtStart.active) deliberately stays
  // on the cold path — its buffered-probe + "claude's back" flush logic lives there and the
  // warm layer would double-emit through it. So we require !fallbackAtStart.active.
  //
  // Recovery contract (this is how model-fallback + codex-fallback are preserved): on ANY warm
  // trouble that delivered NOTHING to the owner, we fall through to the cold one-shot path below,
  // which owns the full model-hop + codex-fallback ladder — so a warm failure can never drop a
  // user message. If warm ALREADY put a bubble on their screen, we do NOT fall through (a cold
  // re-run would double-send), which mirrors the cold path's own sent>0 no-retry guard.
  if (warmSessionEnabled() && !fallbackAtStart.active) {
    let ready: { ok: boolean; fresh: boolean };
    try {
      ready = await ensureWarmReady({ askOwner: opts.askOwner });
    } catch (e) {
      warn(`warm ensureReady threw — cold fallback: ${e}`);
      ready = { ok: false, fresh: false };
    }
    if (ready.ok) {
      // The warm session's system prompt is frozen (static prefix) at session start, so the
      // per-turn grounding (date/location/agenda + the three open-loop lists) rides in the
      // user message via the preamble. The fresh-session seed rides only when the warm session
      // is actually fresh (new or just rolled over) — mirroring the cold seed rule, but keyed
      // on the warm session's own freshness rather than the persisted-id check.
      const preamble = buildMessagePreamble();
      let warmBody = baseText;
      if (ready.fresh) {
        const seed = await buildSeed();
        if (seed) warmBody = `${seed}${baseText}`;
      }
      const warmPrompt = `${preamble}\n\n${warmBody}`;
      let warmSent = 0;
      const warmResult = await runWarmTurn(warmPrompt, {
        emit: async (text) => {
          await opts.onText(text);
          warmSent++;
        },
        // A tapback ack is a real delivery too — count it, so a turn whose whole
        // visible output was a reaction isn't mistaken for "warm sent nothing"
        // and re-run on the cold path (which would double-ack them).
        tapback: opts.onTapback
          ? async (emoji) => {
              const ok = await opts.onTapback!(emoji);
              if (ok) warmSent++;
              return ok;
            }
          : undefined,
        onWorkStarted: opts.onWorkStarted,
        abortSignal: opts.abortController.signal,
      });
      if (warmResult.status === "aborted") {
        log("warm turn aborted to fold in a new message");
        return { ok: false, aborted: true };
      }
      if (warmResult.status === "ok") {
        return { ok: true };
      }
      // empty | recover. If a bubble already reached the owner, this is terminal — re-running the
      // cold path would double-send, so we surface the same {ok:false} the cold path returns
      // for a tool turn that delivered an opener but no clean final reply.
      if (warmSent > 0) {
        warn(`warm turn '${warmResult.status}' after delivering ${warmSent} — not falling back (would double-send)`);
        return { ok: false, error: warmResult.error ?? warmResult.status };
      }
      // Nothing reached the owner → safe to drop to the cold path for the full recovery ladder.
      warn(`warm turn '${warmResult.status}' (nothing delivered) — cold fallback: ${warmResult.error ?? ""}`);
    } else {
      warn("warm session not ready — cold fallback");
    }
  }

  // Thin orchestrator: heavy/domain MCP servers (gmail, calendar, spotify, lastfm, the
  // browser) are delegated to scoped specialist sub-queries, so their tools never load into
  // the main context. Built at the mount below rather than hoisted here — see the note there.
  // Walk the model fallback chain. Each attempt runs a full query+stream; on a transient
  // overload (529/5xx) with nothing delivered yet, we drop to the next model and retry.
  const attempts = buildModelAttempts();
  for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
    const activeModel = attempts[attemptIdx];
    const lastAttempt = attemptIdx === attempts.length - 1;
    if (attemptIdx > 0) {
      await sleep(Math.min(attemptIdx * 1500, 4000)); // brief backoff to let capacity recover / model switch settle
      log(`model fallback → attempt ${attemptIdx + 1}/${attempts.length} on ${activeModel}`);
    }
  try {
    const response = query({
      prompt: toWellFormedUnicode(prompt),
      options: {
        cwd: config.brainDir,
        model: activeModel,
        // Pin extended thinking ON every turn (see THINKING_BUDGET above): best
        // performance + structurally kills the reasoning-text leak by forcing reasoning
        // into thinking blocks the pipeline already discards.
        thinking: { type: "enabled", budgetTokens: THINKING_BUDGET },
        resume: resumeId,
        abortController: opts.abortController,
        // Fresh instances per ATTEMPT, not per turn. An in-process MCP server instance is held
        // by exactly one open query, and the fallback loop retries after an overload without
        // the previous query necessarily having closed — reusing the map there hands the retry
        // a set of already-held instances and it comes up with ZERO MCP tools. That's a
        // degraded turn on precisely the path taken when things are already going wrong.
        mcpServers: buildFigMcpServers(),
        canUseTool: makeCanUseTool(opts.askOwner),
        permissionMode: "default",
        // The live lane's built-in denylist, resolved from BASE_DISALLOWED_TOOLS in
        // scheduling/lane.ts — each name carries its reason there, next to the server
        // exclusion table, so the two halves of "what can this lane touch" live together
        // and the unattended lane can't drift off a copy of this one.
        disallowedTools: FIG_DISALLOWED_TOOLS,
        settingSources: ["project"],
        skills: "all",
        // Counters formatting orders baked into built-in tool descriptions that assume a
        // markdown surface (WebSearch's "close with markdown links"). See runtimes/hooks.ts.
        hooks: SURFACE_HOOKS,
        systemPrompt: toWellFormedUnicodeList(buildSystemPrompt()),
      },
    });
    // The owner sees TWO things from a turn, never the work in between: (1) the OPENER — a
    // short "heard you, on it" beat before the unseen work — and (2) the FINAL result.
    // Everything else (the play-by-play narrated while editing/calling tools) they can't see,
    // so we don't deliver it.
    //
    // The opener comes from ONE place: an explicit `ack` tool call. Its `text` arg IS the
    // opener and we deliver it the moment the tool_use streams in. We deliberately do NOT
    // treat "whatever text the model emits first" as the opener anymore — that old path
    // shipped stage-directions ("send opener, then dig into the docs") straight to the owner,
    // because the harness can't tell an ack from the model narrating its own plan. Sourcing
    // the opener from a structured tool arg kills that whole class of leak.
    //
    // Safety net: if the model dives into real work (any non-ack tool) without having acked
    // on a USER-INITIATED turn, we auto-send a 👍 tapback so they're never left staring at
    // silence on a slow task. Background-only turns (a finished job's result) skip this — they
    // isn't waiting, so a 👍 there is just an out-of-context tapback. All other free-form text
    // before the final reply is suppressed; only text after the last tool survives as the final.
    let reply: string[] = []; // assistant text since the last tool call (the candidate final reply)
    let workStartedNotified = false; // onWorkStarted fires once per turn (first non-ack tool)
    let realAckSent = false; // delivered a genuine `ack` tool call's text?
    let toolSeen = false; // if true, an opener alone is not a complete answer
    let payloadDelivered = false; // a tool sent its own user-facing payload (image/file/carousel) — counts as output
    let finalSent = false;
    let lastContext = 0; // most recent turn's total input context, for the size-rollover check
    for await (const msg of response) {
      switch (msg.type) {
        case "system":
          if ((msg as any).subtype === "init") setSession(msg.session_id);
          break;
        case "assistant": {
          const am = msg as any;
          if (am.parent_tool_use_id) break; // subagent output — internal, not for the user
          // Track the live context size from the orchestrator's own usage so a
          // grown session rolls over (see loadSession's size cap).
          const u = am.message?.usage;
          if (u) {
            lastContext =
              (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          }
          if (am.error) resultError = describeSdkError("assistant_error", am.error);
          const blocks = am.message?.content ?? [];
          const texts = blocks
            .filter((b: any) => b.type === "text" && b.text.trim())
            .map((b: any) => b.text)
            .join("\n\n")
            .trim();
          const toolBlocks = blocks.filter((b: any) => b.type === "tool_use");
          const hasTool = toolBlocks.length > 0;
          if (hasTool) toolSeen = true;
          if (texts && deliveredTextIsExhaustion(texts)) {
            resultError = texts;
            break;
          }
          // Opener path: the model called `ack`. Its `text` arg is the opener — deliver it
          // now, through the normal onText path (chunking, transcript, lone-emoji→tapback).
          // Gate on realAckSent, NOT ackSent: a genuine ack must still deliver its text even
          // if the auto-ack 👍 backstop already fired this turn. Otherwise an out-of-order
          // turn (a tool before the ack) drops the real opener — the exact failure mode that
          // shipped a bare tapback with no words. Worst case here is a 👍 then the text bubble,
          // which reads fine; silently eating the text does not.
          const ackBlock = toolBlocks.find((b: any) => b.name === ACK_TOOL_NAME);
          if (ackBlock && !realAckSent) {
            // `tapback` reacts on their latest message, `text` is the bubble; either
            // may be absent, both may be present. Shared with the warm path so the
            // two can't drift on ordering or the silence sentinel (ack/deliver.ts).
            const delivered = await deliverAck(ackBlock.input, { emit, tapback: opts.onTapback });
            if (delivered.silenced) silenced = true;
            sent += delivered.sent;
            realAckSent = true;
          }
          // The opener is now PURE JUDGMENT — fig acks (a "sec"/👍 via the ack tool) only when a
          // turn genuinely blocks long enough that silence would feel dead. There's no auto-👍
          // backstop anymore: the slow stuff (browse/code/codex/research) all backgrounds and
          // self-acks its own launch, so a user-initiated turn is never left staring at nothing
          // for long, and forcing a reaction onto every message read as a reflex, not a choice
          // (the owner). The typing indicator carries the short blocking turns.
          const startedWork = toolBlocks.some((b: any) => b.name !== ACK_TOOL_NAME);
          // Real work just began — tell the conversation, so a message arriving from
          // here on queues behind this turn instead of aborting it (see enqueue()).
          if (startedWork && !workStartedNotified) {
            workStartedNotified = true;
            opts.onWorkStarted?.();
          }
          // Some tools (image generate / send_file / send_carousel) deliver their payload
          // straight to the owner without going through `emit`, so `sent` stays 0. Track that here
          // so a payload-only turn with no closing text isn't mistaken for a silent death below
          // (the auto-👍 used to bump `sent` and mask this; now we detect it explicitly).
          if (toolBlocks.some((b: any) => USER_DELIVERING_TOOLS.has(b.name))) payloadDelivered = true;
          // All other free-form text before the final reply is narration / stage-direction —
          // never the opener (that's the ack tool's job). Once a tool appears, reset the
          // buffer so only text AFTER the last tool survives as the final reply.
          if (hasTool) {
            reply = [];
            break;
          }
          if (texts) reply.push(texts);
          break;
        }
        case "result": {
          const rm = msg as any;
          if (rm.session_id) setSession(rm.session_id, lastContext || undefined);
          if (rm.subtype && rm.subtype !== "success")
            resultError = describeSdkError(`result:${rm.subtype}`, rm.result, rm.error);
          // Deliver the buffered final reply. If we sent NOTHING at all this turn, fall
          // back to the SDK's result text — guarded by sent===0 so we never re-send an
          // opener/answer we already delivered.
          const finalText = reply.join("\n\n").trim();
          if (silenced || isSilence(finalText)) {
            silenced = true; // intentional no-reply — deliver nothing, no warning
          } else if (finalText && deliveredTextIsExhaustion(finalText)) {
            resultError = finalText;
          } else if (finalText) {
            await emit(finalText);
            sent++;
            finalSent = true;
          } else if (sent === 0 && typeof rm.result === "string" && rm.result.trim() && !isSilence(rm.result)) {
            const resultText = rm.result.trim();
            if (deliveredTextIsExhaustion(resultText)) {
              resultError = resultText;
              break;
            }
            await emit(resultText);
            sent++;
            finalSent = true;
          }
          break;
        }
      }
    }
    // Aborted but the SDK ended the stream cleanly instead of throwing — treat as cancelled.
    if (opts.abortController.signal.aborted) {
      log("turn aborted to fold in a new message");
      return { ok: false, aborted: true };
    }
    // Transient overload that surfaced via the result (not a throw) with nothing
    // delivered yet → fall to the next model in the chain instead of failing the turn.
    if (!lastAttempt && sent === 0 && !silenced && isOverload(resultError)) {
      warn(`overload on ${activeModel} (no output) — falling to next model`);
      setSession(undefined);
      resultError = undefined;
      continue;
    }
    if ((sent === 0 || probingClaude) && isProviderExhaustion(resultError)) {
      setSession(undefined);
      const fallback = await runCodexFallback(!fallbackAtStart.active, resultError);
      if (fallback.aborted) return fallback;
      return { ok: fallback.ok, error: fallback.error ?? resultError };
    }
    // A tool turn that ended without a buffered final reply is only a FAILURE if
    // something actually went wrong (an error surfaced, or we delivered nothing at all).
    // If we DID deliver something cleanly — a tool that sends its own payload (e.g.
    // image generate / send_file) and the model added no closing text — that's a complete
    // turn, not a silent death. `payloadDelivered` (or any emitted bubble) keeps it out of
    // this branch, now that there's no auto-👍 bumping `sent` for us.
    if (toolSeen && !finalSent && !silenced && (resultError || (sent === 0 && !payloadDelivered))) {
      return { ok: false, error: resultError ?? "tool turn ended without a final reply" };
    }
    if (sent > 0 || silenced) {
      await flushProbeSuccess();
      return { ok: true };
    }
    return { ok: false, error: resultError ?? "empty" };
  } catch (e) {
    // Aborted on purpose (a new message arrived) — not an error; the caller folds it in.
    if (opts.abortController.signal.aborted) {
      log("turn aborted to fold in a new message");
      return { ok: false, aborted: true };
    }
    warn(`turn threw (resetting session): ${e}`);
    setSession(undefined);
    // Transient overload thrown before anything streamed → hop to the next model.
    if (!lastAttempt && sent === 0 && isOverload(String(e))) {
      warn(`overload threw on ${activeModel} (no output) — falling to next model`);
      continue;
    }
    if (isProviderExhaustion(String(e))) {
      const fallback = await runCodexFallback(!fallbackAtStart.active, String(e));
      if (fallback.aborted) return fallback;
      return { ok: fallback.ok, error: fallback.error ?? String(e) };
    }
    return { ok: false, error: String(e) };
  }
  } // end model fallback chain
  // Every attempt in the chain hit an overload without delivering — surface it.
  setSession(undefined);
  return { ok: false, error: "every model in the fallback chain was overloaded" };
}

/**
 * Per-conversation manager. Debounces incoming messages so rapid-fire texts bundle
 * into one turn, runs turns one at a time, and routes a pending 👍/👎 to the waiting
 * tool call.
 */
export class Conversation {
  private buffer: InboundItem[] = [];
  private processing = false;
  private debounce: NodeJS.Timeout | null = null;
  /** The 🔐 currently awaiting a 👍/👎. `id` is the short tag shown in the bubble (see approvalPrompt.ts). */
  private pendingApproval: { id: string; question: string; resolve: (b: boolean) => void } | null = null;
  /** Most recent inbound message id — the target when the agent replies with a pure tapback emoji. */
  private lastInboundId: string | undefined;
  /**
   * When the most recent inbound was itself a threaded reply, this is that inbound's id so
   * fig threads its reply back ONTO the owner's message (the inline reply bubble) — symmetric
   * with the /bg lane (background.ts sets replyToId: ctx.inboundId). Undefined for a normal,
   * non-reply inbound, which stays a flat bubble.
   */
  private replyThreadTarget: string | undefined;
  /**
   * The handle to reply ON for the current exchange. The owner reaches fig from two iMessage
   * handles (their number and their email), so replies go back to whichever one they just texted
   * from instead of always the configured owner number — each thread is fully two-way.
   * Defaults to `owner`; updated per inbound in enqueue(). Proactive content (briefings,
   * scheduler) doesn't run through this instance, so it stays on the owner number.
   */
  private replyTo: string;
  /** Aborts the in-flight turn when a new message arrives, so we restart with the corrected context. */
  private currentAbort: AbortController | null = null;
  /**
   * True once the in-flight turn has started REAL work (its first non-ack tool call).
   * Gates the mid-turn policy in enqueue(): before work starts, a new message aborts
   * the turn and folds in (nothing's lost — this is the "wait, I meant Tuesday" window);
   * after, it queues behind the turn so completed tool work isn't destroyed. On the SDK
   * an abort can't be partial (the session rolls back wholesale), so the only way to be
   * less destructive is to abort less often — this flag is that line. A bare "stop"
   * stays the explicit hard-cancel either way.
   */
  private workStarted = false;
  /** Set by the "stop" kill switch so flush() drops the aborted turn instead of re-running it. */
  private stopKilled = false;
  /** Keepalive that re-asserts the typing indicator during a turn (cleared the instant it ends). */
  private typingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly owner: string,
  ) {
    this.replyTo = owner;
    // A specialist call that gets detached on interrupt re-queues its eventual result
    // here, as a soft inbound — picked up after the current turn ends, never aborting one.
    setBackgroundInjector((t, meta) => this.enqueueBackground(t, meta?.jobResultId));
  }

  hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
  }

  resolveApproval(approved: boolean): void {
    if (this.pendingApproval) {
      const p = this.pendingApproval;
      this.pendingApproval = null;
      p.resolve(approved);
    }
  }

  /**
   * True when no turn is running, nothing is buffered, and no approval is outstanding
   * — i.e. a safe moment to restart the process for a code reload without killing an
   * in-flight turn before it replies. (A pending debounce timer with an empty buffer
   * is a no-op — flush() returns early — so it isn't part of the check.)
   */
  isIdle(): boolean {
    return !this.processing && this.buffer.length === 0 && this.pendingApproval === null;
  }

  /** Add an owner message; processing is debounced so a burst bundles together. */
  enqueue(text: string, media: string[], id?: string, from?: string, replyContext?: string, inboundReplyToId?: string): void {
    if (id) {
      this.lastInboundId = id;
      // If the owner's inbound was itself a threaded reply, thread fig's reply back onto THEIR
      // message (id), not onto what they replied to — mirrors the /bg lane. Otherwise flat.
      this.replyThreadTarget = inboundReplyToId ? id : undefined;
    }
    // Reply on the thread they just texted from (their number OR their email), not always the
    // owner number. Set before the kill-switch / mode-command checks so even those
    // confirmations land in the right thread.
    if (from) this.replyTo = from;
    // Kill switch: a bare "stop"/"cancel" on its own (no attachments) is the manual
    // override — nuke everything in flight and go quiet. Checked before buffering so it
    // never gets bundled into a turn. A word inside a sentence isn't the switch.
    if (media.length === 0 && isKillSwitch(text)) {
      this.killAll();
      return;
    }
    // The fig↔spot switch: a bare /spot, /fig, or /switch flips which brain answers
    // The owner. Checked here (like the kill switch) so it never becomes a turn — it
    // just sends a confirmation and returns. Routing to spot happens in flush().
    if (media.length === 0) {
      const confirm = spotLane.resolveModeCommand(text);
      if (confirm) {
        void this.transport.send(this.replyTo, confirm).catch(() => {});
        return;
      }
      // Same shape for /model: flips the live model in code, never becomes a turn
      // (spending an agent turn to switch models would defeat the point).
      const modelConfirm = resolveModelCommand(text);
      if (modelConfirm) {
        if (/^\/model\b\s+\S+/i.test(text.trim()) && currentModelRuntime() !== "codex") clearCodexFallback();
        void this.transport.send(this.replyTo, modelConfirm).catch(() => {});
        return;
      }
      // Same shape for /voice: flips the persistent speak-everything mode in code, never
      // becomes a turn. Deliberately NOT a skill invoke — the mode has to outlive the turn
      // that set it (a background job an hour later still gets spoken), so burning an agent
      // turn to flip a bit would be both slow and pointless. Only the mode words are caught
      // here; `/voice draft an email to X` returns null and falls through to the buffer, where
      // resolveSlash() routes it to the writing-voice skill exactly as before.
      const voiceConfirm = resolveVoiceCommand(text);
      if (voiceConfirm) {
        void this.transport.send(this.replyTo, voiceConfirm).catch(() => {});
        return;
      }
      // Same shape for /prompt: reads a bot's live system prompt straight off disk and
      // sends it as a real .md attachment. This one does real (async) work — shelling
      // out to the print-prompt script — so it's fired and handled off-thread rather
      // than resolved inline, but it still never touches the agent loop.
      if (/^\/prompt\b/i.test(text.trim())) {
        void this.handlePromptCommand(text);
        return;
      }
      // Same shape for /usage: both providers' rate-limit numbers, answered in code —
      // burning an agent turn to check quota would spend the quota being checked. Does
      // real async work (network, and possibly a headless claude run to un-stale the
      // token), so it's fired off-thread like /prompt.
      if (isUsageCommand(text)) {
        void this.handleUsageCommand();
        return;
      }
    }
    const item: InboundItem = { text, media, replyContext };
    this.buffer.push(item);
    // A message arriving while a turn is in flight cancels it, so the agent never
    // finishes acting on now-stale or half-given context (a typo'd request, a
    // missing detail). flush() then re-runs with the original + this new message
    // folded together. Normal single-message requests never hit this — no added
    // latency, just a clean "wait, let me restart with what you actually meant".
    if (this.processing && this.currentAbort) {
      // Exception: a turn parked on an approval must be left alone. Aborting it
      // tears down the stream mid-prompt and kills the pending tool call — the very
      // write they're about to 👍. So while an approval is outstanding we just buffer
      // the new message; flush()'s tail picks it up once the approval resolves.
      if (this.pendingApproval) {
        // Stamped: the parked turn still owes them a reply, so this message predates it.
        item.queuedAt = Date.now();
        log("new message while awaiting approval → buffering, not cancelling the parked turn");
        return;
      }
      // Real work is already committed → QUEUE instead of abort. The message is in the
      // buffer; flush()'s tail picks it up as the next turn the moment this one ends.
      // Aborting here would throw away completed tool work for a wholesale re-run (the
      // SDK can't keep partial progress across an abort). A correction that truly can't
      // wait has the explicit kill switch: a bare "stop".
      if (this.workStarted) {
        // Stamped: this lands as its own later turn, AFTER the in-flight turn's reply has
        // been sent — so the next turn has to be told they wrote it before seeing that reply.
        item.queuedAt = Date.now();
        log("new message mid-turn (work underway) → queued for the next turn");
        return;
      }
      log("new message mid-turn → cancelling to fold it in");
      this.currentAbort.abort();
      return; // the aborted flush re-queues everything and reschedules
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
  }

  /**
   * Soft-enqueue a synthetic inbound (a detached specialist's result landing in the
   * background). Unlike enqueue(), this NEVER aborts a running turn — a background
   * result is new info, not a correction, so it can wait for the current turn to finish
   * rather than interrupting it (which would risk re-answering and abort loops). It just
   * buffers and schedules a flush; if a turn is in flight, flush()'s tail or this timer
   * (whichever lands after the turn ends) picks it up. No id → never becomes a tapback target.
   */
  enqueueBackground(text: string, jobResultId?: string): void {
    this.buffer.push({ text, media: [], background: true, jobResultId });
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
  }

  /**
   * Runs a `/prompt` command and sends the result — a real .md attachment for a
   * hit, plain text for help/errors. Off the enqueue() call stack (that one's sync
   * and fires this without awaiting) so a slow shell-out never blocks the debounce
   * timer or a concurrent turn. Cleans up its own temp file once the send lands.
   */
  private async handlePromptCommand(text: string): Promise<void> {
    try {
      const result = await resolvePromptCommand(text);
      if (!result) return; // shouldn't happen — enqueue() only calls this on a /prompt match
      if (result.file) {
        try {
          const bytes = fs.readFileSync(result.file.path);
          await this.transport.send(this.replyTo, result.text ?? "", {
            mediaBase64: bytes.toString("base64"),
            mediaFilename: result.file.filename,
            mediaMime: "text/markdown",
          });
        } finally {
          fs.rm(path.dirname(result.file.path), { recursive: true, force: true }, () => {});
        }
      } else if (result.text) {
        await this.transport.send(this.replyTo, result.text);
      }
    } catch (e) {
      warn(`/prompt command failed: ${e}`);
      void this.transport.send(this.replyTo, "🤖 /prompt hit an error — check the logs").catch(() => {});
    }
  }

  /**
   * Runs `/usage` and sends the summary. Off the enqueue() call stack (that one's sync)
   * because the stale-token heal can spawn a claude run that takes up to a minute —
   * blocking the debounce timer on it would stall real turns.
   */
  private async handleUsageCommand(): Promise<void> {
    try {
      await this.transport.send(this.replyTo, await runUsageCommand());
    } catch (e) {
      warn(`/usage command failed: ${e}`);
      void this.transport.send(this.replyTo, "🤖 /usage hit an error — check the logs").catch(() => {});
    }
  }

  /**
   * The "stop" kill switch. Hard-kills the active work and clears the pending exchange:
   *  - aborts the active turn (the stopKilled flag tells flush() to drop it, not re-run it)
   *  - suppresses every detached background task's result (no orphan injection)
   *  - clears buffered work so the next message starts a fresh turn instead of silently
   *    resurrecting the request the owner just stopped
   *  - resolves a parked approval as deny so a turn waiting on 🔐 unwinds cleanly
   * Sends one short confirmation so the owner knows it landed. Unlike reset(), it preserves
   * the session/conversation — only the pending exchange dies.
   */
  private killAll(): void {
    log("STOP kill switch — killing active turn + detached tasks; clearing pending exchange");
    this.buffer = [];
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    cancelAllDetached();
    cancelAllJobs(); // also kill any fully-async background jobs (e.g. a running browser job)
    // Buffered work is gone (above), so a settled job's un-consumed wake just died with it.
    // Retire its ledger entry too — otherwise a result the owner explicitly stopped would come
    // back as a surprise re-delivery on the next restart. Same intent as cancelAllDetached().
    discardUndeliveredJobResults("stop kill switch");
    if (this.pendingApproval) {
      const p = this.pendingApproval;
      this.pendingApproval = null;
      p.resolve(false);
    }
    if (this.currentAbort) {
      this.stopKilled = true; // flush()'s abort branch drops the turn instead of re-running it
      this.currentAbort.abort();
    }
    void this.transport.send(this.replyTo, "stopped ✋").catch(() => {});
  }

  reset(): void {
    this.buffer = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.currentAbort?.abort();
    this.stopTyping();
    setSession(undefined);
    log("conversation reset");
  }

  private bundle(batch: InboundItem[], transcripts?: readonly AudioNoteTranscript[]): string {
    const parts: string[] = [];
    const media = batch.flatMap((b) => b.media);
    // Voice notes are split out of the generic attachment line: a `.caf` is not something
    // Read can open, so listing it under "Read each to see/understand it" only sends fig
    // down a dead end. Its content arrives as a transcript block instead, which still
    // carries the path for a re-listen. Every other attachment behaves exactly as before.
    const { notes, others } = partitionAudioNotes(media);
    if (others.length) {
      parts.push(`[the owner attached ${others.length} file(s); Read each to see/understand it: ${others.join(", ")}]`);
    }
    const noteBlock = audioNoteTranscriptBlock(
      transcripts?.length ? transcripts : notes.map((p) => ({ path: p, ok: false, text: "", error: "not transcribed" })),
    );
    if (notes.length && noteBlock) parts.push(noteBlock);
    // Prefix each item that's an inline reply with a `[replying to "…"]` marker so fig sees
    // WHICH earlier message they're responding to (Feature 1), and each item that was queued
    // behind a working turn with a `[sent HH:MM, while you were still working…]` marker so a
    // message they wrote BEFORE the last reply landed isn't read as a response to it.
    // Model-visible only, not logged.
    const texts = batch
      .map((b) => {
        // An attachment-only bubble carries U+FFFC (the object-replacement glyph) as its
        // "text". That's a placeholder for the file, not something the owner typed — with a
        // transcript now standing in for the voice note, echoing it is pure noise.
        if (b.media.length && /^[￼\s]*$/.test(b.text)) return "";
        return b.text ? withQueuedContext(withReplyContext(b.text, b.replyContext), b.queuedAt) : b.text;
      })
      .filter(Boolean);
    if (texts.length) parts.push(texts.join("\n"));
    // Video-platform links (youtube/ig/tiktok) can't be read by the normal fetch
    // ladder — inject the working method as a conditional instruction so fig fetches
    // it cleanly instead of giving up. Only fires when such a URL is actually present.
    const hints = videoLinkHints(texts.join("\n"));
    if (hints.length) parts.push(hints.join("\n"));
    // Reply modality. Two hooks, same shape as the link hints above (model-visible only,
    // never logged or delivered), and they're mutually exclusive because the standing one
    // strictly contains the per-message one:
    //   /voice mode ON  → speak EVERY reply, including this-batch-is-a-background-job turns
    //                     that have no inbound audio to match. Persistent until toggled off.
    //   /voice mode OFF → the original default: they talked instead of typing, so talk back
    //                     (voice note in, voice note out), and only when a NATIVE audio
    //                     message is in the batch. An ordinary attachment changes nothing.
    // This is the one place background/proactive turns become audible: enqueueBackground()
    // items are bundled here too, so a finished job's report gets the hint just like a reply.
    const audioHint = voiceModeHint() ?? audioMessageHint(media);
    if (audioHint) parts.push(audioHint);
    return parts.join("\n\n").trim();
  }

  /**
   * Every native audio note in the batch → its transcript. Returns [] when there are
   * none (the overwhelmingly common case, and zero added latency for it). Wrapped in a
   * try so an unexpected throw anywhere in the STT lane still yields a bundle — fig
   * finding out late that it can't read a note beats fig never answering.
   */
  private async transcribeVoiceNotes(batch: InboundItem[]): Promise<AudioNoteTranscript[]> {
    const { notes } = partitionAudioNotes(batch.flatMap((b) => b.media));
    if (!notes.length) return [];
    try {
      const results = await transcribeAudioNotes(notes);
      return results.map((r) => ({ path: r.path, ok: r.ok, text: r.text, error: r.error }));
    } catch (e) {
      warn(`voice note transcription lane failed: ${e}`);
      return notes.map((p) => ({ path: p, ok: false, text: "", error: String(e).slice(0, 160) }));
    }
  }

  private async flush(): Promise<void> {
    if (this.processing || this.buffer.length === 0) return;
    this.processing = true;
    const items = this.buffer.splice(0);
    // Voice notes become words BEFORE the turn is built, so fig reads what the owner said
    // instead of a `.caf` path it can't open. Local + on-device (~1s for a short note),
    // and every failure mode returns a result object rather than throwing — a dead
    // whisper degrades the turn to "they sent a voice note I couldn't read", never to
    // silence. Deliberately here and not at enqueue: bundling is where the batch is
    // final, so a note that arrived mid-debounce is included exactly once.
    const transcripts = await this.transcribeVoiceNotes(items);
    const bundled = this.bundle(items, transcripts);
    if (!bundled) {
      this.processing = false;
      return;
    }
    // spot mode: owner messages route to spot's brain (over localhost HTTP), not fig's
    // agent. Background content (specialist results, proactive nudges) always stays fig,
    // so it's split off and re-queued to deliver as fig on the next flush.
    const ownerItems = items.filter((i) => !i.background);
    const bgItems = items.filter((i) => i.background);
    if (spotLane.getMode() === "spot" && ownerItems.length > 0) {
      try {
        await this.runSpotTurn(ownerItems);
      } finally {
        this.processing = false;
      }
      if (bgItems.length) this.buffer.unshift(...bgItems);
      if (this.buffer.length) {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
      }
      return;
    }
    // This bundle is now committed to a real fig turn, so any background job result in it has
    // actually reached fig — settle its durable ledger entry. Deliberately here and not at
    // enqueue time: the whole point is that a wake sitting on the debounce timer still counts as
    // UNDELIVERED, so the hot-reload gate holds and a restart in that window re-delivers instead
    // of dropping it. (After the spot branch, because spot mode re-queues background items for
    // the next flush rather than consuming them.)
    for (const item of items) {
      if (item.jobResultId) markJobResultDelivered(item.jobResultId);
    }
    const prevSession = loadSession(); // restore point if this turn gets cancelled
    const abort = new AbortController();
    this.currentAbort = abort;
    this.workStarted = false; // fresh turn — abort-and-fold until its first real tool call
    this.startTyping(); // typing stays on for the whole turn, re-asserted under the relay's expiry
    setApprover(this.askOwner); // specialist sub-queries route 🔐 confirmations to this owner
    setTurnSignal(abort.signal); // so a blocking specialist can detach if this turn gets cancelled

    let result: { ok: boolean; error?: string; aborted?: boolean };
    try {
      result = await runTurn(bundled, {
        askOwner: this.askOwner,
        onText: (t) => this.deliver(t),
        onTapback: (emoji) => this.tapback(emoji),
        // Any non-background item = the owner sent something and is waiting. A turn made up
        // entirely of background injections (a finished job's result) is not user-initiated,
        // so the auto-ack 👍 backstop stays off for it.
        userInitiated: ownerItems.length > 0,
        abortController: abort,
        onWorkStarted: () => {
          this.workStarted = true;
        },
      });
    } finally {
      this.stopTyping(); // ...and stops the instant the turn ends (success, error, or cancel)
      setApprover(null);
      setTurnSignal(null);
      this.currentAbort = null;
      this.workStarted = false;
      this.processing = false;
    }

    // The "stop" kill switch aborted this turn. Drop that exchange completely: the next inbound
    // must start clean rather than silently resuming work the owner explicitly killed.
    // (Read-and-clear so a stray flag can never leak into a later real correction.)
    const killed = this.stopKilled;
    this.stopKilled = false;

    if (result.aborted) {
      if (killed) {
        setSession(prevSession);
        log("turn killed by stop — stopped exchange discarded");
        // A genuinely new message can race the abort unwind. killAll() already cleared anything
        // older; if something arrived after that, let it run normally.
        if (this.buffer.length) {
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
        }
        return;
      }
      // Erase the cancelled turn and re-queue its messages ahead of whatever arrived,
      // so the next run sees the original request and the correction together.
      setSession(prevSession);
      // The bundle was marked delivered when it committed to this turn — but the turn is being
      // thrown away and its items put back on the buffer, so any job wake in it is owed all over
      // again. Un-mark before re-queueing, or the ledger claims delivery for a wake that hasn't
      // run yet and the reload gate stops holding for it.
      for (const item of items) {
        if (item.jobResultId) restoreJobResultUndelivered(item.jobResultId);
      }
      this.buffer.unshift(...items);
      log("re-running with the new message folded in");
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
      return;
    }

    if (!result.ok) {
      try {
        await this.transport.send(this.replyTo, `⚠️ no reply generated (${result.error ?? "unknown"}). check the logs.`);
      } catch {
        /* ignore */
      }
    }
    // Periodic reconcile: count this as one real user turn. Every ~20 such turns it fires
    // a background pass that audits what fig SAID it did against what actually landed on
    // disk (armed tasks, saved files, logged loops) and fixes the drift. Gated on a
    // successful, user-initiated turn so background injections and the reconcile pass
    // itself never inflate the count. Fire-and-forget — never delays this turn.
    if (result.ok && ownerItems.length > 0) {
      noteTurnAndMaybeReconcile(this.transport, this.owner);
    }
    // Messages that landed mid-turn get processed in the next bundle.
    if (this.buffer.length) {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.flush(), BUNDLE_MS);
    }
  }

  /**
   * Relay owner messages to spot's brain (in its own repo, over localhost HTTP) and
   * send spot's reply back on the thread. fig's line is just the carrier here — none
   * of fig's agent, session, tools, or persona is involved. If spot's server is down,
   * surfaces a clean error instead of going silent.
   */
  private async runSpotTurn(ownerItems: InboundItem[]): Promise<void> {
    const text = ownerItems
      .map((i) => i.text)
      .filter(Boolean)
      .join("\n");
    const media = ownerItems.flatMap((i) => i.media);
    this.startTyping();
    try {
      const reply = await spotLane.relayOwnerMessage(text, media);
      await this.deliver(reply);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`spot relay failed — ${msg}`);
      // The recovery hint (where spot runs, how to start it) is the personal lane's
      // knowledge, so the whole owner-facing line comes from it.
      await this.transport.send(this.replyTo, spotLane.relayDownReply(msg)).catch(() => {});
    } finally {
      this.stopTyping();
    }
  }

  private askOwner = async (question: string, prompt?: ApprovalPrompt): Promise<boolean> => {
    // Each 🔐 carries its own short id, LEADING the body. Three retries of the same action
    // used to produce three byte-identical bubbles and they tapped a dead one out of
    // scrollback twice; the id is what makes them tellable apart, and it's first because a
    // tapback only quotes the opening ~80 chars back to us. See approvalPrompt.ts.
    const id = nextApprovalId();
    const body = approvalBody(question, id);
    // A system-attached screenshot of what they're being asked to approve (browser/desktop 🔐 only
    // — see specialists/approvalScreenshot.ts). imsg sends the attachment first and the text as
    // its own bubble, so they see the state and THEN the question, and the question stays the
    // single clean tapback target. fileAttachmentOpts is no-throw and returns null for a
    // missing/oversized/unreadable file, so a bad path degrades to the plain prompt.
    //
    // `prompt.image` is the DEFERRED form: a system-built preview (the rendered approval card on
    // the CLI money path) that needs the id we just minted, so the picture carries the same `#a3f`
    // tag as this text bubble. Resolved here — after the id exists, before the send — and it can
    // only ever yield null, in which case the 🔐 goes out as text with the store and total still
    // in it.
    const previewPath = prompt?.imagePath ?? (prompt?.image ? await resolveApprovalImage(prompt.image, id) : null);
    const shot = previewPath ? fileAttachmentOpts(previewPath) : null;
    // Send the prompt FIRST and surface a failure. A swallowed send error used to
    // leave the approval dangling — no prompt reached them, yet the tool sat waiting
    // until it silently timed out to "deny" 2 min later ("not re-proposing"). If the
    // relay can't deliver the 🔐, deny immediately and loudly so we don't go quiet.
    try {
      if (shot) {
        // The image is a nicety; the question is the safety surface. If the attachment send
        // fails (relay hiccup, oversized payload), retry text-only rather than letting a
        // screenshot turn into a silent auto-deny of something they'd have approved.
        try {
          await this.transport.send(this.replyTo, body, shot);
        } catch (e) {
          warn(`approval screenshot send failed — retrying the 🔐 as text: ${e}`);
          await this.transport.send(this.replyTo, body);
        }
      } else {
        await this.transport.send(this.replyTo, body);
      }
    } catch (e) {
      warn(`approval prompt failed to send → auto-deny: ${e}`);
      return false;
    }
    // One message, so there's a single clear target to tapback. 👍/👎 tapback approves
    // or denies (a typed yes/no still works too — see approvalDecision in index.ts).
    return new Promise((resolve) => {
      this.pendingApproval = { id, question, resolve };
      setTimeout(() => {
        // Identity-checked: only expire the prompt this timer was armed for. Two async
        // browse jobs can each be holding a 🔐, and a 10-min window makes that overlap
        // real — an unchecked `if (this.pendingApproval)` would kill the wrong one.
        if (this.pendingApproval?.id !== id) return;
        this.pendingApproval = null;
        warn(`approval #${id} timed out after ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s → deny`);
        // Remembered so a late 👍 gets an answer instead of silence, and marked dead in
        // the thread so the bubble above it can't be mistaken for still-live.
        noteExpired({ id, question, expiredAt: Date.now() });
        void this.transport.send(this.replyTo, expiryNotice(question, id)).catch(() => {});
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
    });
  };

  /**
   * A 👍/👎 that arrived with no approval outstanding. If it names a 🔐 we know timed out,
   * say so plainly. Without it a late approval hits nothing at all, and from their side they
   * approved and the world just stayed still. Deliberately does NOT re-arm or re-run the dead
   * action: the job
   * that raised it is gone, and silently resurrecting a money-path click on a stale yes is
   * exactly the thing the gate exists to prevent. Returns true if it handled the message.
   */
  handleLateApproval(text: string, approved: boolean): boolean {
    const dead = matchExpired(text);
    if (!dead) return false;
    log(`late ${approved ? "👍" : "👎"} on expired approval #${dead.id} — telling them, not resuming`);
    void this.transport.send(this.replyTo, lateDecisionNotice(dead, approved)).catch(() => {});
    return true;
  }

  /**
   * True when this message's tapback quotes a 🔐 that has already expired — i.e. they tapped a
   * dead bubble out of scrollback while a DIFFERENT prompt happens to be live. Routing it to
   * the live one would spend a yes they gave to some other action, which on the money path is
   * the failure that actually costs something. Only fires on an explicit id match; an
   * untagged yes/no still resolves the live prompt exactly as before.
   */
  isStaleApprovalTarget(text: string): boolean {
    const id = approvalIdIn(text);
    if (!id || !this.pendingApproval) return false;
    return id !== this.pendingApproval.id && matchExpired(text) !== null;
  }

  /** Begin (and keep alive) the typing indicator for the current turn. */
  private startTyping(): void {
    const ping = () => void this.transport.typing?.(this.replyTo).catch(() => {});
    ping();
    if (this.typingTimer) clearInterval(this.typingTimer);
    // Re-assert well under the relay's ~60s expiry so it never lapses on long turns.
    this.typingTimer = setInterval(ping, 30_000);
  }

  /** Clear the typing keepalive and tell the transport to drop the indicator now. */
  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    void this.transport.stopTyping?.(this.replyTo).catch(() => {});
  }

  /**
   * Render + paced delivery of a reply to the current reply target. The full rendering
   * path (chunking, tapback, inline images, effects, draft-token expansion, transcript
   * logging) lives in render/deliver.ts so a concurrent /btw background lane renders
   * identically; this just threads in this exchange's target, tapback id, and abort signal.
   */
  private deliver(raw: string): Promise<void> {
    return deliverReply({
      transport: this.transport,
      to: this.replyTo,
      raw,
      lastInboundId: this.lastInboundId,
      replyToId: this.replyThreadTarget,
      signal: this.currentAbort?.signal,
    });
  }

  /**
   * React on the owner's most recent message — the `ack({ tapback })` path. Targets
   * `lastInboundId` (the same message a lone-emoji reply would land on), so the
   * reaction reads as "heard THIS". Returns false when there's nothing to react
   * to or the channel refused it; the ack then falls back to a text bubble.
   */
  private tapback(emoji: string): Promise<boolean> {
    if (this.currentAbort?.signal.aborted) return Promise.resolve(false);
    return deliverTapback({
      transport: this.transport,
      to: this.replyTo,
      messageId: this.lastInboundId,
      emoji,
    });
  }
}
