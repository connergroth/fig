import "dotenv/config";

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { startCallBrainBridge } from "../../src/call/bridge/server";
import { CALL_BRIDGE_SOCKET_FLAG, CALL_BRIDGE_TOKEN_FLAG } from "../../src/call/bridge/wire";
import { runCallBrainTurn } from "../../src/call/brainTurn";
import { callChildLaunch } from "../../src/call/frontend";
import { config } from "../../src/core/config";
import { speak } from "../../src/tts/speak";

/**
 * LOCAL front-end solo bench — the whisper → fig → kokoro pipeline end to end, NO
 * call involved:
 *
 *   1. a spoken question rendered to a wav (kokoro, different voice so stt is honest)
 *   2. the session child (tools/call/child) spawned in --hold (the exact prewarm
 *      shape the lane uses), timed to READY (kokoro model load + whisper warm)
 *   3. released with "go" (the answer moment); the wav plays the part of the mic
 *   4. the child endpoints it (VAD), whispers it, streams a REAL fig turn over the
 *      bridge socket, clause-renders through the persistent kokoro worker
 *   5. response audio lands in a wav; the child prints per-stage timings:
 *      stt ms · time-to-first-delta · time-to-first-audio · total
 *
 *   npx tsx scripts/dev/call-local-bench.ts [--question "…"] [--fake-brain]
 *
 * --fake-brain swaps the fig turn for a canned streamed reply (proves the pipeline +
 * measures stt/tts honestly, costs nothing). Without it, one real fig turn runs.
 */

const OUT_DIR = path.join(process.env.HOME || "", "scratch", "call-bench");
const FAKE = process.argv.includes("--fake-brain");
const QUESTION = process.argv.includes("--question")
  ? process.argv[process.argv.indexOf("--question") + 1]
  : "hey, quick check, what's actually still open on the facetime call lane. check your notes.";

const FAKE_REPLY = [
  "so the lane's basically done — inbound, outbound, and the brain bridge are all live-proven. ",
  "what's left is the local front-end swap we're benching right now, ",
  "plus one live call to shake out ring timing. ",
  "and rent's due saturday, so there's that.",
];

async function makeQuestionWav(text: string): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // bm_george asks so am_michael isn't transcribing his own voice print (honest stt).
  const spoken = await speak({ text, outDir: OUT_DIR, voice: "bm_george" });
  const wav = path.join(OUT_DIR, "local-question-24k.wav");
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", spoken.path, wav]);
  console.log(`question wav: ${wav} (${spoken.seconds.toFixed(1)}s, ${spoken.engine}/${spoken.voice})`);
  return wav;
}

async function main(): Promise<void> {
  const wavIn = await makeQuestionWav(QUESTION as string);
  const wavOut = path.join(OUT_DIR, "local-bench-out.wav");

  const bridge = await startCallBrainBridge({
    context: () => "(local front-end bench)",
    ask: (q) => runCallBrainTurn(q),
    askStream: async (q, onDelta) => {
      console.log(`>> ask_stream over the socket: ${q}`);
      if (FAKE) {
        let full = "";
        for (const piece of FAKE_REPLY) {
          await new Promise((r) => setTimeout(r, 400)); // ~token cadence
          onDelta(piece);
          full += piece;
        }
        return full;
      }
      // Delta cadence log: proves whether the SDK path truly token-streams or bursts
      // at the end. First few + every 20th, with offsets.
      const tAsk = Date.now();
      let n = 0;
      return runCallBrainTurn(q, undefined, (d) => {
        n++;
        if (n <= 3 || n % 20 === 0) console.log(`>> delta #${n} at +${Date.now() - tAsk}ms (${d.length} chars)`);
        onDelta(d);
      });
    },
    hangup: async () => console.log(">> hangup requested (bench: not pressing anything)"),
    note: (speaker, text) => console.log(`>> note [${speaker}]: ${text}`),
    ended: (reason) => console.log(`>> session ended: ${reason}`),
  });
  if (!bridge) throw new Error("bridge failed to start");

  const t0 = Date.now();
  const launch = callChildLaunch(
    "local",
    [
      "--hold",
      "--bench",
      wavIn,
      "--out",
      wavOut,
      CALL_BRIDGE_SOCKET_FLAG,
      bridge.socketPath,
      CALL_BRIDGE_TOKEN_FLAG,
      bridge.token,
    ],
  );
  console.log(`child: ${launch.frontend} front-end (${launch.command})`);
  const child = spawn(launch.command, launch.args, { cwd: config.repoRoot, stdio: ["pipe", "pipe", "inherit"] });

  child.stdout.setEncoding("utf8");
  let buf = "";
  child.stdout.on("data", (chunk: string) => {
    process.stdout.write(chunk);
    buf += chunk;
    if (buf.includes("READY")) {
      buf = ""; // only fire once
      console.log(`\n*** PREWARM: spawn -> READY in ${Date.now() - t0}ms — releasing with "go" ***\n`);
      child.stdin.write("go\n");
    }
  });
  child.on("exit", (code) => {
    console.log(`\nsession child exited (${code}); response audio (if any): ${wavOut}`);
    bridge.close();
    process.exit(0);
  });
}

void main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
