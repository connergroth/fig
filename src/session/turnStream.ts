import { deliverAck } from "../ack/deliver";
import { ACK_TOOL_NAME } from "../ack/tools";
import { isSilence } from "../render/chunking";
import { deliveredTextIsExhaustion, describeSdkError } from "../runtimes/claude";

/**
 * Shared per-message stream processor for a single fig turn.
 *
 * The main loop can run a turn two ways now — a persistent WARM streaming session
 * (session/warmSession.ts, the default) or a COLD one-shot query() (session.ts's
 * fallback path). Both consume the SDK message stream identically: an `ack` tool call
 * is the up-front opener, tool calls reset the candidate final-reply buffer, and the
 * closing text (or the SDK's result text) is the final reply. That extraction logic
 * used to live inline in runTurn; it's lifted here VERBATIM so the warm and cold paths
 * can't drift apart. Only the plumbing (emit, onWorkStarted, session capture) is passed
 * in via `ctx`.
 *
 * The processor handles ONLY the in-stream message handling and mutates `state`. All the
 * post-turn control flow (overload → next model, provider exhaustion → codex fallback,
 * the "tool turn with no final reply" failure check) stays in each caller, unchanged.
 */

/** Tools that deliver a user-facing payload straight to the owner (bypassing `emit`, so they
 *  never bump `sent`). A turn whose only output is one of these is still a complete turn. */
export const USER_DELIVERING_TOOLS = new Set([
  "mcp__image__generate",
  "mcp__image__send_file",
  "mcp__image__send_carousel",
]);

export interface TurnState {
  /** Assistant text since the last tool call — the candidate final reply. */
  reply: string[];
  /** Count of bubbles actually handed to `emit` this turn (opener + final). */
  sent: number;
  /** fig chose to stay quiet (the SILENCE_TOKEN) — not an error. */
  silenced: boolean;
  /** Surfaced error (assistant_error / result:subtype / exhaustion text). */
  resultError?: string;
  /** onWorkStarted has fired (first non-ack tool). */
  workStartedNotified: boolean;
  /** Delivered a genuine `ack` tool call's text. */
  realAckSent: boolean;
  /** A tool call appeared — an opener alone is then not a complete answer. */
  toolSeen: boolean;
  /** A tool sent its own user-facing payload (image/file/carousel). */
  payloadDelivered: boolean;
  /** The buffered final reply was delivered. */
  finalSent: boolean;
  /** Most recent turn's total input context, for the size-rollover check. */
  lastContext: number;
  /** The `result` message for this turn has arrived — the turn is complete. */
  done: boolean;
}

export function newTurnState(): TurnState {
  return {
    reply: [],
    sent: 0,
    silenced: false,
    resultError: undefined,
    workStartedNotified: false,
    realAckSent: false,
    toolSeen: false,
    payloadDelivered: false,
    finalSent: false,
    lastContext: 0,
    done: false,
  };
}

export interface TurnStreamCtx {
  /** Deliver a bubble to the owner (the probe-aware / target-scoped wrapper from the caller). */
  emit: (text: string) => Promise<void>;
  /**
   * React on the owner's latest inbound with one emoji — the `ack({ tapback })` path.
   * Returns false when the channel can't react (no target, no transport support,
   * bridge error), and the caller then falls back to a text bubble so an ack is
   * never silently lost. Omitted by lanes with no reaction target.
   */
  tapback?: (emoji: string) => Promise<boolean>;
  /** Fired once, the first time REAL work starts (first non-ack tool). */
  onWorkStarted?: () => void;
  /** Capture the live session id (+ optional context size) — persist + local bookkeeping. */
  onSession?: (id: string, contextTokens?: number) => void;
}

/**
 * Process ONE SDK message for the current turn, mutating `state`. Mirrors the exact
 * switch that used to sit inline in runTurn (session.ts). Sets `state.done` when the
 * turn's `result` message arrives.
 */
