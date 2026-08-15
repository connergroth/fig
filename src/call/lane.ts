import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { log, warn } from "../core/log";
import { logCallDigest, logCallLine } from "../session/transcript";
import { startCallBrainBridge, type CallBridgeHandle } from "./bridge/server";
import { CALL_BRIDGE_SOCKET_FLAG, CALL_BRIDGE_TOKEN_FLAG } from "./bridge/wire";
import { buildCallContext } from "./context";
import { callChildLaunch, resolveCallFrontend } from "./frontend";
import { awaitChildMarker, DRAINED_MARKER, drainThenPress } from "./hangup";
import { CallMonitor, type CallMarker } from "./monitor";
import { callBinaries, callStateDir } from "./paths";
import { firePostCallTurn } from "./postCall";

/**
 * The call lane orchestrator — the bot owns the FaceTime lane end to end:
 *
 *  - keeps the inbound answer watcher (ax-answer) resident, respawning it forever
 *  - watches call state live via CallMonitor (`log stream` — the only truth source
 *    on this machine; `log show` is empty and CallHistory lies about outbound)
 *  - PRE-WARMS the session at RING time: child spawned + models loaded while the
 *    phone is still ringing, released with "go" the moment the call is actually up —
 *    fig talks ~1–2s after pickup instead of ~10
 *  - tears a warm session down cleanly when the call never connects
 *  - brains the session over the per-call unix socket bridge (context / ask / hangup)
 *  - logs the transcript into Conversations/ live + a digest line at call end
 *  - wakes fig's MAIN loop after a real connected call ends (postCall.ts) so anything
 *    promised mid-call actually gets executed instead of dying with the session child
 *  - dials OUTBOUND (open facetime-audio:// + AX press of the Call banner), releasing
 *    the session only on live MEDIA markers — never the CallHistory db, which records
 *    connected outbound calls as unanswered
 *
 * The MACHINE this needs (accessibility trust, screen lock, screen-share detach, the
 * patched BlackHole mouth, the dead ends not to rebuild, and the debug playbook) is
 * documented once in the vault: System/Reference/facetime-call-lane.md. Read that before
 * debugging a call that rings but never answers.
 */

const OWNER_LABEL = process.env.OWNER_NAME?.trim() || "the owner";
/** Watcher window per spawn (minutes) — it's respawned on exit, so this is just a refresh cadence. */
const WATCHER_WINDOW_MIN = 480;
/** Ring→connect deadline: inbound the watcher answers in <1s, so this only reaps missed calls. */
const INBOUND_ANSWER_TIMEOUT_MS = 45_000;
/** Outbound: how long the owner's phone rings before we give up and sweep the dial banner. */
const OUTBOUND_ANSWER_TIMEOUT_MS = 40_000;
/**
 * A disconnect marker while LIVE arms a delayed teardown instead of an instant one —
 * cancelled if a media marker follows — because the disconnect log family can carry
 * cleanup lines for an EARLIER call. Worst case cost of the delay: the session outlives
 * the call by this long (its own 60s tap-silence watchdog is the backstop anyway).
 */
const DISCONNECT_CONFIRM_MS = 6_000;
/** Refuse to re-prewarm off trailing ring lines from a call that just ended. */
const RING_COOLDOWN_MS = 10_000;
/**
 * Cadence of the `hold` heartbeat written to an UNRELEASED session child's stdin, so
 * its 120s hold-expiry watchdog only fires when the lane is actually gone (child
 * orphaned), never merely because time passed. Stops at "go" — a released session is
 * governed by the call watchdogs, not hold expiry.
 */
const HOLD_HEARTBEAT_MS = 30_000;

interface ActiveCall {
  direction: "inbound" | "outbound";
  child: ChildProcess;
  bridge: CallBridgeHandle;
  logFile: string;
  startedAt: number;
  connectedAt: number | null;
  released: boolean;
  finalized: boolean;
  turns: { owner: number; fig: number };
  answerTimer: NodeJS.Timeout | null;
  disconnectTimer: NodeJS.Timeout | null;
  /** `hold` heartbeat to the unreleased child (keeps its hold-expiry watchdog renewed). */
  holdBeatTimer: NodeJS.Timeout | null;
  /** Once-per-call latch for the post-call turn (set by firePostCallTurn). */
  postCallFired: boolean;
}

let enabled = false;
let monitor: CallMonitor | null = null;
let watcher: ChildProcess | null = null;
let watcherRespawnTimer: NodeJS.Timeout | null = null;
let active: ActiveCall | null = null;
let prewarming = false;
let lastFinalizedAt = 0;

