import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_VOICE, KOKORO_VOICES, resolveProvider, shellCommandProvider, TTS_HOME } from "./provider";
import { cleanForSpeech, isValidVoice, LEAD_IN_MS, OUT_DIR, speak } from "./speak";
import { ttsServerDef } from "./tools";

/**
 * The local TTS lane — Kokoro-82M behind a provider seam, rendered to an .m4a fig can send.
 *
 * What's pinned here, and why each one is a thing that could actually break:
 *
 *   1. The PROVIDER SEAM. The whole justification for the indirection is that swapping the
 *      engine touches nothing else, so the tests drive `speak()` through a fake provider and
 *      through the real shell escape hatch — no Kokoro, no torch, no 4-second render in the
 *      suite. If the seam ever stops being honest, these are the tests that can't pass.
 *   2. The DELIVERABLE IS AN M4A. iMessage sends an m4a as a playable audio bubble and a wav
 *      as a download, which makes the container part of the feature. The wav intermediate
 *      must be gone afterwards, or ~/scratch/tts fills with the format we deliberately
 *      didn't ship.
 *   3. The PATH MUST SURVIVE CHUNKING. The tool returns a path and delivery attaches it only
 *      because `isLocalFilePath` recognises a bare `.m4a` line. That's a coupling across two
 *      modules with nothing else holding it together, so it gets an assertion.
 *   4. Nothing renders into the vault, and the venv is NOT in ~/scratch — the sweep deletes
 *      that on the 1st of the month, which would silently kill the tool with a stale path.
 *   5. Input validation returns a VALUE, never a throw: a throw inside a tool handler costs
 *      the whole turn.
 *
 * The real engine is exercised end to end by hand (documented in Tasks/local-tts.md), not
 * here — a 1GB torch import has no business in a test suite that has to stay fast.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

/** A provider that writes a real (silent) wav, so ffmpeg downstream has something to encode. */
function fakeProvider(opts: { seconds?: number; fail?: string; silent?: boolean } = {}) {
  const calls: { text: string; voice: string; speed: number; outPath: string }[] = [];
  const provider = {
    name: "fake",
    voices: KOKORO_VOICES,
    async synthesize(req: { text: string; outPath: string; voice: string; speed: number }) {
      calls.push({ ...req });
      if (opts.fail) throw new Error(opts.fail);
      await fs.promises.writeFile(req.outPath, toneWav(opts.seconds ?? 1, opts.silent ? 0 : 0.2));
      return { path: req.outPath, engine: `fake/${req.voice}`, audioSeconds: opts.seconds ?? 1 };
    },
  };
  return { provider, calls };
}

/** Minimal 8kHz mono 16-bit PCM wav: a quiet sine, or digital silence at amplitude 0. */
function toneWav(seconds: number, amplitude: number): Buffer {
  const rate = 8000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amplitude * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Decode a rendered m4a back to mono 8kHz s16le so the test can look at the samples. */
async function decodePcm(file: string): Promise<Int16Array> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "8000", "-ac", "1", "-"],
    { timeout: 60_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

/** Peak amplitude (0..1) over a window of the decoded audio, in ms. */
function peakBetween(pcm: Int16Array, fromMs: number, toMs: number, rate = 8000): number {
  const from = Math.max(0, Math.floor((fromMs / 1000) * rate));
  const to = Math.min(pcm.length, Math.ceil((toMs / 1000) * rate));
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(pcm[i]) / 32768);
  return peak;
}

