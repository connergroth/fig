import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearTranscriptCache,
  transcribeAudioNote,
  transcribeAudioNotes,
  type WhisperRunner,
} from "./transcribe";

/** A real file on disk — the module refuses to shell out for something that isn't there. */
function tmpAudio(name = "att-0.caf"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fig-stt-test-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, "not really audio, the runner is faked");
  return p;
}

/** Fake mlx_whisper: writes what a real run would write into --output-dir. */
function fakeWhisper(text: string, opts: { code?: number; stderr?: string; noFile?: boolean } = {}): {
  run: WhisperRunner;
  calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[];
} {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
  const run: WhisperRunner = async (bin, args, o) => {
    calls.push({ bin, args: [...args], env: o.env, timeoutMs: o.timeoutMs });
    const i = args.indexOf("--output-dir");
    const dir = args[i + 1];
    if (!opts.code && !opts.noFile) fs.writeFileSync(path.join(dir, "out.txt"), text);
    return { code: opts.code ?? 0, stderr: opts.stderr ?? "" };
  };
  return { run, calls };
}

async function invocation(): Promise<void> {
  clearTranscriptCache();
  const file = tmpAudio();
  const { run, calls } = fakeWhisper("  hey fig, testing the voice note path  \n");
  const out = await transcribeAudioNote(file, { run, cache: false });

  assert.equal(out.ok, true);
  assert.equal(out.text, "hey fig, testing the voice note path", "transcript is trimmed");
  assert.equal(out.empty, false);
  assert.equal(out.path, file);
  assert.ok(out.ms >= 0);

  const [call] = calls;
  assert.equal(call.args[call.args.length - 1], file, "the audio file is the positional arg, last");
  assert.equal(call.args[call.args.indexOf("--model") + 1], "mlx-community/whisper-small-mlx", "cached small model");
  assert.equal(call.args[call.args.indexOf("--output-format") + 1], "txt");
  assert.equal(call.args[call.args.indexOf("--language") + 1], "en", "language is forced, not detected from noise");
  assert.equal(call.env.HF_HUB_OFFLINE, "1", "never allowed to stall the turn on a model download");

  // The scratch dir it wrote into is cleaned up, not left behind every voice note.
  const dir = call.args[call.args.indexOf("--output-dir") + 1];
  assert.equal(fs.existsSync(dir), false, "temp output dir removed");

  console.log("✓ invokes mlx_whisper correctly and returns the transcript");
}

async function degradation(): Promise<void> {
  clearTranscriptCache();
  const file = tmpAudio();

  // 1. whisper exits non-zero → a result object, never a throw.
  const broken = await transcribeAudioNote(file, {
    run: fakeWhisper("", { code: 1, stderr: "ModuleNotFoundError: No module named 'mlx_whisper'" }).run,
    cache: false,
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.text, "");
  assert.match(broken.error!, /ModuleNotFoundError/, "the real reason survives to the caller");

  // 2. exit 0 but no output file → still a clean failure.
  const noFile = await transcribeAudioNote(file, { run: fakeWhisper("", { noFile: true }).run, cache: false });
  assert.equal(noFile.ok, false);
  assert.match(noFile.error!, /no output file/);

  // 3. silence: ran fine, heard nothing. NOT an error — the two real .caf notes the owner
  //    sent both transcribe to exactly this, and calling that a failure would
  //    make fig apologise for a bug that didn't happen.
  const silent = await transcribeAudioNote(file, { run: fakeWhisper("\n \n").run, cache: false });
  assert.equal(silent.ok, true);
  assert.equal(silent.empty, true);
  assert.equal(silent.text, "");

  // 4. the file isn't on disk → fails without ever spawning anything.
  const { run, calls } = fakeWhisper("never runs");
  const missing = await transcribeAudioNote("/tmp/does-not-exist-9f3a.caf", { run, cache: false });
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /missing on disk/);
  assert.equal(calls.length, 0, "no process spawned for a file that isn't there");

  // 5. a runner that throws outright is still contained.
  const thrower: WhisperRunner = async () => {
    throw new Error("spawn EACCES");
  };
  const threw = await transcribeAudioNote(file, { run: thrower, cache: false });
  assert.equal(threw.ok, false);
  assert.match(threw.error!, /EACCES/);

  console.log("✓ every failure mode degrades to a result object, never a throw");
}

async function batching(): Promise<void> {
  clearTranscriptCache();
  const a = tmpAudio("a.caf");
  const b = tmpAudio("b.caf");
  const order: string[] = [];
  const run: WhisperRunner = async (_bin, args) => {
    const file = args[args.length - 1];
    order.push(path.basename(file));
    const dir = args[args.indexOf("--output-dir") + 1];
    fs.writeFileSync(path.join(dir, "out.txt"), `said ${path.basename(file)}`);
    return { code: 0, stderr: "" };
  };

  const results = await transcribeAudioNotes([a, b], { run, cache: false });
  assert.deepEqual(results.map((r) => r.text), ["said a.caf", "said b.caf"], "one result per file, in order");
  assert.deepEqual(order, ["a.caf", "b.caf"], "sequential — mlx on the GPU is slower in parallel, not faster");

  assert.deepEqual(await transcribeAudioNotes([], { run, cache: false }), [], "no notes → no work");

  console.log("✓ batch transcription");
}

async function caching(): Promise<void> {
  clearTranscriptCache();
  const file = tmpAudio();
  const { run, calls } = fakeWhisper("cached line");

  const first = await transcribeAudioNote(file, { run });
  const second = await transcribeAudioNote(file, { run });
  assert.equal(second.text, first.text);
  assert.equal(calls.length, 1, "the same staged file is only transcribed once (abort-and-fold re-runs a batch)");

  // Same path, new recording → the key includes size+mtime, so it re-transcribes.
  fs.writeFileSync(file, "a different recording entirely");
  const third = await transcribeAudioNote(file, { run: fakeWhisper("new line").run });
  assert.equal(third.text, "new line", "a restaged file at the same path is not a cache hit");

  console.log("✓ per-file memoisation keyed on content, not just path");
}

async function main(): Promise<void> {
  await invocation();
  await degradation();
  await batching();
  await caching();
  console.log("✓ stt/transcribe tests passed");
}

void main();
