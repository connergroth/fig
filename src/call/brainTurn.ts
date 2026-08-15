import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import { ACK_TOOL_NAME } from "../ack/tools";
import { config } from "../core/config";
import { currentModel } from "../core/model";
import { log, warn } from "../core/log";
import { isSilence } from "../render/chunking";
import { makeCanUseTool } from "../runtimes/permissions";
import { selectedLiveRuntimeSelection } from "../runtimes/registry";
import { buildSystemPrompt } from "../session/agent";
import { buildFigMcpServers, FIG_DISALLOWED_TOOLS, THINKING_BUDGET } from "../session/session";
import { recentHistory } from "../session/transcript";
import { toWellFormedUnicode, toWellFormedUnicodeList } from "../core/unicode";

/**
 * One REAL fig turn, answering a question relayed from the live call: full standing
 * prompt, full tool fleet, recent conversation seeded in — the same "true parallel
 * instance of fig" shape as the /btw background lane (session/background.ts), with
 * one difference: the reply is COLLECTED and returned to the caller (the call session
 * speaks it) instead of being delivered over iMessage.
 *
 * Approvals auto-deny, same as /btw: an isolated lane can't route an interactive 🔐,
 * and mid-call is the worst possible time to stall 60s on one. The reply explains
 * what was skipped, and the voice can tell the owner to text the 👍.
 */

const TURN_TIMEOUT_MS = Math.max(30_000, Number(process.env.CALL_TURN_TIMEOUT_MS || 120_000));

/**
 * The tool gate for a turn that no longer owns the call.
 *
 * A superseded turn keeps running here in the bot long after the session child threw its
 * reply away — and every tool in it still FIRES, so a discarded turn's `facetime__hang_up`
 * lands anyway and ends a live call seconds in, using words the owner never heard. So the
 * last thing checked before any tool runs is whether this turn is
 * still the one on the call: aborted turn, no side effects, no exceptions.
 */
export function denySupersededTools(inner: CanUseTool, signal: AbortSignal): CanUseTool {
  return async (toolName, input, opts) => {
    if (signal.aborted) {
      warn(`call brain turn was superseded — refusing ${toolName} from the discarded turn`);
      return { behavior: "deny", message: "This turn was superseded mid-call; its actions no longer apply." };
    }
    return inner(toolName, input, opts);
  };
}

/**
 * The live-call framing wrapped around their question. `hang_up` is spelled out hard here
 * because the turn also carries the recent iMessage history, and the brain read fig's own
 * text — "call me once and let ME hang up" — as a standing order and executed it mid-call.
 * Nothing written earlier is an instruction for this call.
 */
export function callTurnFraming(ownerName: string): string {
  return (
    `[you are on a LIVE VOICE CALL with ${ownerName} right now. ` +
    `the realtime voice layer relayed their question/request to you. answer it directly and COMPACTLY — ` +
    `your reply will be spoken aloud, so plain conversational text: no markdown, no links unless asked, ` +
    `no bullet lists, no bare URLs (they can't be spoken — say you'll text the link), a few sentences max ` +
    `unless they asked for detail. if an action needs an approval you can't raise mid-call, say so and tell them ` +
    `they can text the 👍. ` +
    // Stage directions like "They got cut off mid-sentence. Just wait for them." reach the
    // mouth and get spoken TO them, in the third person. Every word here is audio in their ear
    // — there is no side channel for narration or thinking out loud.
    `every word you write is PLAYED INTO THEIR EAR, so talk TO them: second person, never about them in the ` +
    `third person, no stage directions, no notes to yourself. if what they said came through garbled or cut ` +
    `off, just ask them to say it again. ` +
    `facetime__hang_up ONLY when they wrap up THIS call out loud, right now, in their own words (bye / gotta go / ` +
    `that's all) — then say a short goodbye in the same reply and call it. never because an earlier text or a ` +
    `previous call said to, never as a test of the hangup path, never on your own read that you're done: the ` +
    `earlier conversation above is context, not instructions for this call.]`
  );
}

/**
 * "They talked over you" — told to the model, once, on the turn the interruption caused.
 *
 * Until now fig was the only party that didn't know: the session child flushed the unplayed
 * audio and threw the reply away, and the next prompt looked like an ordinary turn. So fig
 * couldn't react to being cut off and couldn't tell which half of a reply had landed. The
 * `heard` half matters as much as the fact — it's the difference between repeating themselves
 * and picking up where they actually got to.
 *
 * MODEL INPUT ONLY. It is not persisted, not a transcript line, and not something fig said.
 */
