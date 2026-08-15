import path from "path";

import { config } from "./config";
import { readJson, writeJson } from "./jsonStore";
import { log } from "./log";

/**
 * `/voice` — the persistent SPEAK-EVERYTHING mode.
 *
 * The gap it closes. Today the only thing that makes fig reply with audio is
 * `audioMessageHint` (render/media-hints.ts): the owner sends a native iMessage audio
 * message, fig matches their modality on THAT reply. It's per-message and reactive, so
 * the moment fig speaks on its own — a background job finishing, a status report after
 * a build, an unprompted thought — the reply falls back to text, because there was no
 * inbound voice note to match. When the owner is driving/at the gym/hands-busy that's
 * exactly the reply they can't read.
 *
 * So this is a MODE, not a one-shot skill invoke: `/voice` flips a persisted bit and
 * every fig turn stays spoken until `/voice` again (or `/voice off`). Mechanically it
 * reuses the existing hook path rather than inventing a parallel one — `voiceModeHint()`
 * is the same shape of bracketed, model-visible-only instruction as `audioMessageHint`,
 * injected by the same `Conversation.bundle()` call site. The only difference is
 * durability: the media hint fires when a `.caf` is in the batch, this one fires on
 * every turn while the bit is set, including turns with no inbound message at all.
 *
 * Persisted to disk (stateDir/voice-mode.json) and read fresh per use, exactly like
 * `/model` and the fig↔spot switch, so it survives the auto-restart — a code reload
 * must not silently drop them back to text mid-conversation.
 *
 * Two hardcoded exceptions stay TEXT while the mode is on, and they're in the
 * instruction rather than in code because only the model knows which one applies:
 *   1. screen-bound content — code, paths, links, a list they have to scan. Unusable spoken.
 *   2. acks/tapbacks — the ack tool is deliberately untouched. An ack is already the
 *      minimum-noise acknowledgment; rendering it as a 1-second audio bubble is worse
 *      than the 👍 it replaces.
 *
 * NOT the `voice` SKILL. `/voice <anything else>` still routes to the writing-voice
 * skill through core/slash.ts (`/voice draft an email to sarah`), and `/draft` remains
 * its alias. Only the mode words below are intercepted.
 */

const VOICE_FILE = path.join(config.stateDir, "voice-mode.json");

interface VoiceState {
  on?: unknown;
}

/** True while `/voice` mode is on. Read fresh per turn — no restart needed to take. */
export function voiceModeOn(): boolean {
  return readJson<VoiceState>(VOICE_FILE, {}).on === true;
}

/** Persist the mode. Swallows write failures — a mode toggle must never kill a turn. */
export function setVoiceMode(on: boolean): void {
  try {
    writeJson(VOICE_FILE, { on, updatedAt: new Date().toISOString() });
  } catch (e) {
    log(`voice mode: failed to persist — ${String(e)}`);
  }
}

/** The words that mean "toggle the mode", vs. anything else (which means the skill). */
const ON_WORDS = new Set(["on", "start", "enable"]);
const OFF_WORDS = new Set(["off", "stop", "end", "disable", "text"]);
const STATUS_WORDS = new Set(["status", "?"]);
const TOGGLE_WORDS = new Set(["toggle"]);

const ON_CONFIRM = "🎙️ voice mode on";
const OFF_CONFIRM = "💬 voice mode off";

/**
 * If `text` is a `/voice` MODE command, apply it and return the confirmation to send
 * back. Returns null when it isn't — which covers both "not a slash command at all" and
 * "/voice with an argument that isn't a mode word", so `/voice draft an email to X` falls
 * through to the normal turn and reaches the writing-voice skill untouched.
 *
 * Bare `/voice` toggles. That's the whole ergonomic point (the owner: "I would do /voice"),
 * and it's why bare `/voice` no longer invokes the writing skill — invoking that skill
 * with no input never did anything useful anyway.
 */
export function resolveVoiceCommand(text: string): string | null {
  const m = text.trim().match(/^\/voice\b[ \t]*(.*)$/i);
  if (!m) return null;
  const arg = m[1].trim().toLowerCase();

  if (STATUS_WORDS.has(arg)) {
    return voiceModeOn() ? "🎙️ voice mode on" : "💬 voice mode off";
  }

  let next: boolean;
  if (!arg || TOGGLE_WORDS.has(arg)) next = !voiceModeOn();
  else if (ON_WORDS.has(arg)) next = true;
  else if (OFF_WORDS.has(arg)) next = false;
  else return null; // an argument, not a mode word → it's the writing-voice skill

  if (next === voiceModeOn()) return next ? "🎙️ already on" : "💬 already off";
  setVoiceMode(next);
  log(`voice mode → ${next ? "on" : "off"}`);
  return next ? ON_CONFIRM : OFF_CONFIRM;
}

/**
 * The standing instruction injected into EVERY turn's prompt while the mode is on.
 * Null when it's off, so a mode-off turn is byte-identical to what it was before this
 * existed. Model-visible only: `bundle()` feeds it to the prompt, never to the
 * transcript or a bubble — same contract as the media hints it sits next to.
 */
export function voiceModeHint(): string | null {
  if (!voiceModeOn()) return null;
  return (
    "[/voice mode is ON — the owner turned it on and it stays on until they turn it off, so this is a " +
    "standing instruction, not a one-off. SPEAK this reply: render it with mcp__tts__speak (local " +
    "kokoro — free, offline, no per-use cost) and put the returned path ALONE on its own line, which " +
    "is what makes it arrive as a real audio bubble instead of a file. this applies to EVERY reply " +
    "while the mode is on, not just replies to something they said out loud — a finished background " +
    "job, a status report after a build, a scheduled nudge, an unprompted thought all get spoken " +
    "too. that is the entire point of the mode: they asked for it because they can't read the screen " +
    "right now. write it to be HEARD — spoken sentences, no markdown, no bullet lists, no headers, " +
    "no raw urls or file paths or code read aloud, no emoji standing in for punctuation.\n" +
    "exactly two things stay TEXT:\n" +
    "1. anything screen-bound — code, file paths, links/urls, a commit sha, a list they have to scan " +
    "with their eyes, a 🔐 approval. speaking those is useless. send a SHORT spoken bubble carrying " +
    "the actual answer, plus the screen-bound part as its own plain text bubble; don't drop it and " +
    "don't try to read it aloud.\n" +
    "2. acks. the ack tool is unchanged — a tapback or a quick acknowledgment stays exactly what it " +
    "is today. never render an ack as audio.\n" +
    "if mcp__tts__speak fails, send the reply as normal text rather than saying nothing.]"
  );
}
