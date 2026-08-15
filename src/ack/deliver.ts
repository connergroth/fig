import { isSilence, naturalChunkDelayMs, sleep } from "../render/chunking";
import { warn } from "../core/log";
import { parseAckIntent } from "./tools";

/** The channels an ack can be delivered through, supplied by whichever lane is running. */
export interface AckSinks {
  /** Send a bubble (already target-scoped by the lane). */
  emit: (text: string) => Promise<void>;
  /**
   * React on the owner's latest inbound. Returns false when the lane can't react
   * (no target / no transport support / bridge failure), which is what triggers
   * the text fallback below.
   */
  tapback?: (emoji: string) => Promise<boolean>;
  /** Injectable pause (tests pass a no-op). Defaults to a real sleep. */
  pause?: (ms: number) => Promise<void>;
}

export interface AckDelivery {
  /** How many things actually reached the owner (reaction and/or bubble). */
  sent: number;
  /** The ack was the silence sentinel — deliberately deliver nothing. */
  silenced: boolean;
}

/**
 * Deliver ONE `ack` tool call: react, pause, then speak.
 *
 * The order is the point. A tapback lands on the message the owner just sent, so it
 * reads as "heard you" the instant it appears; the bubble that follows is the
 * "…and here's what I'm doing". Doing it the other way round makes the reaction
 * look like a comment on fig's own bubble.
 *
 * The pause between them is load-bearing too: firing both in the same instant is
 * something a person physically can't do — you tap the reaction, THEN type. So the
 * bubble waits out the same natural beat used between any two bubbles.
 *
 * Nothing here parses emoji out of prose — `tapback` and `text` are separate
 * fields precisely so "😂 sec" can mean "react 😂, then say sec" without any
 * heuristic that would also tear apart "💀 this is cursed".
 *
 * Every lane (warm, cold, /bg, codex bridge) routes through this so they can't
 * drift on ordering, the silence sentinel, or the fallback.
 */
export async function deliverAck(input: unknown, sinks: AckSinks): Promise<AckDelivery> {
  const intent = parseAckIntent(input);
  // A silence-sentinel ack means "say nothing at all" — including the reaction.
  if (intent.text && isSilence(intent.text)) return { sent: 0, silenced: true };

  let sent = 0;
  let pendingEmojiText: string | null = null;
  if (intent.tapback) {
    let reacted = false;
    try {
      reacted = (await sinks.tapback?.(intent.tapback)) ?? false;
    } catch (e) {
      warn(`ack tapback threw: ${e}`);
    }
    if (reacted) sent++;
    // Couldn't react (no target, or the bridge refused the emoji): the ack still
    // has to reach them, so the emoji rides along as text rather than vanishing.
    else pendingEmojiText = intent.tapback;
  }

  const text = [pendingEmojiText, intent.text].filter(Boolean).join(" ").trim();
  if (text) {
    // Only when a reaction actually LANDED — a fallback bubble carrying the emoji
    // as text is one message, and nothing came before it to space away from.
    if (sent > 0) await (sinks.pause ?? sleep)(naturalChunkDelayMs(intent.tapback ?? ""));
    await sinks.emit(text);
    sent++;
  }
  return { sent, silenced: false };
}
