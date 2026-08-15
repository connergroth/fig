import "dotenv/config";

import fs from "node:fs";

import WebSocket from "ws";

import {
  DRAIN_TAIL_MS,
  DRAIN_TIMEOUT_MS,
  PlaybackClock,
  TEARDOWN_DRAIN_TIMEOUT_MS,
  waitForDrain,
} from "./audio/drain";
import { LiveAudioPipe } from "./audio/pipe";
import { pcmSeconds, readWav24kMono, writeWav24kMono } from "./audio/wav";
import { BridgeClient } from "./bridge/client";
import { lineFramer, readCallBridgeArgs } from "./bridge/wire";
import { buildCallInstructions } from "./context";
import { HoldWatchdog } from "./holdWatchdog";

/**
 * The REALTIME call front-end — CHILD PROCESS entry point (CALL_FRONTEND=realtime,
 * the fallback path; the default local front-end runs the Rust child in
 * tools/call/child). An OpenAI realtime model is the mouth+ears, with fig behind
 * a tool:
 *
 *  - brain bridge client: `ask_fig` tool-calls proxy over the lane's unix socket into
 *    the running bot for a REAL fig turn; transcript lines stream back as notes.
 *  - pre-warm: `--hold` connects the websocket and configures the session but keeps
 *    the audio (and the greeting) parked until the lane writes "go" on stdin — so the
 *    child is spawned at RING time and fig talks ~1–2s after pickup instead of ~10.
 *    "abort" (declined/missed call) tears the warm session down cleanly: ws closed,
 *    no orphan session burning tokens.
 *  - `hang_up` tool: model ends the call naturally; the lane AX-presses End/Leave.
 *
 * Audio invariants, live-call-proven (do not "improve" these):
 *  - MOUTH plays ONLY into `BlackHoleInject2ch_UID` — the hidden patched-driver device
 *    the echo canceller can't see. Plain BlackHole 2ch gets erased (-60dB).
 *  - EARS = `tapout sys <injectin pid>`: a global process tap EXCLUDING our own mouth,
 *    so fig structurally can't hear itself.
 *  - Devices are addressed by UID, never by system default (a reboot once flipped the
 *    default input to Inject and broke everything).
 *
 * Runs as a child (not in-process) so a bot hot-reload can never kill a live call
 * mid-sentence, and a wedged audio pipe can be SIGKILLed without taking the bot down.
 */

const MODEL_LADDER = ["gpt-realtime-mini", "gpt-4o-mini-realtime-preview"];
const VOICE = "ash";
/** Hard cost/orphan cap: no session outlives this, connected or not. */
const MAX_SESSION_MS = 60 * 60 * 1000;
/**
 * A --hold session the lane stopped talking to dies on its own (orphan/lane-crash
 * safety net). RENEWED by the lane's `hold` stdin heartbeats while warming, disarmed
 * at "go" — see holdWatchdog.ts for the protocol.
 */
const HOLD_EXPIRE_MS = 120_000;
/** Call-end watchdog: audio flowed, then the tap went silent this long. */
const TAP_SILENCE_MS = 60_000;

// ---------- args ----------
const argv = process.argv.slice(2);
function flag(name: string, def: string | null): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
}
const HOLD = argv.includes("--hold");
const BENCH_IN = flag("--bench", null);
const BENCH_OUT = flag("--out", null);
const BENCH_MAX_SECS = parseFloat(flag("--max-secs", "10") ?? "10");
const OUTBOUND_REASON = flag("--outbound-reason", null);

// ---------- util ----------
function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(...a: unknown[]): void {
  console.log(ts(), ...a);
}

