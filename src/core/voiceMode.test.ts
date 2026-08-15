import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The mode persists under stateDir, so point the run at a temp brain BEFORE anything
// imports config — otherwise this test would read (and clobber) the owner's live toggle.
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-voicemode-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type VoiceMode = typeof import("./voiceMode");

let voiceModeOn: VoiceMode["voiceModeOn"];
let setVoiceMode: VoiceMode["setVoiceMode"];
let resolveVoiceCommand: VoiceMode["resolveVoiceCommand"];
let voiceModeHint: VoiceMode["voiceModeHint"];

/** Off until they ask. A fresh install must not start talking at them. */
function defaultsOff(): void {
  assert.equal(voiceModeOn(), false, "no state file → off");
  assert.equal(voiceModeHint(), null, "off → no injection at all");
}

/** Bare `/voice` toggles, which is the whole ergonomic ask — one word, both directions. */
function bareCommandToggles(): void {
  assert.match(resolveVoiceCommand("/voice") ?? "", /voice mode on/i);
  assert.equal(voiceModeOn(), true);

  assert.match(resolveVoiceCommand("/voice") ?? "", /voice mode off/i);
  assert.equal(voiceModeOn(), false);

  // Casing and stray whitespace are still the command, not a skill invoke.
  assert.ok(resolveVoiceCommand("  /VOICE  "), "trimmed + case-insensitive");
  assert.equal(voiceModeOn(), true);
  setVoiceMode(false);
}

/** Explicit words beat the toggle when they want to be sure which way it lands. */
function explicitOnOff(): void {
  for (const word of ["on", "start", "enable"]) {
    setVoiceMode(false);
    assert.match(resolveVoiceCommand(`/voice ${word}`) ?? "", /voice mode on/i, `/voice ${word}`);
    assert.equal(voiceModeOn(), true);
  }
  for (const word of ["off", "stop", "end", "disable", "text"]) {
    setVoiceMode(true);
    assert.match(resolveVoiceCommand(`/voice ${word}`) ?? "", /voice mode off/i, `/voice ${word}`);
    assert.equal(voiceModeOn(), false);
  }

  // Idempotent: asking for what's already true says so instead of lying about a change.
  setVoiceMode(true);
  assert.match(resolveVoiceCommand("/voice on") ?? "", /already on/i);
  assert.equal(voiceModeOn(), true);
  setVoiceMode(false);
  assert.match(resolveVoiceCommand("/voice off") ?? "", /already off/i);

  // `/voice status` reports without flipping anything.
  assert.match(resolveVoiceCommand("/voice status") ?? "", /voice mode off/i);
  assert.equal(voiceModeOn(), false, "status must never toggle");
  setVoiceMode(true);
  assert.match(resolveVoiceCommand("/voice status") ?? "", /voice mode on/i);
  assert.equal(voiceModeOn(), true);
  setVoiceMode(false);
}

/**
 * The collision that matters: `/voice` was already the WRITING-voice skill's command
 * (SKILL.md `name: voice`). Anything that isn't a mode word must return null so the turn
 * runs normally and core/slash.ts routes it to that skill exactly as before.
 */
function nonModeArgsFallThroughToTheSkill(): void {
  for (const text of [
    "/voice draft an email to sarah",
    "/voice rewrite this in my voice",
    "/voicemail check",
    "/model sonnet",
    "just talking about /voice in a sentence",
    "",
  ]) {
    assert.equal(resolveVoiceCommand(text), null, `must not intercept: ${text || "(empty)"}`);
  }
  assert.equal(voiceModeOn(), false, "a fall-through must not have flipped the bit as a side effect");
}

/** Survives a restart: the bit lives on disk, not in the process. */
function persistsAcrossReload(): void {
  setVoiceMode(true);
  const file = path.join(TMP_BRAIN, ".state", "voice-mode.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).on, true, "written to stateDir");
  assert.equal(voiceModeOn(), true, "and read back fresh, so no process bounce is needed");
  setVoiceMode(false);
  assert.equal(voiceModeOn(), false);
}

/** The instruction has to carry the mandate AND both exceptions — they're not enforced in code. */
function theStandingInstruction(): void {
  setVoiceMode(true);
  const hint = voiceModeHint()!;
  try {
    assert.ok(hint, "on → an instruction exists");
    assert.ok(hint.startsWith("[") && hint.endsWith("]"), "bracketed internal instruction, same shape as media hints");

    // The mandate, and the mechanism it has to name to actually work.
    assert.match(hint, /mcp__tts__speak/, "names the real tool");
    assert.match(hint, /alone on its own line/i, "names the send path that makes it a native bubble");
    assert.match(hint, /EVERY reply/, "standing, not per-message");
    assert.match(hint, /stays on until they turn it off/i, "says it's durable, so fig doesn't treat it as one-off");

    // The gap the mode exists for: turns with no inbound audio to match.
    assert.match(hint, /a finished background job/, "background job results");
    assert.match(hint, /status report/, "status reports");
    assert.match(hint, /scheduled nudge/, "scheduled pings");

    // Exception 1 — screen-bound content stays text, and isn't just dropped.
    assert.match(hint, /screen-bound/);
    assert.match(hint, /code, file paths, links/);
    assert.match(hint, /don't drop it/i, "the text half still has to be sent");

    // Exception 2 — the ack tool is explicitly untouched.
    assert.match(hint, /never render an ack as audio/i);

    // Written to be heard, not read.
    assert.match(hint, /no markdown/);
  } finally {
    setVoiceMode(false);
  }
  assert.equal(voiceModeHint(), null, "off again → nothing injected");
}

async function main(): Promise<void> {
  ({ voiceModeOn, setVoiceMode, resolveVoiceCommand, voiceModeHint } = await import("./voiceMode"));
  try {
    defaultsOff();
    bareCommandToggles();
    explicitOnOff();
    nonModeArgsFallThroughToTheSkill();
    persistsAcrossReload();
    theStandingInstruction();
    console.log("core/voiceMode.test.ts: 6 passed");
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
