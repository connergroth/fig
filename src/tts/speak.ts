import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DEFAULT_VOICE, KOKORO_VOICES, resolveProvider, type TtsProvider } from "./provider";

const execFileAsync = promisify(execFile);

/**
 * text -> a playable .m4a on disk. The engine-independent half of the TTS lane.
 *
 * Everything here is true no matter which provider rendered the audio, which is exactly why
 * it isn't in the provider: a new engine drops in and inherits the loudness normalisation,
 * the AAC encode and the duration probe without reimplementing any of them.
 *
 * Three decisions worth knowing:
 *
 *  - **m4a (AAC), not wav.** iMessage sends an m4a as a real playable audio attachment; a wav
 *    is a file you download. The whole point is "listen to this while driving," so the
 *    container is part of the feature, not a detail.
 *  - **-16 LUFS loudness normalisation, kept from the bake-off.** It was added there so
 *    volume couldn't bias a blind comparison, and it matters just as much in production for a
 *    different reason: a briefing played in a car competes with road noise, and un-normalised
 *    Kokoro output drifts several dB between voices and paragraphs.
 *  - **Renders go to `~/scratch/tts/`.** They ARE throwaway — one listen and they're spent —
 *    so scratch is the honest home. Only the venv had to move somewhere durable.
 */

/** Throwaway renders. Scratch is correct for these; see the header. */
export const OUT_DIR = path.join(os.homedir(), "scratch", "tts");

/** Rendered files older than this are pruned on the next call. */
const KEEP_DAYS = 7;

/** ~22 minutes of speech. Past this, the caller wants a file per section, not one monolith. */
const MAX_CHARS = 20_000;

export interface SpeakOptions {
  text: string;
  voice?: string;
  speed?: number;
  /** Injectable for tests; defaults to whatever `resolveProvider()` picks. */
  provider?: TtsProvider;
  outDir?: string;
}

export interface SpeakResult {
  /** Absolute path to the .m4a. Drop this on its own line to send a native iMessage audio bubble. */
  path: string;
  /** Audio duration in seconds. */
  seconds: number;
  /** Wall time for the whole thing — render + normalise + encode. */
  renderMs: number;
  engine: string;
  voice: string;
}

export function isValidVoice(voice: string): boolean {
  return (KOKORO_VOICES as readonly string[]).includes(voice);
}

/** Speech-safe text: strip the markdown that TTS engines read aloud as literal punctuation. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sortable, human-readable, and unique — two renders inside one second must not collide. */
function stamp(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${t}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Best-effort sweep of stale renders. Never throws — housekeeping must not fail a render. */
async function pruneOldRenders(dir: string): Promise<void> {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of await fs.promises.readdir(dir)) {
      const p = path.join(dir, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st?.isFile() && st.mtimeMs < cutoff) await fs.promises.rm(p, { force: true });
    }
  } catch {
    /* housekeeping only */
  }
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { timeout: 30_000 },
  );
  const seconds = Number.parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Loudness-normalise and encode to AAC in one ffmpeg pass.
 *
 * 44.1kHz rather than Kokoro's native 24kHz: loudnorm resamples internally anyway, and a
 * standard rate is the safest thing to hand an iOS audio player.
 *
 * The `adelay` lead-in exists because iMessage's audio player clips the first beat of
 * playback: the opening word or two of a render gets swallowed on the receiving end.
 * That player is the end fig doesn't control, so the pad
 * goes in the FILE: every render opens with a second of silence and the first word lands
 * after the player has settled.
 *
 * Applied AFTER loudnorm so the silence can't skew the loudness measurement, and on BOTH
 * encode branches — the un-normalised fallback is still a file the owner listens to.
 */
export const LEAD_IN_MS = 1_000;
const LEAD_IN = `adelay=${LEAD_IN_MS}:all=1`;

async function encode(wav: string, m4a: string, normalise: boolean): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", wav,
      "-af", normalise ? `loudnorm=I=-16:TP=-1.5:LRA=11,${LEAD_IN}` : LEAD_IN,
      "-ar", "44100", "-ac", "1",
      "-c:a", "aac", "-b:a", "64k",
      m4a,
    ],
    { timeout: 10 * 60_000 },
  );
}

async function toM4a(wav: string, m4a: string): Promise<void> {
  try {
    await encode(wav, m4a, true);
  } catch (e) {
    // loudnorm's dynamic pass emits NaN on (near-)digital silence and the AAC encoder then
    // refuses the frame, killing the whole render. Found by the test that feeds it a silent
    // wav. Normalisation is a nicety; having the audio at all is the feature — so degrade to
    // a plain encode rather than losing a render that already cost 45 seconds of CPU.
    await encode(wav, m4a, false).catch(() => {
      throw e; // the un-normalised attempt failed too — surface the original, realer error
    });
  }
}

export async function speak(opts: SpeakOptions): Promise<SpeakResult> {
  const text = cleanForSpeech(opts.text ?? "");
  if (!text) throw new Error("nothing to say — text was empty after cleanup");
  if (text.length > MAX_CHARS) {
    throw new Error(`text is ${text.length} chars, over the ${MAX_CHARS} cap — render it in sections instead`);
  }

  const voice = opts.voice?.trim() || DEFAULT_VOICE;
  if (!isValidVoice(voice)) {
    throw new Error(`unknown voice '${voice}'. valid: ${KOKORO_VOICES.join(", ")}`);
  }
  const speed = opts.speed ?? 1.0;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
    throw new Error(`speed ${speed} is out of range — use 0.5 to 2.0 (1.0 is natural)`);
  }

  const dir = opts.outDir ?? OUT_DIR;
  await fs.promises.mkdir(dir, { recursive: true });
  void pruneOldRenders(dir);

  const base = path.join(dir, `speak-${stamp()}-${voice}`);
  const wav = `${base}.wav`;
  const m4a = `${base}.m4a`;

  const provider = opts.provider ?? resolveProvider();
  const t0 = Date.now();
  const rendered = await provider.synthesize({ text, outPath: wav, voice, speed });
  try {
    await toM4a(rendered.path, m4a);
  } finally {
    // The wav is an intermediate; only the m4a is the deliverable.
    await fs.promises.rm(rendered.path, { force: true });
  }
  const renderMs = Date.now() - t0;

  // Probe the DELIVERABLE, not the engine's self-report: it's the one number that also
  // proves the m4a exists and is decodable, which is the actual failure we'd want to catch.
  const seconds = (await probeDuration(m4a).catch(() => 0)) || rendered.audioSeconds || 0;
  return { path: m4a, seconds, renderMs, engine: rendered.engine, voice };
}