/** True while a call (warm or live) is in flight — holds off the idle code-reload. */
export function callLaneActive(): boolean {
  return active !== null || prewarming;
}

/**
 * The synchronous prewarm gate — pure so the double-spawn race stays testable.
 *
 * One ring can produce two "incoming call" log-stream lines ms apart, and both would
 * pass `if (active) return` because `active` isn't assigned until AFTER prewarm's
 * first await (the bridge listen). Twin sessions are poison: the loser never gets
 * go/abort, expires its hold, and reports "ended" for a call that's still live. The
 * `prewarming` latch is set synchronously before any await, so a second trigger in
 * the same tick bounces here.
 */
export function prewarmGate(
  state: { active: boolean; prewarming: boolean; lastFinalizedAt: number },
  direction: "inbound" | "outbound",
  now: number,
): boolean {
  if (state.active || state.prewarming) return false;
  if (direction === "inbound" && now - state.lastFinalizedAt < RING_COOLDOWN_MS) return false;
  return true;
}

export function callLaneStatus(): string {
  if (!enabled) return "call lane is off (CALL_LANE!=1).";
  if (!active) return "call lane armed — watcher resident, monitor live, no call in flight.";
  const age = Math.round((Date.now() - active.startedAt) / 1000);
  return `${active.direction} call ${active.released ? "LIVE" : "warming (not yet connected)"} — ${age}s in, ${active.turns.owner + active.turns.fig} transcript turns.`;
}

// ---------- helpers ----------

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const anyErr = err as (Error & { code?: number | string }) | null;
      const code = anyErr ? (typeof anyErr.code === "number" ? anyErr.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/**
 * End the call on the machine: AX-press End/Leave (ax-hangup); if no control is found
 * (exit 2 — the in-call UI layout varies), fall back to killing FaceTime, which
 * reliably ends the call, then relaunch it in the background so the inbound lane
 * stays alive.
 */
async function hangupOnMachine(): Promise<void> {
  const r = await run(callBinaries.axHangup(), ["5"]);
  if (r.code === 0) {
    log(`call lane: hangup pressed (${r.out.slice(0, 120)})`);
    return;
  }
  warn(`call lane: ax-hangup found no End control (code=${r.code}) — falling back to FaceTime restart`);
  await run("/usr/bin/pkill", ["-x", "FaceTime"]);
  setTimeout(() => {
    void run("/usr/bin/open", ["-g", "-a", "FaceTime"]);
  }, 3000);
}

// ---------- the answer watcher (inbound) ----------

function spawnWatcher(): void {
  if (!enabled || watcher) return;
  const bin = callBinaries.axAnswer();
  const child = spawn(bin, [String(WATCHER_WINDOW_MIN)], { stdio: ["ignore", "pipe", "pipe"] });
  watcher = child;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      // Two watcher signals, redundant with the monitor on purpose (belt + suspenders —
      // either path alone has answered a real call): the banner sighting doubles as a
      // ring trigger, the press as the connect trigger.
      if (/NC banner seen \(call=true\)/.test(line)) onRing("watcher banner");
      if (/answer fired/.test(line)) onConnected("watcher answer press");
    }
  });
  child.on("exit", (code, sig) => {
    if (watcher === child) watcher = null;
    if (!enabled) return;
    log(`call lane: answer watcher exited (code=${code} sig=${sig}) — respawning in 3s`);
    watcherRespawnTimer = setTimeout(spawnWatcher, 3000);
  });
  log(`call lane: answer watcher resident (pid=${child.pid}, ${WATCHER_WINDOW_MIN}min window, auto-respawn)`);
}

// ---------- session lifecycle ----------

