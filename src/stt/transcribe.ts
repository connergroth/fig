import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { log, warn } from "../core/log";

/**
 * Local speech-to-text for inbound iMessage audio notes.
 *
 * The owner holding the mic button and talking should reach fig as WORDS, not as an
 * unreadable `.caf` path. imsg hands us the raw CoreAudio file Messages recorded;
 * this module turns it into text on-device with mlx_whisper (Apple-silicon whisper),
 * which is the same reason the TTS lane runs Kokoro locally: it's free, it's offline,
 * and a voice note is exactly the kind of private thing that shouldn't leave the mini
 * to be read by an API.
 *
 * Decisions worth knowing:
 *
 *  - **whisper-small, not tiny/base.** Small is the smallest model that reliably keeps
 *    proper nouns and technical words (the whole vocabulary of what we talk about)
 *    intact, and it still transcribes a 5s note in ~1s on this machine. It's already in
 *    the HF cache, so nothing downloads on first use.
 *  - **Offline by default (`HF_HUB_OFFLINE=1`).** A cache miss must fail in a second
 *    with a clear error, never hang the turn on a multi-GB download of a model nobody
 *    asked for. Set STT_ALLOW_DOWNLOAD=1 to let it fetch.
 *  - **Failure is not fatal.** Every error path returns a result object, never throws.
 *    A voice note that couldn't be transcribed still has to reach fig as "they sent a
 *    voice message and I couldn't read it" — going silent because whisper died is the
 *    one outcome worse than a bad transcript.
 *
 *   MLX_WHISPER_BIN     path to the mlx_whisper CLI  (default /opt/homebrew/bin/mlx_whisper)
 *   STT_MODEL           HF repo or local dir         (default mlx-community/whisper-small-mlx)
 *   STT_LANGUAGE        forced language, "" = auto   (default en)
 *   STT_TIMEOUT_MS      per-file wall clock cap      (default 120000)
 *   STT_ALLOW_DOWNLOAD  1 = allow HF downloads       (default off)
 */

const DEFAULT_BIN = "/opt/homebrew/bin/mlx_whisper";
/** Cached under ~/.cache/huggingface/hub — see the header for why small and not tiny. */
const DEFAULT_MODEL = "mlx-community/whisper-small-mlx";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AudioTranscript {
  /** The file that was transcribed (absolute path as handed in). */
  path: string;
  /** True when whisper ran to completion — INCLUDING when it heard nothing (see `empty`). */
  ok: boolean;
  /** Transcribed speech, trimmed. Empty string when it failed or heard no speech. */
  text: string;
  /** Ran fine but the audio held no discernible speech (a pocket-tap, silence, noise). */
  empty: boolean;
  /** Short human-readable reason when `ok` is false. */
  error?: string;
  /** Wall time for the run. */
  ms: number;
  model: string;
}

/** Injectable process seam. The fake in the tests writes the txt file itself. */
export type WhisperRunner = (
  bin: string,
  args: readonly string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stderr: string }>;

export interface TranscribeOptions {
  bin?: string;
  model?: string;
  language?: string;
  timeoutMs?: number;
  run?: WhisperRunner;
  /** Reuse an earlier result for the same file (default true). */
  cache?: boolean;
}

const defaultRun: WhisperRunner = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, _stdout, stderr) => {
        const e = error as (Error & { code?: number; killed?: boolean }) | null;
        if (!e) return resolve({ code: 0, stderr: String(stderr ?? "") });
        // A timeout kill surfaces as killed=true with no exit code — name it, because
        // "timed out" and "crashed" are different bugs to the person reading the log.
        const reason = e.killed ? "timed out" : String(stderr ?? "").trim() || e.message;
        resolve({ code: typeof e.code === "number" ? e.code : 1, stderr: reason });
      },
    );
  });

/** path + size + mtime — a restaged file at the same path is a different recording. */
function cacheKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${file}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return file;
  }
}

