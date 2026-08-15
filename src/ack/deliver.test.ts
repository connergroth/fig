import assert from "node:assert/strict";

import { deliverAck } from "./deliver";
import { isSingleEmoji, parseAckIntent } from "./tools";
import { SILENCE_TOKEN } from "../render/chunking";

/** Records what each sink was handed, in call order, so ORDER can be asserted. */
function makeSinks(opts: { reactOk?: boolean; reactThrows?: boolean } = {}) {
  const order: string[] = [];
  const emitted: string[] = [];
  const reacted: string[] = [];
  const paused: number[] = [];
  return {
    order,
    emitted,
    reacted,
    paused,
    sinks: {
      // Tests never actually sleep — they assert the pause was requested.
      pause: async (ms: number): Promise<void> => {
        order.push("pause");
        paused.push(ms);
      },
      emit: async (text: string): Promise<void> => {
        order.push(`emit:${text}`);
        emitted.push(text);
      },
      tapback: async (emoji: string): Promise<boolean> => {
        order.push(`react:${emoji}`);
        if (opts.reactThrows) throw new Error("bridge down");
        reacted.push(emoji);
        return opts.reactOk ?? true;
      },
    },
  };
}

/** Backward compat: the old single-field call still delivers exactly one bubble. */
async function textOnlyAckIsUnchanged(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  const out = await deliverAck({ text: "checking" }, sinks);
  assert.deepEqual(emitted, ["checking"]);
  assert.deepEqual(reacted, []);
  assert.equal(out.sent, 1);
  assert.equal(out.silenced, false);
}

/** A tapback-only ack reacts and sends NO bubble. */
async function tapbackOnlyAckReactsWithoutABubble(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  const out = await deliverAck({ tapback: "👍" }, sinks);
  assert.deepEqual(reacted, ["👍"]);
  assert.deepEqual(emitted, []);
  assert.equal(out.sent, 1);
}

/** Both fields: react FIRST (on their message), then the bubble. Order is load-bearing. */
async function bothFieldsReactBeforeSpeaking(): Promise<void> {
  const { sinks, order } = makeSinks();
  const out = await deliverAck({ tapback: "😂", text: "sec" }, sinks);
  assert.deepEqual(order, ["react:😂", "pause", "emit:sec"]);
  assert.equal(out.sent, 2);
}

/**
 * The reaction and the bubble must not land in the same instant — a person taps
 * back, THEN types. So a real (human-length) beat is waited out between them.
 */
async function reactionAndBubbleArePacedApart(): Promise<void> {
  const { sinks, paused } = makeSinks();
  await deliverAck({ tapback: "😂", text: "sec" }, sinks);
  assert.equal(paused.length, 1, "exactly one pause, between the reaction and the bubble");
  assert.ok(paused[0] >= 1000, `pause should be a human beat, got ${paused[0]}ms`);
  assert.ok(paused[0] <= 3000, `pause should not stall the ack, got ${paused[0]}ms`);

  // Tapback alone: nothing follows it, so nothing to wait for.
  const solo = makeSinks();
  await deliverAck({ tapback: "👍" }, solo.sinks);
  assert.deepEqual(solo.paused, []);

  // Text alone: one bubble, no reaction before it.
  const textOnly = makeSinks();
  await deliverAck({ text: "on it" }, textOnly.sinks);
  assert.deepEqual(textOnly.paused, []);

  // Reaction refused → the emoji rides the bubble as text. One message, no pause.
  const refused = makeSinks({ reactOk: false });
  await deliverAck({ tapback: "💀", text: "sec" }, refused.sinks);
  assert.deepEqual(refused.paused, []);
  assert.deepEqual(refused.emitted, ["💀 sec"]);
}