async function prewarm(direction: "inbound" | "outbound", outboundReason?: string): Promise<void> {
  if (!prewarmGate({ active: active !== null, prewarming, lastFinalizedAt }, direction, Date.now())) return;
  // Latch BEFORE the first await (see prewarmGate) — cleared in the finally.
  prewarming = true;
  try {
    // Every bridge callback below is scoped to THIS call via thisCall, never the module
    // `active`: a session may only ever end ITSELF. An orphan's "ended" must never reach
    // whatever call happens to be active.
    let thisCall: ActiveCall | null = null;
    // The one writer of call transcript lines. Their side goes through here from the ASK,
    // not from the ear: the same transcript seeds the turn's prompt, so a line written
    // when the words were heard reaches the brain twice — as history and as the question, and
    // fig answers the same sentence twice out loud. See brainTurn.callTurnPrompt.
    const record = (speaker: "owner" | "fig", text: string): void => {
      logCallLine(speaker, text);
      if (thisCall && !thisCall.finalized) thisCall.turns[speaker === "owner" ? "owner" : "fig"] += 1;
    };
    const bridge = await startCallBrainBridge({
      context: () => buildCallContext(),
      // Dynamic import ON PURPOSE: brainTurn pulls in session/session.ts, whose module load
      // computes the lane surface from tools/registry — and THIS module is itself reachable
      // from the registry (via call/tools.ts). A static import here closes that cycle during
      // registry load and boots the bot with a half-initialized tool table. Deferring to
      // first ask breaks the cycle; the ~ms import cost hides inside a 5–30s brain turn.
      ask: async (question) => (await import("./brainTurn")).runCallBrainTurn(question),
      // The local front-end's lane: same real fig turn, token-streamed back over the
      // socket so the voice speaks clause-by-clause while the turn cooks. `signal` fires
      // when the child supersedes the turn — that has to kill the turn itself, not just
      // its audio, or a discarded reply still runs its tools — including hanging up the call.
      askStream: async (question, onDelta, signal, spoken, interrupted) =>
        (await import("./brainTurn")).runCallBrainTurn(
          question,
          signal,
          onDelta,
          spoken ? () => record("owner", question) : undefined,
          interrupted,
        ),
      hangup: () => hangupOnMachine(),
      note: record,
      ended: (reason) => {
        if (thisCall) finalize(thisCall, `session: ${reason}`);
      },
    });
    if (!bridge) {
      warn("call lane: bridge failed to start — not warming a session");
      return;
    }
    if (active) {
      // Belt+suspenders for anything that slips the latch: never stomp a call in flight.
      warn("call lane: a call went active while this prewarm was starting — dropping the duplicate");
      bridge.close();
      return;
    }

    const frontend = resolveCallFrontend();
    const logFile = path.join(callStateDir(), `session-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const childArgs = [
      "--hold",
      CALL_BRIDGE_SOCKET_FLAG,
      bridge.socketPath,
      CALL_BRIDGE_TOKEN_FLAG,
      bridge.token,
    ];
    if (outboundReason) childArgs.push("--outbound-reason", outboundReason);
    const launch = callChildLaunch(frontend, childArgs);
    const child = spawn(launch.command, launch.args, { cwd: config.repoRoot, stdio: ["pipe", "pipe", "pipe"] });
    const sink = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout?.pipe(sink);
    child.stderr?.pipe(sink);
    child.stdout?.on("data", (d: Buffer) => {
      if (String(d).includes("READY") && active?.child === child) {
        log(`call lane: session warm (READY) ${Date.now() - (active?.startedAt ?? Date.now())}ms after ring`);
      }
    });

    const call: ActiveCall = {
      direction,
      child,
      bridge,
      logFile,
      startedAt: Date.now(),
      connectedAt: null,
      released: false,
      finalized: false,
      turns: { owner: 0, fig: 0 },
      answerTimer: null,
      disconnectTimer: null,
      holdBeatTimer: null,
      postCallFired: false,
    };
    thisCall = call;
    active = call;

    call.answerTimer = setTimeout(
      () => {
        if (!call.finalized && !call.released) {
          log(`call lane: ${direction} call never connected — aborting warm session (missed/declined)`);
          abortChild(call, "never connected");
          if (direction === "outbound") void run(callBinaries.dialConfirm(), ["5", "cancel"]); // sweep the dial banner
        }
      },
      direction === "inbound" ? INBOUND_ANSWER_TIMEOUT_MS : OUTBOUND_ANSWER_TIMEOUT_MS,
    );

    // Keep the unreleased child's hold-expiry watchdog renewed while we're alive and
    // still tracking it: hold expiry then means exactly "the lane lost me" (orphan),
    // never "the lane is slow". Cleared at "go" (onConnected) and in finalize.
    call.holdBeatTimer = setInterval(() => {
      if (call.finalized || call.released) {
        if (call.holdBeatTimer) clearInterval(call.holdBeatTimer);
        call.holdBeatTimer = null;
        return;
      }
      try {
        call.child.stdin?.write("hold\n");
      } catch {
        /* stdin gone — the child's watchdog reaps it, scoped finalize cleans up here */
      }
    }, HOLD_HEARTBEAT_MS);

    child.on("exit", (code, sig) => {
      if (!call.finalized) {
        log(`call lane: session child exited (code=${code} sig=${sig})`);
        finalize(call, `child exited (code=${code})`);
      }
    });
    child.on("error", (error) => {
      if (!call.finalized) {
        warn(`call lane: session child failed to spawn (${error.message})`);
        finalize(call, `child spawn failed (${error.message})`);
      }
    });

    log(
      `call lane: PRE-WARM ${direction} — front-end=${frontend}, session child pid=${child.pid}, log=${path.basename(logFile)}`,
    );
  } finally {
    prewarming = false;
  }
}

function abortChild(call: ActiveCall, reason: string): void {
  try {
    // Reason rides along so the child's log tells the truth about WHY it was aborted.
    call.child.stdin?.write(`abort ${reason.replace(/\n/g, " ")}\n`);
  } catch {
    /* stdin gone — SIGTERM below */
  }
  setTimeout(() => {
    try {
      call.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }, 4000);
  finalize(call, reason);
}

/**
 * Per-CALL teardown — takes the call it ends, never reads module `active` to find one,
 * so a stray session can only ever finalize itself.
 */
function finalize(call: ActiveCall, reason: string): void {
  if (call.finalized) return;
  call.finalized = true;
  if (active === call) {
    active = null;
    lastFinalizedAt = Date.now();
  }
  if (call.answerTimer) clearTimeout(call.answerTimer);
  if (call.disconnectTimer) clearTimeout(call.disconnectTimer);
  if (call.holdBeatTimer) clearInterval(call.holdBeatTimer);
  // The bridge closes on a delay so straggler notes/ended from the dying child still land.
  setTimeout(() => call.bridge.close(), 5000);
  setTimeout(() => {
    try {
      call.child.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }, 8000);

  if (call.connectedAt) {
    const secs = Math.round((Date.now() - call.connectedAt) / 1000);
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
    logCallDigest(
      `voice call with ${OWNER_LABEL} ended (${call.direction}, ${dur}, ${call.turns.owner + call.turns.fig} turns — transcript above tagged [call]; ${reason})`,
    );
    log(`call lane: call ended — ${dur}, ${call.turns.owner}/${call.turns.fig} owner/fig turns (${reason})`);
    // AFTER the digest (so the wake's transcript reseed contains the whole call): wake
    // fig's main loop for a normal turn to execute anything promised mid-call. Fires only
    // for real connected calls ≥15s, once per call — see postCall.ts for the rules.
    firePostCallTurn(call);
  } else {
    log(`call lane: warm session closed without connecting (${reason})`);
  }
}

// ---------- marker plumbing ----------

function onRing(source: string): void {
  if (!enabled || active) return;
  log(`call lane: RING (${source}) — prewarming session`);
  void prewarm("inbound").catch((e) => warn(`call lane prewarm failed: ${e}`));
}

function onConnected(source: string): void {
  const call = active;
  if (!call || call.released) return;
  call.released = true;
  call.connectedAt = Date.now();
  if (call.answerTimer) clearTimeout(call.answerTimer);
  call.answerTimer = null;
  if (call.holdBeatTimer) clearInterval(call.holdBeatTimer);
  call.holdBeatTimer = null;
  try {
    call.child.stdin?.write("go\n");
  } catch (e) {
    warn(`call lane: couldn't release session (${e}) — killing it`);
    abortChild(call, "go failed");
    return;
  }
  log(`call lane: CONNECTED (${source}) — session released ${Date.now() - call.startedAt}ms after ring`);
}

function onMarker(marker: CallMarker): void {
  const call = active;
  switch (marker) {
    case "ring":
      onRing("log stream");
      break;
    case "answered":
      // Callee-side only ("Performing answer request" = our AX press landed).
      if (call?.direction === "inbound") onConnected("log stream: answer request");
      break;
    case "media":
      // Media flow = the ONLY trustworthy outbound pickup signal (CallHistory lies).
      onConnected("log stream: media flowing");
      // A live media marker also cancels any pending disconnect verdict.
      if (call?.disconnectTimer) {
        clearTimeout(call.disconnectTimer);
        call.disconnectTimer = null;
      }
      break;
    case "disconnected":
      if (!call) return;
      if (!call.released) {
        // Never connected + already tearing down elsewhere? abortChild is idempotent via finalize.
        log("call lane: disconnect before connect — caller gave up / declined");
        abortChild(call, "disconnected before connect");
      } else if (!call.disconnectTimer) {
        call.disconnectTimer = setTimeout(() => {
          if (active === call) {
            log("call lane: disconnect confirmed — ending session");
            abortChild(call, "remote disconnect");
          }
        }, DISCONNECT_CONFIRM_MS);
      }
      break;
  }
}

// ---------- outbound ----------

/**
 * Dial the owner (FaceTime audio). Pre-warms the session FIRST so it's connected by the
 * time they pick up, then fires the url dial + AX press of the Call banner. Session
 * releases on media markers only.
 */
export async function dialOwner(reason: string): Promise<string> {
  if (!enabled) throw new Error("call lane is off (CALL_LANE!=1)");
  if (active) throw new Error("a call is already in flight");
  const number = (config.ownerNumbers[0] ?? "").replace(/[^\d]/g, "");
  if (!number) throw new Error("no owner number configured");

  await prewarm("outbound", reason);
  if (!active) throw new Error("couldn't warm the call session");

  await run("/usr/bin/open", [`facetime-audio://${number}`]);
  const confirm = await run(callBinaries.dialConfirm(), ["20", "call"], 25_000);
  if (confirm.code !== 0) {
    const call = active;
    if (call) abortChild(call as ActiveCall, "dial confirm failed");
    void run(callBinaries.dialConfirm(), ["5", "cancel"]);
    throw new Error(`dial confirm failed: ${confirm.out.slice(0, 200)}`);
  }
  log(`call lane: outbound dial fired (…${number.slice(-4)}) — waiting for pickup (media markers)`);
  return `dialing ${OWNER_LABEL} — their phone should be ringing. The session goes live the moment media flows; if they don't pick up within ~40s the attempt is swept up automatically.`;
}

/**
 * Model-callable hangup for the LOCAL front-end: fig's own streamed turn (which runs
 * IN the bot, so it has the registry) calls facetime__hang_up when the owner says bye.
 * The End press waits on the child's actual mouth — see hangup.ts for the contract.
 */
export async function hangupLiveCall(): Promise<string> {
  if (!enabled) throw new Error("call lane is off (CALL_LANE!=1)");
  const call = active;
  if (!call || !call.released) throw new Error("no live call to hang up");

  // Backgrounded ON PURPOSE: the goodbye clauses are still streaming out of THIS turn,
  // so blocking the tool result would stop the very audio we're waiting to hear finish.
  void drainThenPress({
    send: (line) => {
      try {
        return call.child.stdin?.writable ? (call.child.stdin.write(line), true) : false;
      } catch {
        return false;
      }
    },
    awaitMarker: (timeoutMs) => awaitChildMarker(call.child, DRAINED_MARKER, timeoutMs),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    press: () => {
      if (active === call) void hangupOnMachine();
      else log("call lane: hang_up — the call ended on its own before the drain finished");
    },
    log: (m) => log(m),
  }).catch((e) => warn(`call lane: hang_up drain failed (${e}) — call left to its own watchdogs`));

  log("call lane: hang_up tool called — End press waits for the mouth to finish (drain probe sent)");
  return "ending the call — your goodbye will finish playing first, then I press End";
}

// ---------- lifecycle ----------

export function startCallLane(): void {
  if (enabled) return;
  if (process.platform !== "darwin") return;
  if (process.env.CALL_LANE !== "1") {
    log("call lane off (set CALL_LANE=1 to arm)");
    return;
  }
  enabled = true;

  // The bot owns the lane now: retire any shell-armed scratch watchers/triggers from the
  // gate era so two pressers can't race on one banner. (Their log streams are harmless.)
  // Broad "ax-answer" pattern ON PURPOSE: the scratch watcher's cmdline is `./ax-answer 180`
  // (cwd-relative — a path-anchored pattern misses it, the exact trap the old trigger script
  // dodged with a second pgrep). Safe because our own watcher spawns 1.5s AFTER this sweep.
  void run("/usr/bin/pkill", ["-f", "ax-answer"]).then(() =>
    void run("/usr/bin/pkill", ["-f", "on-answer-trigger"]),
  );

  monitor = new CallMonitor((marker) => onMarker(marker));
  monitor.start();
  setTimeout(spawnWatcher, 1500); // after the pkill sweep settles
  log("call lane ARMED — monitor live, watcher spawning, prewarm-on-ring active");
}

export function stopCallLane(): void {
  enabled = false;
  monitor?.stop();
  monitor = null;
  if (watcherRespawnTimer) clearTimeout(watcherRespawnTimer);
  if (watcher) {
    try {
      watcher.kill("SIGTERM");
    } catch {
      /* gone */
    }
    watcher = null;
  }
  const call = active;
  if (call) abortChild(call, "lane stopped");
}