const memo = new Map<string, AudioTranscript>();
const MEMO_CAP = 200;

function remember(key: string, value: AudioTranscript): void {
  memo.set(key, value);
  if (memo.size > MEMO_CAP) memo.delete(memo.keys().next().value as string);
}

/**
 * One audio file → its transcript. Never throws: a failure comes back as
 * `{ ok: false, error }` so the caller can still tell fig a voice note arrived.
 */
export async function transcribeAudioNote(file: string, opts: TranscribeOptions = {}): Promise<AudioTranscript> {
  const model = opts.model || process.env.STT_MODEL?.trim() || DEFAULT_MODEL;
  const started = Date.now();
  const fail = (error: string): AudioTranscript => ({
    path: file,
    ok: false,
    text: "",
    empty: false,
    error,
    ms: Date.now() - started,
    model,
  });

  if (!file) return fail("no file");
  const useCache = opts.cache !== false;
  const key = `${cacheKey(file)}|${model}`;
  if (useCache) {
    const hit = memo.get(key);
    if (hit) return hit;
  }

  const bin = opts.bin || process.env.MLX_WHISPER_BIN?.trim() || DEFAULT_BIN;
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.STT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const language = opts.language ?? (process.env.STT_LANGUAGE?.trim() || "en");
  const run = opts.run || defaultRun;

  if (!fs.existsSync(file)) return fail("audio file missing on disk");

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fig-stt-"));
  } catch (e) {
    return fail(`could not make a scratch dir (${e})`);
  }

  try {
    const args = [
      "--model",
      model,
      "--output-dir",
      dir,
      "--output-format",
      "txt",
      "--output-name",
      "out",
      "--verbose",
      "False",
    ];
    // "" means auto-detect. Forcing en is the default because a forced language stops
    // whisper from "detecting" a foreign language out of a couple seconds of noise and
    // hallucinating a sentence in it.
    if (language) args.push("--language", language);
    args.push(file);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.env.STT_ALLOW_DOWNLOAD !== "1") env.HF_HUB_OFFLINE = "1";

    const res = await run(bin, args, { timeoutMs, env });
    if (res.code !== 0) {
      const detail = res.stderr.split("\n").filter(Boolean).pop() || `exit ${res.code}`;
      const out = fail(detail.slice(0, 200));
      warn(`stt: transcription failed for ${path.basename(file)} — ${out.error}`);
      if (useCache) remember(key, out);
      return out;
    }

    const txt = path.join(dir, "out.txt");
    if (!fs.existsSync(txt)) {
      const out = fail("whisper produced no output file");
      if (useCache) remember(key, out);
      return out;
    }
    const text = fs.readFileSync(txt, "utf8").trim();
    const result: AudioTranscript = {
      path: file,
      ok: true,
      text,
      empty: text.length === 0,
      ms: Date.now() - started,
      model,
    };
    log(
      `stt: transcribed ${path.basename(file)} in ${result.ms}ms (${result.empty ? "no speech" : `${text.length} chars`})`,
    );
    if (useCache) remember(key, result);
    return result;
  } catch (e) {
    const out = fail(String(e).slice(0, 200));
    warn(`stt: transcription threw for ${path.basename(file)} — ${out.error}`);
    return out;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* scratch dir; a leftover is harmless */
    }
  }
}

/**
 * Several notes in one batch → one result each, in order. Deliberately SEQUENTIAL:
 * mlx_whisper runs on the GPU, so two at once is slower than two in a row, not faster.
 */
export async function transcribeAudioNotes(
  files: readonly string[],
  opts: TranscribeOptions = {},
): Promise<AudioTranscript[]> {
  const out: AudioTranscript[] = [];
  for (const f of files) out.push(await transcribeAudioNote(f, opts));
  return out;
}

/** Test seam: drop memoised results so a fake runner isn't shadowed by a real one. */
export function clearTranscriptCache(): void {
  memo.clear();
}