export async function processTurnMessage(msg: any, state: TurnState, ctx: TurnStreamCtx): Promise<void> {
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) ctx.onSession?.(msg.session_id);
      break;
    }
    case "assistant": {
      const am = msg as any;
      if (am.parent_tool_use_id) break; // subagent output — internal, not for the user
      // Track the live context size from the orchestrator's own usage so a grown session
      // rolls over (see loadSession's size cap).
      const u = am.message?.usage;
      if (u) {
        state.lastContext =
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      }
      if (am.error) state.resultError = describeSdkError("assistant_error", am.error);
      const blocks = am.message?.content ?? [];
      const texts = blocks
        .filter((b: any) => b.type === "text" && b.text.trim())
        .map((b: any) => b.text)
        .join("\n\n")
        .trim();
      const toolBlocks = blocks.filter((b: any) => b.type === "tool_use");
      const hasTool = toolBlocks.length > 0;
      if (hasTool) state.toolSeen = true;
      if (texts && deliveredTextIsExhaustion(texts)) {
        state.resultError = texts;
        break;
      }
      // Opener path: the model called `ack`. Its `text` arg is the opener — deliver it now.
      // Gate on realAckSent so a genuine ack always delivers its text.
      const ackBlock = toolBlocks.find((b: any) => b.name === ACK_TOOL_NAME);
      if (ackBlock && !state.realAckSent) {
        // `tapback` reacts on their latest message, `text` is the bubble; either
        // may be absent and both may be present (see ack/deliver.ts).
        const delivered = await deliverAck(ackBlock.input, { emit: ctx.emit, tapback: ctx.tapback });
        if (delivered.silenced) state.silenced = true;
        state.sent += delivered.sent;
        state.realAckSent = true;
      }
      // Real work just began — tell the conversation, so a message arriving from here on
      // queues behind this turn instead of aborting it (see enqueue()).
      const startedWork = toolBlocks.some((b: any) => b.name !== ACK_TOOL_NAME);
      if (startedWork && !state.workStartedNotified) {
        state.workStartedNotified = true;
        ctx.onWorkStarted?.();
      }
      // Payload-delivering tools (image generate / send_file / send_carousel) send straight
      // to the owner without going through `emit`, so `sent` stays 0 — track it explicitly.
      if (toolBlocks.some((b: any) => USER_DELIVERING_TOOLS.has(b.name))) state.payloadDelivered = true;
      // All other free-form text before the final reply is narration. Once a tool appears,
      // reset the buffer so only text AFTER the last tool survives as the final reply.
      if (hasTool) {
        state.reply = [];
        break;
      }
      if (texts) state.reply.push(texts);
      break;
    }
    case "result": {
      const rm = msg as any;
      if (rm.session_id) ctx.onSession?.(rm.session_id, state.lastContext || undefined);
      if (rm.subtype && rm.subtype !== "success")
        state.resultError = describeSdkError(`result:${rm.subtype}`, rm.result, rm.error);
      // Deliver the buffered final reply. If we sent NOTHING at all this turn, fall back
      // to the SDK's result text — guarded by sent===0 so we never re-send.
      const finalText = state.reply.join("\n\n").trim();
      if (state.silenced || isSilence(finalText)) {
        state.silenced = true; // intentional no-reply — deliver nothing, no warning
      } else if (finalText && deliveredTextIsExhaustion(finalText)) {
        state.resultError = finalText;
      } else if (finalText) {
        await ctx.emit(finalText);
        state.sent++;
        state.finalSent = true;
      } else if (state.sent === 0 && typeof rm.result === "string" && rm.result.trim() && !isSilence(rm.result)) {
        const resultText = rm.result.trim();
        if (deliveredTextIsExhaustion(resultText)) {
          state.resultError = resultText;
        } else {
          await ctx.emit(resultText);
          state.sent++;
          state.finalSent = true;
        }
      }
      state.done = true;
      break;
    }
  }
}