// ---------- realtime tools (GA function-calling shape) ----------
const SESSION_TOOLS = [
  {
    type: "function",
    name: "ask_fig",
    description:
      "your own full brain — real memory, calendar, email, the vault, every tool. use it for ANYTHING factual about the owner's life or your shared work: schedule, open loops, 'did X land', 'book that', 'what's pending'. takes 10-30s, so say a short filler out loud FIRST. the answer that comes back is yours — relay it naturally.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "the question or task, phrased with any context from the call the brain needs",
        },
      },
      required: ["question"],
    },
  },
  {
    type: "function",
    name: "hang_up",
    description: "end the call. use when the conversation wraps up naturally (they say bye / gotta go). say a quick bye BEFORE calling this.",
    parameters: { type: "object", properties: {} },
  },
];

// ---------- realtime connect ----------
function loadKey(): string {
  const key = (process.env.OPENAI_API_KEY || "").trim();
  if (!key) throw new Error("OPENAI_API_KEY unset (child must run with the bot repo's .env)");
  return key;
}

interface Connected {
  ws: WebSocket;
  model: string;
}

function tryConnect(key: string, model: string): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const to = setTimeout(() => {
      ws.terminate();
      reject(new Error("connect timeout (15s)"));
    }, 15000);
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        clearTimeout(to);
        reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    ws.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
    ws.once("message", (raw) => {
      clearTimeout(to);
      try {
        const ev = JSON.parse(String(raw));
        if (ev.type === "session.created") resolve({ ws, model });
        else if (ev.type === "error") {
          ws.terminate();
          reject(new Error(`server error on connect: ${JSON.stringify(ev.error ?? ev).slice(0, 300)}`));
        } else resolve({ ws, model });
      } catch {
        ws.terminate();
        reject(new Error("first message not json"));
      }
    });
  });
}

