import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { log, warn } from "../core/log";

/**
 * Live call-state monitor: a resident `log stream` on the two call daemons, parsed
 * into four markers. This is the lane's ground truth for call lifecycle, chosen over
 * every alternative for hard-won reasons:
 *
 *  - `log show` returns ZERO rows on this machine — only a live stream sees anything,
 *    so all detection must be capture-as-it-happens.
 *  - The CallHistory db LIES about outbound calls: it records `ZANSWERED=0, cause=6`
 *    even when the call connected and media flowed. It is never consulted here.
 *    Outbound connect = the MEDIA markers below, nothing else.
 *
 * Marker sources (all seen verbatim in live captures, ~/scratch/ftlane/*.logstream):
 *  - ring:         callservicesd "…incoming call…" family (fires seconds before the banner)
 *  - answered:     callservicesd "Performing answer request" — the moment the AX press lands
 *  - media:        avconferenced VCConnectionHealthMonitor / "HandoverReport: new link
 *                  established" / "received callback for audio…" — appear only once media
 *                  actually flows (the ONLY trustworthy outbound pickup signal)
 *  - disconnected: callservicesd disconnect family
 */

export type CallMarker = "ring" | "answered" | "media" | "disconnected";

const ANSWERED_RE = /Performing answer request/;
const DISCONNECT_RE =
  /with disconnected call:|Setting disconnected reason to|Proceeding to disconnect all calls|Disconnecting all calls|endCallWithUUIDAsLocalHangup|sendCallDisconnectedMessageToClientForCall/;
const MEDIA_RE =
  /HandoverReport: new link established|VCConnectionHealthMonitor|received callback for audio enabled\[1\]|received callback for remote mediaType=Microphone change to mediaState=enable/;
const RING_RE = /incoming call/i;

/**
 * Classify one raw `log stream` line. Order matters: an "Asked to answer call …
 * while disconnecting" line must read as its dominant event, so answered and
 * disconnect are tested before the loose ring family.
 */
export function classifyCallLine(line: string): CallMarker | null {
  if (ANSWERED_RE.test(line)) return "answered";
  if (DISCONNECT_RE.test(line)) return "disconnected";
  if (MEDIA_RE.test(line)) return "media";
  if (RING_RE.test(line)) return "ring";
  return null;
}

const PREDICATE = '(process == "avconferenced" OR process == "callservicesd")';

export class CallMonitor {
  private child: ChildProcessByStdio<null, Readable, null> | null = null;
  private stopped = true;
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onMarker: (marker: CallMarker, line: string) => void) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawnStream();
  }

  stop(): void {
    this.stopped = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }

  private spawnStream(): void {
    if (this.stopped) return;
    const child = spawn("/usr/bin/log", ["stream", "--info", "--debug", "--predicate", PREDICATE], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const marker = classifyCallLine(line);
        if (marker) {
          try {
            this.onMarker(marker, line);
          } catch (e) {
            warn(`call monitor marker handler threw: ${e}`);
          }
        }
      }
    });
    child.on("exit", (code, sig) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      warn(`call monitor log stream died (code=${code} sig=${sig}) — respawning in 2s`);
      this.respawnTimer = setTimeout(() => this.spawnStream(), 2000);
    });
    log(`call monitor up (log stream pid=${child.pid})`);
  }
}
