import { spawn, type ChildProcess } from "node:child_process";

import { callBinaries, INJECT_DEVICE_UID } from "../paths";

/**
 * The live audio pipe — the mouth+ears machinery for a TypeScript session child.
 * Nothing here may be "improved"; every line is a survivor of a live-call failure:
 *
 *  - MOUTH plays ONLY into `BlackHoleInject2ch_UID` — the hidden patched-driver device
 *    the echo canceller can't see. Plain BlackHole 2ch gets erased (-60dB, live-proven).
 *  - EARS = `tapout sys <injectin pid>`: a global process tap EXCLUDING our own mouth,
 *    so fig structurally can't hear itself.
 *  - The FaceTime-audio-config-change restart and the 2s frozen-render watchdog live
 *    INSIDE the injectin binary (tools/call/injectin.swift) — a child inherits them by
 *    spawning the binary. If injectin can't self-heal it exits loudly and `onFatal`
 *    fires, so a call dies audibly instead of going silent.
 *  - SIGUSR1 to injectin = flush all queued mouth audio instantly (barge-in).
 *  - Tap-silence watchdog: audio flowed, then the tap went quiet too long → the call
 *    is over even if no other signal said so.
 */

export interface LiveAudioPipeOpts {
  /** Timestamped line logger (the child's log()). */
  log: (...a: unknown[]) => void;
  /** Raw passthrough for the binaries' stderr (already newline-terminated chunks). */
  logRaw: (chunk: string) => void;
  /** Every ears chunk (pcm16/mono/24k) as tapout emits it. */
  onEar: (chunk: Buffer) => void;
  /** The pipe is dead (mouth/ears process died, or tap went silent). Fires once. */
  onFatal: (reason: string) => void;
  /** Call-end watchdog: audio flowed, then the tap went silent this long. */
  tapSilenceMs?: number;
}

export class LiveAudioPipe {
  private injectin: ChildProcess | null = null;
  private tapout: ChildProcess | null = null;
  private lastTapData = 0;
  private everTapData = false;
  private stopped = false;
  private fatalFired = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LiveAudioPipeOpts) {}

  private fatal(reason: string): void {
    if (this.stopped || this.fatalFired) return;
    this.fatalFired = true;
    this.opts.onFatal(reason);
  }

  start(): void {
    if (this.injectin || this.stopped) return;
    const { log, logRaw, onEar } = this.opts;
    // MOUTH first (tap excludes its pid — the structural no-self-echo guarantee).
    this.injectin = spawn(callBinaries.injectin(), [INJECT_DEVICE_UID], { stdio: ["pipe", "ignore", "pipe"] });
    this.injectin.stderr?.on("data", (d) => logRaw(String(d)));
    this.injectin.on("exit", (c, s) => {
      log(`injectin exited code=${c} sig=${s}`);
      this.fatal("injectin died");
    });
    log(`injectin spawned pid=${this.injectin.pid} -> ${INJECT_DEVICE_UID}`);

    this.tapout = spawn(callBinaries.tapout(), ["sys", String(this.injectin.pid)], { stdio: ["ignore", "pipe", "pipe"] });
    this.tapout.stderr?.on("data", (d) => logRaw(String(d)));
    this.tapout.stdout?.on("data", (chunk: Buffer) => {
      this.lastTapData = Date.now();
      this.everTapData = true;
      onEar(chunk);
    });
    this.tapout.on("exit", (c, s) => {
      log(`tapout exited code=${c} sig=${s}`);
      this.fatal("tapout died (call likely ended)");
    });
    log(`tapout spawned pid=${this.tapout.pid} (sys tap excluding injectin)`);

    const tapSilenceMs = this.opts.tapSilenceMs ?? 60_000;
    this.silenceTimer = setInterval(() => {
      if (!this.stopped && this.everTapData && Date.now() - this.lastTapData > tapSilenceMs)
        this.fatal("no tap audio after having audio — call ended");
    }, 5000);
    this.silenceTimer.unref();
  }

  /** Queue mouth audio (pcm16/mono/24k). Silently drops when the mouth is gone. */
  play(buf: Buffer): void {
    if (this.injectin?.stdin?.writable) this.injectin.stdin.write(buf);
  }

  /** Barge-in: drop everything queued in the mouth NOW (injectin's SIGUSR1 flush). */
  flush(): void {
    this.injectin?.kill("SIGUSR1");
  }

  /**
   * Teardown: ears SIGTERM immediately; mouth gets stdin EOF (drains what's queued,
   * exits on drain) with a SIGTERM backstop.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    if (this.tapout) {
      try {
        this.tapout.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
    if (this.injectin) {
      try {
        this.injectin.stdin?.end();
      } catch {
        /* gone */
      }
      const child = this.injectin;
      setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }, 1500);
    }
  }
}
