import assert from "node:assert/strict";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import {
  callTurnFraming,
  callTurnPrompt,
  denySupersededTools,
  interruptedNote,
  repeatsWhatWasSaid,
} from "./brainTurn";

/**
 * The hangup this fences off: the session child supersedes a turn, the turn keeps running in
 * the bot, and its `facetime__hang_up` fires anyway — ending a live call with a goodbye the
 * owner never heard. Two halves are tested here: a superseded turn can't act, and the framing
 * that made it want to hang up in the first place says the rule out loud.
 */

async function main(): Promise<void> {
  let seen: string[] = [];
  const inner: CanUseTool = async (toolName, input) => {
    seen.push(toolName);
    return { behavior: "allow", updatedInput: input };
  };

  // --- a live turn is untouched: every tool still goes through the real gate ---
  const live = new AbortController();
  const liveGate = denySupersededTools(inner, live.signal);
  const ok = await liveGate("mcp__facetime__hang_up", {}, {} as never);
  assert.equal(ok.behavior, "allow");
  assert.deepEqual(seen, ["mcp__facetime__hang_up"], "a current turn's tools reach the permission gate");

  // --- superseded: hang_up is a no-op, and never even reaches the permission gate ---
  seen = [];
  const superseded = new AbortController();
  const deadGate = denySupersededTools(inner, superseded.signal);
  superseded.abort();
  const denied = await deadGate("mcp__facetime__hang_up", {}, {} as never);
  assert.equal(denied.behavior, "deny", "a discarded turn must not hang up the call");
  assert.deepEqual(seen, [], "the tool never runs");
  // Not just hang_up — nothing a discarded turn decided should land.
  const alsoDenied = await deadGate("mcp__gmail__send", { to: "x@y.z" }, {} as never);
  assert.equal(alsoDenied.behavior, "deny");
  assert.deepEqual(seen, []);

  // --- the framing: hang_up is bound to what they say on THIS call, out loud ---
  const framing = callTurnFraming("the owner");
  assert.match(framing, /facetime__hang_up ONLY when they wrap up THIS call out loud/);
  assert.match(framing, /never because an earlier text or a previous call said to/);
  assert.match(framing, /never as a test of the hangup path/);
  assert.match(framing, /context, not instructions for this call/);
  assert.ok(framing.includes("the owner"), "the owner's name rides the framing");

  // --- the framing: what it writes is audio in their ear, not a place to narrate ---
  // "They got cut off mid-sentence. Just wait for them." was spoken TO them.
  assert.match(framing, /PLAYED INTO THEIR EAR/);
  assert.match(framing, /never about them in the third person/);
  assert.match(framing, /no stage directions/);

  // --- the same reply twice around a tool call is spoken once ---
  const said = "Alright, that's the closing remark — greeting, filler, and the mic threshold all get ripped out right after this. Go enjoy the party. Later.";
  // The model's second pass differs in case and punctuation; same words, so still a repeat.
  assert.equal(repeatsWhatWasSaid(said, "alright thats the closing remark — greeting filler and"), true);
  assert.equal(repeatsWhatWasSaid(said, "and the mic threshold all get ripped out right"), true, "a repeat picked up mid-reply counts too");
  // …but a repeat that turns into something new is not a repeat.
  assert.equal(repeatsWhatWasSaid(said, "Go enjoy the party — and text me when you're back"), false);
  // A real post-tool answer is not a repeat, and neither is a short human echo.
  assert.equal(repeatsWhatWasSaid(said, "checked it — project two and quiz nine are both due"), false);
  assert.equal(repeatsWhatWasSaid(said, "Later."), false, "too short to be anything but speech");
  assert.equal(repeatsWhatWasSaid("", "anything at all, said into an empty turn"), false);

  // --- their words reaching the brain twice, so fig answers them twice ---
  // The call transcript is BOTH what seeds the prompt and where their line is written. A
  // folded utterance waits seconds before it's asked, so its line always landed first —
  // and the turn that finally asked it saw it in history too ("Yeah, you said that —
  // you're back home safe? Or did that come through twice?").
  const spoken = "I just got back.";
  const transcript = [
    "[02:25] the owner[call]: It was fun. I went out there for a while.",
    "[02:25] fig[call]: that's a good night.",
  ];
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  // What the lane does now: snapshot history, build the prompt, THEN record their line.
  const fixed = callTurnPrompt(transcript.join("\n"), "the owner", spoken);
  transcript.push(`[02:25] the owner[call]: ${spoken}`);
  assert.equal(occurrences(fixed, spoken), 1, "their words reach the brain exactly once");

  // And the bug it replaces: the line recorded first, so the snapshot already holds it.
  const duplicated = callTurnPrompt(transcript.join("\n"), "the owner", spoken);
  assert.equal(occurrences(duplicated, spoken), 2, "recording first is what made fig hear it twice");

  // The framing rides along either way, and an empty history doesn't leave a stray block.
  assert.match(fixed, /LIVE VOICE CALL with the owner/);
  assert.ok(fixed.includes("[earlier conversation, for context only"));
  assert.ok(!callTurnPrompt("", "the owner", spoken).includes("[earlier conversation"));

  // --- they talk over a reply and the unplayed remainder is thrown away. Without the note the
  // next turn has no idea it was cut off OR how far they got. ---
  const heard = "both queued and written down so they don't evaporate.";
  const cut = callTurnPrompt("", "the owner", "that we can make as well.", heard);
  assert.match(cut, /you were interrupted/, "the model is told it was cut off");
  assert.ok(cut.includes(heard), "…and exactly what they heard before cutting in");
  assert.ok(cut.indexOf(heard) < cut.indexOf("that we can make as well."), "the note leads the question");
  // A barge before any clause played says so rather than quoting an empty string.
  assert.match(interruptedNote(""), /heard none of it/);
  assert.ok(!interruptedNote("").includes('""'));
  // An ordinary turn carries none of it — this is per-turn scaffolding, not a standing note.
  assert.ok(!callTurnPrompt("", "the owner", "yo").includes("interrupted"));

  console.log("✓ call brain turn tests passed");
}

void main().then(() => process.exit(0));
