import "dotenv/config";

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { startCallBrainBridge } from "../../src/call/bridge/server";
import { CALL_BRIDGE_SOCKET_FLAG, CALL_BRIDGE_TOKEN_FLAG } from "../../src/call/bridge/wire";
import { buildCallContext } from "../../src/call/context";
import { runCallBrainTurn } from "../../src/call/brainTurn";
import { config } from "../../src/core/config";
import { speak } from "../../src/tts/speak";

/**
 * REALTIME front-end solo bench — everything provable WITHOUT a live call, end to end:
 *
 *   1. real brain bridge up (real context block, real runCallBrainTurn)
 *   2. session child spawned in --hold (the prewarm shape), timed to READY
 *   3. released with "go" (simulating the answer moment)
 *   4. a spoken QUESTION THAT NEEDS THE BRAIN streamed as the mic — the model must
 *      call ask_fig → socket → real fig turn → relay the answer as audio
 *   5. response audio written to a wav, full transcript on stdout
 *
 *   npx tsx scripts/dev/call-realtime-bench.ts [--question "…"] [--turn-only]
 *
 * --turn-only skips the realtime session and just runs the brain turn (cheap check).
 * Cost: one realtime-mini bench session (~cents) + one fig turn.
 */

const OUT_DIR = path.join(process.env.HOME || "", "scratch", "call-bench");
const QUESTION =
  process.argv.includes("--question")
    ? process.argv[process.argv.indexOf("--question") + 1]
    : "hey, quick check. what's actually still open on the facetime call lane. check your notes.";

async function makeQuestionWav(text: string): Promise<string> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const spoken = await speak({ text, outDir: OUT_DIR });
  const wav = path.join(OUT_DIR, "question-24k.wav");
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", spoken.path, wav]);
  console.log(`question wav: ${wav} (${spoken.seconds.toFixed(1)}s, ${spoken.engine}/${spoken.voice})`);
  return wav;
}

async function main(): Promise<void> {
  if (process.argv.includes("--turn-only")) {
    const t = Date.now();
    const answer = await runCallBrainTurn(QUESTION);
    console.log(`\n--- brain turn (${((Date.now() - t) / 1000).toFixed(1)}s) ---\n${answer}`);
    process.exit(0);
  }

  console.log("--- context block the session gets ---");
  console.log(buildCallContext());
  console.log("--------------------------------------\n");

  const wavIn = await makeQuestionWav(QUESTION as string);
  const wavOut = path.join(OUT_DIR, "bench-out.wav");

  const bridge = await startCallBrainBridge({
    context: () => buildCallContext(),
    ask: (q) => {
      console.log(`>> ask_fig over the socket: ${q}`);
      return runCallBrainTurn(q);
    },
    hangup: async () => console.log(">> hangup requested (bench: not pressing anything)"),
    note: (speaker, text) => console.log(`>> note [${speaker}]: ${text}`),
    ended: (reason) => console.log(`>> session ended: ${reason}`),
  });
  if (!bridge) throw new Error("bridge failed to start");

  const t0 = Date.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(config.repoRoot, "src", "call", "realtimeSessionChild.ts"),
      "--hold",
      "--bench",
      wavIn,
      "--out",
      wavOut,
      "--max-secs",
      "12",
      CALL_BRIDGE_SOCKET_FLAG,
      bridge.socketPath,
      CALL_BRIDGE_TOKEN_FLAG,
      bridge.token,
    ],
    { cwd: config.repoRoot, stdio: ["pipe", "pipe", "inherit"] },
  );

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