async function connectRealtime(key: string): Promise<Connected> {
  let lastErr: unknown = null;
  for (const model of MODEL_LADDER) {
    try {
      log(`connecting model=${model}…`);
      const r = await tryConnect(key, model);
      log(`connected: model=${model}`);
      return r;
    } catch (e) {
      lastErr = e;
      log(`connect failed for ${model}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw lastErr;
}

// ---------- main ----------
async function main(): Promise<void> {
  const t0 = Date.now();
  const bench = !!BENCH_IN;
  const bridgeArgs = readCallBridgeArgs(argv);
  log(`call session child start (${bench ? "BENCH" : "LIVE"}${HOLD ? ", HOLD" : ""}${bridgeArgs ? ", bridged" : ", NO BRIDGE"})`);

  // --- bridge first: the context block comes from the running bot ---
  let bridge: BridgeClient | null = null;
  let context = "";
  if (bridgeArgs) {
    bridge = new BridgeClient(bridgeArgs.socketPath, bridgeArgs.token);
    try {
      await bridge.connect();
      const res = await bridge.request({ method: "context" }, 10_000);
      if (res.ok && res.text) context = res.text;
      else log(`context fetch failed: ${"error" in res ? res.error : "empty"}`);
    } catch (e) {
      log(`bridge connect failed (${e instanceof Error ? e.message : e}) — running without a brain`);
      bridge = null;
    }
  }
  const instructions = buildCallInstructions({
    context: context || "(context unavailable — the brain bridge is down. say so if asked anything factual, and lean on ask_fig only if it starts working.)",
    outboundReason: OUTBOUND_REASON ?? undefined,
  });

  // --- state ---
  let shuttingDown = false;
  let released = !HOLD; // "go" received (or never held)
  let ready = false; // session.updated acknowledged
  let audioStarted = false;
  let responseActive = false;
  let audioQueuedSinceCancel = false;
  let tSpeechStopped: number | null = null;
  let sawFirstDelta = false;
  let hangupRequested = false;
  const latencies: number[] = [];
  let pipe: LiveAudioPipe | null = null;
  let tapBuf: Buffer[] = [];
  let tapBufBytes = 0;
  let benchPcm: Buffer | null = null;
  const benchOutChunks: Buffer[] = [];
  let benchAudioResponses = 0;
  let benchDone = false;
  let ws: WebSocket | null = null;
  /** How much mouth audio is still owed to the device — the drain-before-teardown clock. */
  const playback = new PlaybackClock();

  function send(obj: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /** `drain: false` when the mouth is already gone — there's nothing left to wait for. */
  function shutdown(reason: string, opts: { drain?: boolean } = {}): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    if (latencies.length) log(`latency summary: turns=${latencies.length} ms=[${latencies.join(", ")}]`);
    const wantsDrain = opts.drain !== false && !bench;
    void (async () => {
      if (wantsDrain) {
        // Queued speech finishes playing (plus the device pad) before injectin loses
        // stdin — teardown must never be the thing that truncates the last clause.
        const r = await waitForDrain(() => playback.isDraining(), {
          tailMs: DRAIN_TAIL_MS,
          timeoutMs: TEARDOWN_DRAIN_TIMEOUT_MS,
        });
        log(`teardown drain: ${r.drained ? "mouth empty" : "CAP HIT, audio still queued"} after ${r.waitedMs}ms`);
      }
      bridge?.notify({ method: "ended", reason });
      try {
        ws?.close();
      } catch {
        /* gone */
      }
      pipe?.stop();
      setTimeout(() => {
        bridge?.close();
        process.exit(0);
      }, 2500);
    })();
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  setTimeout(() => shutdown("max session duration"), MAX_SESSION_MS).unref();
  const holdWatchdog = HOLD
    ? new HoldWatchdog(HOLD_EXPIRE_MS, () => {
        if (!released && !shuttingDown) shutdown("hold expired with no go/abort/heartbeat (lane gone)");
      }).arm()
    : null;

  // --- lane control protocol on stdin: "go" | "abort" | "hold" (heartbeat) | "drain" ---
  process.stdin.setEncoding("utf8");
  process.stdin.on(
    "data",
    lineFramer((line) => {
      const cmd = line.trim();
      if (cmd === "drain") {
        // The lane holds its End press until this lands — same contract for every child.
        void waitForDrain(() => playback.isDraining(), {
          tailMs: DRAIN_TAIL_MS,
          timeoutMs: DRAIN_TIMEOUT_MS,
        }).then((r) => {
          log(`lane asked to drain: ${r.drained ? "mouth empty" : "CAP HIT, audio still queued"} after ${r.waitedMs}ms`);
          console.log("DRAINED"); // the lane's press marker — parsed, don't reword
        });
      } else if (cmd === "go") {
        log("lane says go");
        released = true;
        holdWatchdog?.disarm();
        maybeStart();
      } else if (cmd === "abort" || cmd.startsWith("abort ")) {
        // The lane sends the real reason after "abort" (remote disconnect, never
        // connected, …) — log THAT, not a guessed catch-all.
        shutdown(`aborted by lane (${cmd.slice("abort".length).trim() || "no reason given"})`);
      } else if (cmd === "hold") {
        holdWatchdog?.renew();
        log("lane heartbeat — hold renewed");
      }
    }),
  );
  process.stdin.on("error", () => {
    /* lane went away; watchdogs handle it */
  });

  // --- audio: ears + mouth (live) / wav source+sink (bench) ---
  function startAudio(): void {
    if (audioStarted || shuttingDown) return;
    audioStarted = true;
    if (bench) {
      benchPcm = readWav24kMono(BENCH_IN as string);
      const maxBytes = Math.floor(BENCH_MAX_SECS * 24000) * 2;
      if (benchPcm.length > maxBytes) benchPcm = benchPcm.subarray(0, maxBytes);
      log(`bench input: ${BENCH_IN} -> ${(benchPcm.length / 2 / 24000).toFixed(2)}s of speech`);
      let off = 0;
      const bytesPerTick = 2400 * 2; // 100ms
      const silence = Buffer.alloc(bytesPerTick);
      const timer = setInterval(() => {
        if (shuttingDown || benchDone) return clearInterval(timer);
        const pcm = benchPcm as Buffer;
        const chunk = off < pcm.length ? pcm.subarray(off, off + bytesPerTick) : silence;
        off += bytesPerTick;
        send({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
      }, 100);
      setTimeout(() => shutdown("bench: hard timeout 180s"), 180_000);
      return;
    }
    // Mouth+ears through the shared pipe (audio/pipe.ts).
    pipe = new LiveAudioPipe({
      log,
      logRaw: (chunk) => process.stdout.write(`${ts()} ${chunk}`),
      onEar: (chunk) => {
        tapBuf.push(chunk);
        tapBufBytes += chunk.length;
        if (tapBufBytes >= 1920) {
          // coalesce to >=40ms per ws message
          const buf = Buffer.concat(tapBuf);
          tapBuf = [];
          tapBufBytes = 0;
          send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
        }
      },
      onFatal: (reason) => {
        // Mouth/ears died — nothing left to drain into.
        if (!shuttingDown) shutdown(reason, { drain: false });
      },
      tapSilenceMs: TAP_SILENCE_MS,
    });
    pipe.start();
  }

  function greet(): void {
    // The opening beat: outbound = say why you called; inbound = quick hello. Driven by
    // instructions; this just kicks the first response so fig speaks without waiting.
    send({ type: "response.create" });
  }

  function maybeStart(): void {
    if (!ready || !released || shuttingDown || audioStarted) return;
    startAudio();
    if (!bench) greet();
    log(`LIVE at +${Date.now() - t0}ms (ready+released)`);
  }

  // --- mouth ---
  function playAudio(b64: string): void {
    const buf = Buffer.from(b64, "base64");
    audioQueuedSinceCancel = true;
    if (bench) benchOutChunks.push(buf);
    else {
      pipe?.play(buf);
      playback.bumpMs(pcmSeconds(buf) * 1000);
    }
  }
  function bargeIn(): void {
    if (responseActive) send({ type: "response.cancel" });
    if (pipe && audioQueuedSinceCancel) pipe.flush(); // flush queued speech instantly
    if (responseActive || audioQueuedSinceCancel) log("BARGE-IN: cancelled response + flushed injectin queue");
    audioQueuedSinceCancel = false;
    playback.clear(); // the queue was dropped — teardown must not wait on audio nobody hears
  }

  // --- tool calls ---
  async function handleFunctionCall(name: string, callId: string, argsJson: string): Promise<void> {
    let output = "";
    if (name === "ask_fig") {
      let question = "";
      try {
        question = String(JSON.parse(argsJson || "{}").question ?? "");
      } catch {
        /* leave empty */
      }
      log(`ask_fig: ${question.slice(0, 120)}`);
      if (!bridge) output = "(brain bridge is down — you can't look that up right now. say so and suggest they text you.)";
      else {
        const res = await bridge.request({ method: "ask", question }, 150_000);
        output = res.ok ? (res.text ?? "") : `(brain error: ${"error" in res ? res.error : "unknown"})`;
      }
      log(`ask_fig answered (${output.length} chars)`);
    } else if (name === "hang_up") {
      log("hang_up tool called");
      hangupRequested = true;
      output = "ending the call now";
    } else {
      output = `(unknown tool ${name})`;
    }
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    if (hangupRequested) {
      // Let the goodbye audio the model queued actually FINISH, then end on the machine —
      // a fixed timer here cuts the last clause whenever the goodbye outruns the guess.
      void (async () => {
        const r = await waitForDrain(() => playback.isDraining(), {
          tailMs: DRAIN_TAIL_MS,
          timeoutMs: DRAIN_TIMEOUT_MS,
        });
        log(`hang_up drain: ${r.drained ? "goodbye finished" : "CAP HIT, ending anyway"} after ${r.waitedMs}ms`);
        if (bridge) await bridge.request({ method: "hangup" }, 15_000);
        shutdown("hang_up tool", { drain: false }); // just drained — don't wait twice
      })();
    } else {
      send({ type: "response.create" });
    }
  }

  // --- realtime ---
  const { ws: sock, model } = await connectRealtime(loadKey());
  ws = sock;
  ws.on("message", (raw) => {
    let ev: any;
    try {
      ev = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (ev.type) {
      case "session.updated":
        if (!ready) {
          ready = true;
          log(`session.updated ok (model=${model}, voice=${VOICE}) at +${Date.now() - t0}ms`);
          console.log("READY"); // the lane's prewarm marker — parsed, don't reword
          maybeStart();
        }
        break;
      case "error":
        log("SERVER ERROR:", JSON.stringify(ev.error ?? ev).slice(0, 500));
        break;
      case "input_audio_buffer.speech_started":
        log("speech_started (owner talking)");
        bargeIn();
        break;
      case "input_audio_buffer.speech_stopped":
        tSpeechStopped = Date.now();
        sawFirstDelta = false;
        log("speech_stopped");
        break;
      case "response.created":
        responseActive = true;
        break;
      case "response.output_audio.delta":
        if (!sawFirstDelta) {
          sawFirstDelta = true;
          if (tSpeechStopped) {
            const ms = Date.now() - tSpeechStopped;
            latencies.push(ms);
            log(`TURN LATENCY (speech_stopped -> first audio delta): ${ms}ms`);
          }
        }
        playAudio(ev.delta);
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(ev.transcript ?? "").trim();
        if (text) {
          log(`[owner] ${text}`);
          bridge?.notify({ method: "note", speaker: "owner", text });
        }
        break;
      }
      case "response.output_audio_transcript.done": {
        const text = String(ev.transcript ?? "").trim();
        if (text) {
          log(`[fig] ${text}`);
          bridge?.notify({ method: "note", speaker: "fig", text });
        }
        break;
      }
      case "response.done": {
        responseActive = false;
        const resp = ev.response ?? {};
        log(`response.done status=${resp.status}`);
        const calls = (resp.output ?? []).filter((it: any) => it?.type === "function_call");
        for (const c of calls) void handleFunctionCall(String(c.name), String(c.call_id), String(c.arguments ?? "{}"));
        const hadAudio = (resp.output ?? []).some((it: any) =>
          (it?.content ?? []).some((p: any) => p?.type === "output_audio" || p?.type === "audio"),
        );
        if (hadAudio) benchAudioResponses += 1;
        // Bench completes when a response finishes with NO pending tool call and audio has
        // been produced — i.e. after the ask_fig round trip, not on the filler beat.
        if (bench && !benchDone && !calls.length && benchAudioResponses > 0) {
          benchDone = true;
          setTimeout(() => {
            const pcm = Buffer.concat(benchOutChunks);
            if (BENCH_OUT) {
              writeWav24kMono(BENCH_OUT, pcm);
              log(`bench: wrote ${(pcm.length / 2 / 24000).toFixed(2)}s of response audio -> ${BENCH_OUT}`);
            }
            shutdown("bench complete");
          }, 2000);
        }
        break;
      }
      default:
        break; // high-volume deltas + lifecycle noise
    }
  });
  ws.on("close", (code) => {
    log(`ws closed (${code})`);
    if (!shuttingDown) shutdown("ws closed");
  });
  ws.on("error", (e) => {
    log("ws error:", e.message);
    if (!shuttingDown) shutdown("ws error");
  });

  send({
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      output_modalities: ["audio"],
      tools: SESSION_TOOLS,
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-mini-transcribe" },
          // eagerness "low" = wait longer before deciding the caller is done. Default
          // endpointing cuts in on a mid-sentence pause, which on a real call reads as
          // fig talking over them; a beat of dead air is far cheaper than an interrupt.
          turn_detection: { type: "semantic_vad", eagerness: "low", interrupt_response: false },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: VOICE },
      },
    },
  });
}

main().catch((e) => {
  console.error(ts(), "FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