/** Arbitrary (non-classic) emoji are passed through untouched — no mapping, no rejection. */
async function arbitraryEmojiTapbackIsPassedThrough(): Promise<void> {
  for (const emoji of ["💀", "🎉", "🫡", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣"]) {
    const { sinks, reacted } = makeSinks();
    await deliverAck({ tapback: emoji }, sinks);
    assert.deepEqual(reacted, [emoji], `${emoji} should reach the transport verbatim`);
  }
}

/**
 * Regression (the whole reason this substrate exists): an emoji written INSIDE
 * `text` is text. "😂 sec" ships as ONE bubble and never becomes a reaction —
 * otherwise "💀 this is cursed" gets torn into a tapback plus a sentence.
 */
async function emojiInsideTextIsNeverMinedIntoAReaction(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  await deliverAck({ text: "😂 sec" }, sinks);
  assert.deepEqual(emitted, ["😂 sec"]);
  assert.deepEqual(reacted, []);

  const cursed = makeSinks();
  await deliverAck({ text: "💀 this is cursed" }, cursed.sinks);
  assert.deepEqual(cursed.emitted, ["💀 this is cursed"]);
  assert.deepEqual(cursed.reacted, []);
}

/** A reaction the channel refuses still reaches them — as text, never silence. */
async function failedReactionFallsBackToText(): Promise<void> {
  const refused = makeSinks({ reactOk: false });
  const out = await deliverAck({ tapback: "💀", text: "sec" }, refused.sinks);
  assert.deepEqual(refused.emitted, ["💀 sec"]);
  assert.equal(out.sent, 1);

  const thrown = makeSinks({ reactThrows: true });
  await deliverAck({ tapback: "💀" }, thrown.sinks);
  assert.deepEqual(thrown.emitted, ["💀"]);
}

/** No tapback sink at all (a lane with no reaction target) degrades the same way. */
async function missingTapbackSinkDegradesToText(): Promise<void> {
  const emitted: string[] = [];
  const out = await deliverAck(
    { tapback: "🎉", text: "on it" },
    { emit: async (t) => void emitted.push(t) },
  );
  assert.deepEqual(emitted, ["🎉 on it"]);
  assert.equal(out.sent, 1);
}

/** The silence sentinel suppresses EVERYTHING, reaction included. */
async function silenceSentinelSuppressesBoth(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  const out = await deliverAck({ tapback: "👍", text: SILENCE_TOKEN }, sinks);
  assert.equal(out.silenced, true);
  assert.equal(out.sent, 0);
  assert.deepEqual(emitted, []);
  assert.deepEqual(reacted, []);
}

/** An empty ack delivers nothing and isn't mistaken for silence. */
async function emptyAckDeliversNothing(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  const out = await deliverAck({}, sinks);
  assert.equal(out.sent, 0);
  assert.equal(out.silenced, false);
  assert.deepEqual(emitted, []);
  assert.deepEqual(reacted, []);
}

/** A sentence mistakenly put in `tapback` becomes text rather than being dropped. */
async function proseInTheTapbackFieldBecomesText(): Promise<void> {
  const { sinks, emitted, reacted } = makeSinks();
  const out = await deliverAck({ tapback: "on it" }, sinks);
  assert.deepEqual(reacted, []);
  assert.deepEqual(emitted, ["on it"]);
  assert.equal(out.sent, 1);
}

function intentParsingIsStrictAboutEmoji(): void {
  assert.deepEqual(parseAckIntent({ tapback: "💀", text: "sec" }), { tapback: "💀", text: "sec" });
  assert.deepEqual(parseAckIntent({ text: "  checking  " }), { text: "checking" });
  assert.deepEqual(parseAckIntent({ tapback: "  🎉 " }), { tapback: "🎉" });
  assert.deepEqual(parseAckIntent({}), {});
  assert.deepEqual(parseAckIntent(undefined), {});
  // Two emoji is not a tapback; it falls through to text.
  assert.deepEqual(parseAckIntent({ tapback: "💀💀" }), { text: "💀💀" });
}

function singleEmojiDetectionMatchesImsgRules(): void {
  for (const ok of ["💀", "❤️", "😂", "👍🏽", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "🫡"]) {
    assert.ok(isSingleEmoji(ok), `${ok} should count as one emoji`);
  }
  for (const bad of ["", "a", "1", "sec", "😂 sec", "💀💀", "💀 this is cursed"]) {
    assert.ok(!isSingleEmoji(bad), `${JSON.stringify(bad)} must not count as one emoji`);
  }
}

async function main(): Promise<void> {
  await textOnlyAckIsUnchanged();
  await tapbackOnlyAckReactsWithoutABubble();
  await bothFieldsReactBeforeSpeaking();
  await reactionAndBubbleArePacedApart();
  await arbitraryEmojiTapbackIsPassedThrough();
  await emojiInsideTextIsNeverMinedIntoAReaction();
  await failedReactionFallsBackToText();
  await missingTapbackSinkDegradesToText();
  await silenceSentinelSuppressesBoth();
  await emptyAckDeliversNothing();
  await proseInTheTapbackFieldBecomesText();
  intentParsingIsStrictAboutEmoji();
  singleEmojiDetectionMatchesImsgRules();
  console.log("ack/deliver.test.ts: 13 passed");
}

void main();