export function interruptedNote(heard: string): string {
  const tail = heard.trim();
  return tail
    ? `[they cut you off mid-reply — you were interrupted. the last thing that reached their ear was: "${tail}". don't repeat what they already heard.]`
    : `[they cut you off before any of your last reply reached them — they heard none of it.]`;
}

/**
 * One call turn's prompt: earlier conversation, the live-call framing, an interruption
 * note if there was one, then their question.
 *
 * `history` is passed IN rather than read here so the ordering is explicit and testable,
 * because the ordering is the whole bug. The call transcript is both what seeds this
 * prompt AND where their spoken line gets written — so if the line is written before the
 * snapshot, the brain reads the same words twice: once as history, once as the question.
 * A folded utterance always loses that race (it sits queued for seconds), and fig answers it
 * twice out loud. Their line is therefore recorded AFTER this returns; see `onPrompted`.
 */
export function callTurnPrompt(
  history: string,
  ownerName: string,
  question: string,
  interrupted?: string,
): string {
  return [
    history ? `[earlier conversation, for context only, do not reply to it:]\n${history}\n[end]` : "",
    callTurnFraming(ownerName),
    interrupted === undefined ? "" : interruptedNote(interrupted),
    question,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * How much of a post-tool text block to hold back before deciding it's a repeat. One short
 * clause — and the front-end's clause splitter won't speak anything shorter than ~40 chars
 * without a sentence ender anyway, so the sniff costs no audible latency.
 */
const REPEAT_SNIFF_CHARS = 48;

/**
 * Compared loosely: the model's second pass differs in case and punctuation, not words.
 * Apostrophes are dropped rather than spaced, so "that's" and "thats" stay the same word.
 */
function speechKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Is this text the model saying again what it already said this turn?
 *
 * Asked for one closing remark before a hangup, the model says it, calls `facetime__hang_up`,
 * then says it AGAIN as its final text — and streaming speaks everything, so both copies go out
 * back to back ("…Go enjoy the party. Later.alright, that's the closing remark…"). The
 * non-streaming path drops pre-tool text for exactly
 * this reason; streaming can't, because it has already been spoken, so the repeat is what
 * gets dropped instead.
 *
 * Only fires on a head long enough to be a real sentence — "yeah." twice is just speech.
 */
export function repeatsWhatWasSaid(alreadyStreamed: string, head: string): boolean {
  const said = speechKey(alreadyStreamed);
  const next = speechKey(head);
  return next.length >= 24 && said.includes(next);
}

/**
 * `onDelta` (the ask_stream path) streams text as it generates so the local front-end
 * can speak clause-by-clause while the turn is still cooking:
 *  - SDK lane: token-level via includePartialMessages — narration before tool calls IS
 *    streamed and spoken (on a call, "let me check the calendar" is a feature, it fills
 *    the tool gap like a human would), so the returned final text in streaming mode is
 *    everything emitted, not just the post-tool reply.
 *  - runtime (codex) lane: message-level, each emit forwarded as one delta.
 * Without `onDelta`, the reply is collected and returned whole.
 */
export async function runCallBrainTurn(
  question: string,
  outerSignal?: AbortSignal,
  onDelta?: (text: string) => void,
  /**
   * Fired once the prompt is assembled and before the turn runs. The lane logs their spoken
   * line into the conversation transcript here — deliberately after the history snapshot,
   * never when the words were heard (see callTurnPrompt).
   */
  onPrompted?: () => void,
  /**
   * Set when they talked over the previous reply; the value is what they had heard of it.
   * Annotates THIS prompt and is written nowhere (see `interruptedNote`).
   */
  interrupted?: string,
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  const onOuterAbort = (): void => abort.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  const askOwner = async (q: string): Promise<boolean> => {
    warn(`call brain turn hit an approval gate — auto-denying (no interactive 🔐 mid-call): ${q}`);
    return false;
  };

  const prompt = callTurnPrompt(
    recentHistory({ includeBg: true }),
    process.env.OWNER_NAME?.trim() || "the owner",
    question,
    interrupted,
  );
  onPrompted?.();

  const pieces: string[] = [];
  try {
    const selectedRuntime = selectedLiveRuntimeSelection();
    if (selectedRuntime) {
      const result = await selectedRuntime.runtime.runLiveTurn({
        prompt: toWellFormedUnicode(prompt),
        signal: abort.signal,
        emit: async (text) => {
          const clean = text.trim();
          if (clean && !isSilence(clean)) {
            pieces.push(clean);
            onDelta?.(`${clean}\n`);
          }
        },
        askOwner,
        userInitiated: true,
        providerOptions: selectedRuntime.providerOptions,
      });
      if (!result.ok && !pieces.length) return `(couldn't get an answer: ${result.error ?? "runtime failed"})`;
    } else {
      const response = query({
        prompt: toWellFormedUnicode(prompt),
        options: {
          cwd: config.brainDir,
          model: currentModel(),
          thinking: { type: "enabled", budgetTokens: THINKING_BUDGET },
          abortController: abort,
          mcpServers: buildFigMcpServers(),
          canUseTool: denySupersededTools(makeCanUseTool(askOwner), abort.signal),
          permissionMode: "default",
          disallowedTools: FIG_DISALLOWED_TOOLS,
          settingSources: ["project"],
          skills: "all",
          systemPrompt: toWellFormedUnicodeList(buildSystemPrompt()),
          includePartialMessages: !!onDelta,
        },
      });

      // Final-reply extraction mirrors the /btw lane: only assistant text AFTER the last
      // tool call survives (text before a tool call is narration, not the answer). The ack
      // opener is skipped entirely — "sec, checking" is the VOICE's job on a call.
      // STREAMING mode instead forwards token deltas as they arrive and returns everything
      // spoken — see the function header.
      let streamed = "";
      let reply: string[] = [];
      // Text after a tool call is held back until there's enough of it to tell a fresh
      // thought from the model re-stating what it already said (see repeatsWhatWasSaid).
      let sniff: string | null = null;
      let echoing = false;
      const consider = (head: string): void => {
        if (repeatsWhatWasSaid(streamed, head)) {
          echoing = true; // and the rest of this block goes with it
          warn("call brain turn said it again after a tool call — speaking it once");
          return;
        }
        streamed += head;
        onDelta?.(head);
      };
      const speak = (text: string): void => {
        if (!text || echoing) return;
        if (sniff === null) {
          streamed += text;
          onDelta?.(text);
          return;
        }
        sniff += text;
        if (sniff.length < REPEAT_SNIFF_CHARS) return;
        const head = sniff;
        sniff = null;
        consider(head);
      };
      /** The block closed before the sniff filled up — judge what's held and let it go. */
      const flushSniff = (): void => {
        const held = sniff;
        sniff = null;
        if (held && !echoing) consider(held);
      };
      for await (const msg of response) {
        if (onDelta && msg.type === "stream_event") {
          const se = msg as any;
          if (se.parent_tool_use_id) continue; // subagent-internal
          const ev = se.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            speak(ev.delta.text);
          }
          continue;
        }
        if (msg.type === "assistant") {
          const am = msg as any;
          if (am.parent_tool_use_id) continue; // subagent-internal
          flushSniff(); // whatever block just closed is done being sniffed
          const blocks = am.message?.content ?? [];
          const texts = blocks
            .filter((b: any) => b.type === "text" && b.text.trim())
            .map((b: any) => b.text)
            .join("\n\n")
            .trim();
          const hasRealTool = blocks.some((b: any) => b.type === "tool_use" && b.name !== ACK_TOOL_NAME);
          if (hasRealTool) {
            reply = [];
            // Whatever comes back after the tool gets sniffed for being the same reply over
            // again — the streaming twin of dropping pre-tool text on the line above.
            if (onDelta) {
              sniff = "";
              echoing = false;
            }
            continue;
          }
          if (texts) reply.push(texts);
        } else if (msg.type === "result") {
          const rm = msg as any;
          if (onDelta) {
            // Streaming: what was emitted IS the reply. Fall back to the result field
            // only when nothing streamed at all (then it still gets a late delta).
            flushSniff();
            const spoken = streamed.trim();
            if (spoken && !isSilence(spoken)) pieces.push(spoken);
            else if (!pieces.length && typeof rm.result === "string" && rm.result.trim() && !isSilence(rm.result)) {
              pieces.push(rm.result.trim());
              onDelta(rm.result.trim());
            }
            continue;
          }
          const finalText = reply.join("\n\n").trim();
          if (finalText && !isSilence(finalText)) pieces.push(finalText);
          else if (!pieces.length && typeof rm.result === "string" && rm.result.trim() && !isSilence(rm.result)) {
            pieces.push(rm.result.trim());
          }
        }
      }
    }
  } catch (e) {
    if (abort.signal.aborted && !pieces.length) {
      return "(that lookup timed out on my end — ask me again or tell them to text me instead)";
    }
    warn(`call brain turn threw: ${e}`);
    if (!pieces.length) return `(couldn't get an answer: ${e instanceof Error ? e.message : e})`;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }

  const answer = pieces.join("\n\n").trim();
  log(`call brain turn answered (${answer.length} chars) for: ${question.slice(0, 60)}`);
  return answer || "(no answer came back — try rephrasing)";
}