async function main(): Promise<void> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fig-tts-test-"));

  console.log("tts: rendering");

  await check("a render produces an .m4a at the returned path, and only an .m4a", async () => {
    const { provider, calls } = fakeProvider({ seconds: 2 });
    const r = await speak({ text: "Morning. This is a test.", provider, outDir: tmp });
    assert.ok(path.isAbsolute(r.path), "the path handed back must be absolute");
    assert.equal(path.extname(r.path), ".m4a", "iMessage plays an m4a; a wav is just a download");
    assert.ok(fs.existsSync(r.path), "the file must actually be on disk");
    assert.ok(fs.statSync(r.path).size > 0);
    // The wav the provider wrote is an intermediate and must not survive the call.
    assert.ok(!fs.existsSync(calls[0].outPath), "the intermediate wav must be cleaned up");
    // Source is 2s + the 1s adelay lead-in (iMessage clips the opening beat of playback).
    assert.ok(r.seconds > 2.5 && r.seconds < 4, `probed duration should be source + 1s lead-in (got ${r.seconds})`);
    assert.ok(r.renderMs >= 0);
  });

  console.log("tts: the iMessage lead-in pad");

  await check("the render opens with a second of real silence before the first word", async () => {
    // The symptom this pads for: "the very beginning of your transcript got slightly cut off… a word or
    // two got cut off from the beginning". iMessage's player eats the opening beat, and
    // that end isn't ours — so the pad has to be IN the file. Asserting on the decoded
    // samples, not just the duration: a duration check alone passes even if the pad were
    // silently dropped and the source happened to be longer.
    const { provider } = fakeProvider({ seconds: 2 });
    const r = await speak({ text: "one two three", provider, outDir: tmp });
    const pcm = await decodePcm(r.path);

    const lead = peakBetween(pcm, 0, LEAD_IN_MS - 100);
    const speech = peakBetween(pcm, LEAD_IN_MS + 100, LEAD_IN_MS + 900);
    assert.ok(lead < 0.02, `the first ${LEAD_IN_MS}ms must be silent, saw peak ${lead.toFixed(3)}`);
    assert.ok(speech > 0.05, `audio must actually start after the pad, saw peak ${speech.toFixed(3)}`);
    assert.ok(speech > lead * 10, "the pad must be quiet relative to the speech that follows");
  });

  await check("the pad ADDS to the render — the audio itself is not shifted or clipped", async () => {
    // The pad must not cost content: same source, duration grows by exactly the lead-in.
    const { provider } = fakeProvider({ seconds: 2 });
    const r = await speak({ text: "duration check", provider, outDir: tmp });
    const expected = 2 + LEAD_IN_MS / 1000;
    assert.ok(
      Math.abs(r.seconds - expected) < 0.25,
      `expected ~${expected}s (2s source + ${LEAD_IN_MS}ms lead-in), got ${r.seconds}`,
    );
    // …and the source audio still runs all the way to the end, i.e. nothing was traded away.
    const pcm = await decodePcm(r.path);
    const tail = peakBetween(pcm, LEAD_IN_MS + 1_500, LEAD_IN_MS + 1_950);
    assert.ok(tail > 0.05, `the end of the source must survive the pad, saw peak ${tail.toFixed(3)}`);
  });

  await check("the lead-in survives the un-normalised fallback encode too", async () => {
    // loudnorm NaNs on digital silence and the render degrades to a plain encode. That
    // branch is a separate ffmpeg invocation, so it's a separate chance to lose the pad —
    // and it still produces a file the owner listens to.
    const { provider } = fakeProvider({ silent: true, seconds: 1 });
    const r = await speak({ text: "silence", provider, outDir: tmp });
    const expected = 1 + LEAD_IN_MS / 1000;
    assert.ok(
      Math.abs(r.seconds - expected) < 0.25,
      `fallback encode lost the lead-in: expected ~${expected}s, got ${r.seconds}`,
    );
  });

  await check("the rendered file is really AAC audio, not a wav with a new extension", async () => {
    const { provider } = fakeProvider({ seconds: 1 });
    const r = await speak({ text: "codec check", provider, outDir: tmp });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", r.path],
      { timeout: 30_000 },
    );
    assert.equal(stdout.trim(), "aac");
  });

  await check("near-silent audio still produces a file instead of losing the render", async () => {
    // Real: loudnorm's dynamic pass emits NaN on digital silence and the AAC encoder rejects
    // the frame, which killed the whole render before the un-normalised retry existed. A
    // briefing that opens with a long pause is not a hypothetical input.
    const { provider } = fakeProvider({ silent: true, seconds: 1 });
    const r = await speak({ text: "silence", provider, outDir: tmp });
    assert.ok(fs.existsSync(r.path), "a render must survive a loudnorm failure");
    assert.ok(fs.statSync(r.path).size > 0);
  });

  await check("voice and speed reach the provider; defaults are am_michael at 1.0", async () => {
    const a = fakeProvider();
    await speak({ text: "hi", provider: a.provider, outDir: tmp });
    assert.equal(a.calls[0].voice, DEFAULT_VOICE);
    assert.equal(a.calls[0].speed, 1.0);

    const b = fakeProvider();
    await speak({ text: "hi", voice: "bm_george", speed: 1.25, provider: b.provider, outDir: tmp });
    assert.equal(b.calls[0].voice, "bm_george");
    assert.equal(b.calls[0].speed, 1.25);
  });

  await check("markdown is stripped before it gets read aloud as punctuation", async () => {
    const { provider, calls } = fakeProvider();
    await speak({
      text: "## Morning\n\n- **Claire** paid `$70`\n- see [the doc](https://example.com/x)",
      provider,
      outDir: tmp,
    });
    const spoken = calls[0].text;
    for (const junk of ["##", "**", "`", "](", "http"]) {
      assert.ok(!spoken.includes(junk), `'${junk}' would be read literally — strip it (got: ${spoken})`);
    }
    assert.match(spoken, /Morning/);
    assert.match(spoken, /Claire paid \$70/);
    assert.match(spoken, /see the doc/);
  });

  await check("cleanForSpeech leaves ordinary prose alone", () => {
    const prose = "Your SCCR zoom is at 12:45 your time, not 1:45 — the invite is in mountain.";
    assert.equal(cleanForSpeech(prose), prose);
  });

  console.log("tts: the provider seam");

  await check("kokoro is the default engine and the shell hatch overrides it", () => {
    assert.equal(resolveProvider({} as NodeJS.ProcessEnv).name, "kokoro-82M");
    assert.equal(resolveProvider({ FIG_TTS_COMMAND: "say -o {out}" } as any).name, "shell");
    // Blank must not count as configured, or an empty export silently breaks every render.
    assert.equal(resolveProvider({ FIG_TTS_COMMAND: "   " } as any).name, "kokoro-82M");
  });

  await check("the shell hatch really can drive an outside engine end to end", async () => {
    // The escape hatch is the whole argument for the seam existing, so prove it with a
    // command that has nothing to do with Kokoro rather than asserting on the string.
    const provider = shellCommandProvider(`ffmpeg -y -loglevel error -f lavfi -i anullsrc -t 1 {out}`);
    const r = await speak({ text: "swap the engine, touch nothing else", provider, outDir: tmp });
    assert.ok(fs.existsSync(r.path));
    assert.equal(path.extname(r.path), ".m4a");
    assert.equal(r.engine, `shell/${DEFAULT_VOICE}`);
  });

  await check("a provider that fails surfaces as an error, and the tool turns it into a string", async () => {
    const { provider } = fakeProvider({ fail: "engine exploded" });
    await assert.rejects(() => speak({ text: "hi", provider, outDir: tmp }), /engine exploded/);
  });

  await check("the shell template escapes what it interpolates", async () => {
    // A voice name is user-ish input reaching /bin/sh. If it isn't quoted, `; rm -rf` runs.
    const marker = path.join(tmp, "pwned.txt");
    const provider = shellCommandProvider(`echo {voice} > /dev/null; touch {out}`);
    await provider
      .synthesize({
        text: "x",
        outPath: path.join(tmp, "esc.wav"),
        voice: `a'; touch ${marker}; echo '`,
        speed: 1,
      })
      .catch(() => {});
    assert.ok(!fs.existsSync(marker), "an injected command must not execute");
  });

  console.log("tts: input validation returns values, never throws through the tool");

  const handler = ttsServerDef.capabilities[0].handler;

  await check("empty text, a bad voice and an out-of-range speed each come back as a message", async () => {
    for (const [args, expected] of [
      [{ text: "   " }, /nothing to say/i],
      [{ text: "hi", voice: "am_adam" }, /unknown voice/i],
      [{ text: "hi", speed: 9 }, /out of range/i],
    ] as const) {
      const out = await handler(args as Record<string, any>);
      assert.match(out, /^speak failed:/, `${JSON.stringify(args)} should return, not throw`);
      assert.match(out, expected);
    }
  });

  await check("every advertised voice is one the engine actually accepts", () => {
    for (const v of KOKORO_VOICES) assert.ok(isValidVoice(v));
    assert.ok(!isValidVoice("af_bella"));
    assert.equal(DEFAULT_VOICE, "am_michael", "the default voice is pinned, not incidental");
  });

  console.log("tts: delivery + filesystem contract");

  await check("a returned path survives chunking as its own bubble", async () => {
    // This is the entire delivery mechanism: the tool sends nothing, it returns a path, and
    // chunking is what turns a bare path line into a real audio attachment.
    const { isLocalFilePath, splitIntoChunks } = await import("../render/chunking");
    const { provider } = fakeProvider();
    const r = await speak({ text: "attach me", provider, outDir: tmp });
    assert.ok(isLocalFilePath(r.path), "an .m4a path must be recognised as an attachable file");
    const chunks = splitIntoChunks(`here's the briefing\n\n${r.path}`);
    assert.ok(chunks.includes(r.path), "the path must land alone in its own bubble");
  });

  await check("renders go to ~/scratch/tts and never into the vault", () => {
    assert.equal(OUT_DIR, path.join(os.homedir(), "scratch", "tts"));
    assert.ok(
      OUT_DIR.startsWith(path.join(os.homedir(), "scratch")),
      "generated audio never goes in the vault",
    );
  });

  await check("the render env lives somewhere the monthly scratch sweep can't delete", () => {
    // ~/scratch is wiped on the 1st for anything untouched 30 days. The venv is READ, never
    // written, so it would look stale and vanish — and the tool would break in a way whose
    // cause is a month old. ~/.fig is the documented home for exactly this (machine-layout.md).
    assert.ok(!TTS_HOME.includes(`${path.sep}scratch${path.sep}`), "the venv cannot live in scratch");
    assert.equal(TTS_HOME, path.join(os.homedir(), ".fig", "tts"));
  });

  await check("the tool is registered once, in both lanes, as mcp__tts__speak", async () => {
    const { allCapabilities } = await import("../tools/registry");
    const found = allCapabilities().filter((c) => c.name === "mcp__tts__speak");
    assert.equal(found.length, 1, "one capability, one publication");
    assert.equal(found[0].capability.mutates, "write", "it writes a file to disk");
    assert.equal(ttsServerDef.exposure, "both", "the audio briefing IS an unattended pass");
    assert.equal(ttsServerDef.kind, "direct");
  });

  await fs.promises.rm(tmp, { recursive: true, force: true });
  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

void main();
