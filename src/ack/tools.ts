import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";

// Full SDK tool name once the server is registered under the "ack" key in session.ts.
// The session loop matches on this to lift the opener out of the tool-call's input.
export const ACK_TOOL_NAME = "mcp__ack__ack";

/**
 * The ack tool: the ONE structured channel for the opener — the first thing the owner
 * sees, the "heard you, on it" beat before any unseen work. It exists because the old
 * mechanism ("whatever text the model emits first becomes the opener") happily shipped
 * stage-directions like "send opener, then dig into the docs" straight to them. Now the
 * opener comes only from this call's `text` arg; the session loop reads that arg and
 * delivers it. Everything the model says afterward, until its final reply, is suppressed.
 *
 * The handler itself is a near-noop: delivery happens in the session loop (which sees the
 * tool_use block and its input as the assistant message streams), not here — so the opener
 * flows through the same onText path as every other bubble (chunking, transcript, and the
 * lone-emoji→tapback conversion all for free).
 */
export const ackServerDef = defineServer({
  key: "ack",
  kind: "direct",
  purpose: "the one structured channel for the opener — the first thing the owner sees before any unseen work",
  exposure: "live-only",
  reason:
    "live-turn opener mechanism — its handler literally reports 'opener delivered to the owner', and an unattended pass delivers exactly one message through the <output> contract",
  // The ack is the FIRST move of nearly every turn, so it must be in the turn-1 prompt —
  // never deferred behind tool search. If it's deferred, the model is forced to call
  // ToolSearch to load its schema before it can ack; that ToolSearch counts as "work
  // started" and trips the auto-ack 👍 backstop, which then clobbers the real ack text —
  // the tapback fires and the opener bubble never sends. alwaysLoad pins it so ack is
  // callable immediately with no schema fetch.
  alwaysLoad: true,
  capabilities: [
    {
      name: "ack",
      purpose: "the one structured channel for the opener — the first thing the owner sees before any unseen work",
      mutates: "write",
      namingException:
        "this server exists for exactly one capability and the capability IS the ack; every alternative spelling is a synonym. `mcp__ack__ack` is also load-bearing — session.ts matches on ACK_TOOL_NAME to lift the opener out of the tool-call input.",
      description:
        'Send your opening acknowledgement to the owner — the FIRST thing they see, confirming you heard them and you are on it. Call this BEFORE any real work: a tool call, a file edit, spawning a specialist, research, anything that takes more than a beat. Two independent fields, at least one required: `tapback` puts a REACTION on the message they just sent (any single emoji — 👍 💀 🔥 🎉 — not just the classic six), and `text` sends a bubble. Pass both to react AND speak (`{tapback:"😂", text:"sec"}` = the 😂 lands on their message, then "sec" arrives as its own bubble) — that is the natural shape, and it is why they are separate fields: an emoji written inside `text` is just text and ships as a bubble. Whatever you pass is delivered IMMEDIATELY; everything you say after it, until your final reply, is suppressed and never reaches them — so do NOT narrate your plan here, just a short human ack in your voice ("bet, sec" / "on it" / "checking"). You do NOT need this for an instant reply with no work behind it — in that case just answer, and never announce that you are skipping the ack (no "no ack needed" / "just us talking") — just talk like a normal person. But whenever you are about to go do something, ack first; at minimum a 👍 tapback.',
      input: {
        text: z
          .string()
          .optional()
          .describe(
            'The short opener the owner sees as a BUBBLE, in fig\'s voice — e.g. "bet, sec", "on it", "checking the cal". Optional when `tapback` is set.',
          ),
        tapback: z
          .string()
          .optional()
          .describe(
            'A single emoji to land as a REACTION on the owner\'s latest message — "👍", "😂", "💀", "🎉". Any emoji works, not just the classic six. Optional when `text` is set. Never put a sentence here.',
          ),
      },
      // Near-noop by design (delivery happens in the session loop), but it does
      // enforce the one real rule: at least one of the two fields. An empty ack
      // would otherwise "succeed" while the owner sees nothing at all.
      handler: async (input: { text?: string; tapback?: string }) => {
        const intent = parseAckIntent(input);
        if (!intent.tapback && !intent.text) {
          return "ack did NOT send anything — it needs `text`, `tapback`, or both. Call it again with one of them.";
        }
        return "opener delivered to the owner. now do the work silently — everything until your final reply is suppressed.";
      },
    },
  ],
});

export const ackServer = toSdkServer(ackServerDef);

/** What an `ack` tool call actually asked for, after validation. */
export interface AckIntent {
  /** A single emoji to react with on the latest inbound. */
  tapback?: string;
  /** Bubble text to deliver. */
  text?: string;
}

/**
 * Read an `ack` tool-call's input into the two things the harness acts on.
 *
 * Deliberately dumb: `tapback` is a reaction ONLY if it is exactly one emoji,
 * and `text` is bubble text verbatim. There is no path that mines an emoji out
 * of `text` — "😂 sec" written as text stays one bubble, exactly as written.
 * That heuristic is what this whole explicit-field shape replaces (a reply of
 * "💀 this is cursed" must never be torn into a reaction plus a sentence).
 *
 * Backward compatible: an old-style `{ text: "checking" }` parses to text-only,
 * and a lone mapped emoji passed as `text` still converts downstream in
 * deliverReply, which is where that (single-emoji-only) rule already lives.
 */
export function parseAckIntent(input: unknown): AckIntent {
  const raw = (input ?? {}) as { text?: unknown; tapback?: unknown };
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const tapbackRaw = typeof raw.tapback === "string" ? raw.tapback.trim() : "";
  const intent: AckIntent = {};
  if (tapbackRaw && isSingleEmoji(tapbackRaw)) intent.tapback = tapbackRaw;
  // A non-emoji `tapback` (the model writing a sentence into the wrong field) is
  // NOT dropped — it becomes text, so the ack still reaches the owner.
  const extra = tapbackRaw && !intent.tapback ? tapbackRaw : "";
  const combined = [extra, text].filter(Boolean).join(" ").trim();
  if (combined) intent.text = combined;
  return intent;
}

/**
 * Exactly one emoji grapheme — the only thing iMessage accepts as a tapback.
 * Mirrors imsg's own `isSingleEmojiGrapheme` (flags, ZWJ families, skin tones
 * and keycaps pass; prose, bare letters and "😂 sec" do not).
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(trimmed)];
  if (graphemes.length !== 1) return false;
  // Pictographic covers the vast majority (including ZWJ families and skin
  // tones, which segment as one grapheme). Keycaps (1️⃣) and flags (🇺🇸) are
  // built from non-pictographic scalars, so they get their own checks.
  if (/\p{Extended_Pictographic}/u.test(trimmed)) return true;
  if (/^[0-9#*]️?⃣$/u.test(trimmed)) return true;
  return /^\p{Regional_Indicator}{2}$/u.test(trimmed);
}
