import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The TTS provider seam — one `synthesize()` per engine, plus a shell escape hatch.
 *
 * Shape borrowed outright from Nous's hermes-agent, which ships this same lane with 11
 * engines behind one interface (its default is Edge TTS; Kokoro is its documented
 * custom-command example). The thing worth stealing there was the SHAPE, not the pick:
 * a single `synthesize(text, out, voice, speed)` with a shell-command escape hatch means
 * swapping engines never touches the tool, the m4a encode, or the iMessage path.
 *
 * Why the seam is worth having when there's exactly one implementation today: the bake-off
 * produced a real fallback, not a hypothetical one. Piper `lessac-medium` is 6x
 * faster than Kokoro (41.7x realtime vs 6.5–7.4x) and lost purely on quality, so the day a
 * job needs bulk rendering the answer already exists — see PIPER_EXAMPLE below.
 *
 * A provider's ONLY job is text -> some audio file ffmpeg can read at `outPath`. Loudness
 * normalisation, the AAC encode, and duration probing are engine-independent and live one
 * layer up in `speak.ts`, so a new engine inherits them for free.
 */

export interface SynthesizeRequest {
  text: string;
  /** Absolute path the provider must write its audio to. */
  outPath: string;
  voice: string;
  /** 1.0 = natural. Kokoro takes it as a rate multiplier. */
  speed: number;
}

export interface SynthesizeResult {
  /** Where the audio actually landed (normally === request.outPath). */
  path: string;
  /** Engine label, for the tool's report line. */
  engine: string;
  /** Seconds of audio produced, when the engine tells us. */
  audioSeconds?: number;
  /** Engine-reported generate time, excluding process startup. */
  generateSeconds?: number;
}

export interface TtsProvider {
  name: string;
  /** Voices this engine accepts. First entry is the default. */
  voices: readonly string[];
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
}

/** Where the durable render env lives. NOT `~/scratch` — the monthly sweep eats that. */
export const TTS_HOME = path.join(os.homedir(), ".fig", "tts");
const PYTHON = path.join(TTS_HOME, "venv", "bin", "python");
const RENDER_PY = path.join(TTS_HOME, "render.py");

/**
 * The three Kokoro voices that cleared the bar in a listening test. All three are good, so
 * voice is a per-call arg, not a fork. `am_michael` is the default — neutral US male,
 * closest register to fig's own voice.
 */
export const KOKORO_VOICES = ["am_michael", "bm_george", "af_heart"] as const;
export const DEFAULT_VOICE = KOKORO_VOICES[0];

/** stdout can carry engine chatter (misaki downloading a spacy model on first run), so read
 *  the LAST JSON object on it rather than assuming the whole stream is our line. */
function lastJsonLine(stdout: string): Record<string, any> | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export const kokoroProvider: TtsProvider = {
  name: "kokoro-82M",
  voices: KOKORO_VOICES,
  async synthesize({ text, outPath, voice, speed }) {
    if (!fs.existsSync(PYTHON) || !fs.existsSync(RENDER_PY)) {
      throw new Error(
        `kokoro render env missing at ${TTS_HOME} (expected venv/bin/python + render.py). ` +
          `Rebuild: python3.12 -m venv ${TTS_HOME}/venv && ${TTS_HOME}/venv/bin/pip install kokoro==0.9.4 soundfile`,
      );
    }
    // Text goes through a file, never argv: a briefing is thousands of chars with newlines
    // and quotes in it, and every shell-quoting bug in this lane starts with argv.
    const textFile = `${outPath}.txt`;
    await fs.promises.writeFile(textFile, text, "utf8");
    try {
      const { stdout } = await execFileAsync(
        PYTHON,
        [RENDER_PY, "--text-file", textFile, "--out", outPath, "--voice", voice, "--speed", String(speed)],
        { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const meta = lastJsonLine(stdout);
      if (!meta) throw new Error(`kokoro returned no result line (stdout: ${stdout.slice(0, 300)})`);
      return {
        path: meta.out ?? outPath,
        engine: `${meta.engine ?? "kokoro-82M"}/${voice}`,
        audioSeconds: typeof meta.audio_s === "number" ? meta.audio_s : undefined,
        generateSeconds: typeof meta.gen_s === "number" ? meta.gen_s : undefined,
      };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(`kokoro render failed: ${(err.stderr || err.message || String(e)).trim().slice(0, 400)}`);
    } finally {
      await fs.promises.rm(textFile, { force: true });
    }
  },
};

/**
 * The escape hatch. `FIG_TTS_COMMAND` is a shell command with placeholders; set it and any
 * engine on the machine becomes the provider without a code change.
 *
 * Placeholders: {text_file} {out} {voice} {speed}. Prefer {text_file} — {text} is offered
 * for engines that only take a positional string, and is shell-escaped, but a whole briefing
 * on a command line is asking for trouble.
 *
 * THE DOCUMENTED FALLBACK IS PIPER. Deliberately not implemented — it lost the bake-off on
 * quality and shipping a second half-real engine invites drift. When bulk rendering needs
 * its 41.7x realtime, it's this one line (voices under ~/.fig/tts/piper-voices/):
 *
 *   FIG_TTS_COMMAND='piper -m ~/.fig/tts/piper-voices/{voice}.onnx -f {out} < {text_file}'
 *   FIG_TTS_VOICE=en_US-lessac-medium
 */
export const PIPER_EXAMPLE = "piper -m ~/.fig/tts/piper-voices/{voice}.onnx -f {out} < {text_file}";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellCommandProvider(template: string): TtsProvider {
  return {
    name: "shell",
    voices: [process.env.FIG_TTS_VOICE || DEFAULT_VOICE],
    async synthesize({ text, outPath, voice, speed }) {
      const textFile = `${outPath}.txt`;
      await fs.promises.writeFile(textFile, text, "utf8");
      const cmd = template
        .replace(/\{text_file\}/g, shellQuote(textFile))
        .replace(/\{out\}/g, shellQuote(outPath))
        .replace(/\{voice\}/g, shellQuote(voice))
        .replace(/\{speed\}/g, shellQuote(String(speed)))
        .replace(/\{text\}/g, shellQuote(text));
      try {
        await execFileAsync("/bin/sh", ["-c", cmd], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
        if (!fs.existsSync(outPath)) throw new Error(`command wrote no file at ${outPath}`);
        return { path: outPath, engine: `shell/${voice}` };
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error(`shell tts command failed: ${(err.stderr || err.message || String(e)).trim().slice(0, 400)}`);
      } finally {
        await fs.promises.rm(textFile, { force: true });
      }
    },
  };
}

/** Kokoro unless `FIG_TTS_COMMAND` says otherwise. One place decides; the tool never asks. */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider {
  const cmd = env.FIG_TTS_COMMAND?.trim();
  return cmd ? shellCommandProvider(cmd) : kokoroProvider;
}
