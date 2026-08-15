import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";

/**
 * Where the call lane's native pieces live. `tools/call/*.swift` are the canonical
 * sources; `tools/call/build.sh` compiles them into `tools/call/bin/`, which is the
 * ONLY place they're read from. A missing binary must fail loudly at spawn — an
 * out-of-tree fallback would silently run a build nobody can diff against these
 * sources, which is worse than a clear error.
 */

const TOOLS_BIN = path.join(config.repoRoot, "tools", "call", "bin");

export const callBinaries = {
  /** Inbound answer watcher v2 — AX-presses the real Answer control, stays resident. */
  axAnswer: (): string => path.join(TOOLS_BIN, "ax-answer"),
  /** Outbound dial confirm — presses Call (or sweeps with Cancel) on the Click-to-Call banner. */
  dialConfirm: (): string => path.join(TOOLS_BIN, "ax-confirm"),
  /** Ends the live call (AX press End/Leave). Exit 2 = control not found. */
  axHangup: (): string => path.join(TOOLS_BIN, "ax-hangup"),
  /** EARS — CoreAudio process tap → pcm16/mono/24k stdout. */
  tapout: (): string => path.join(TOOLS_BIN, "tapout"),
  /** MOUTH — pcm16/mono/24k stdin → the hidden inject device (AEC bypass). */
  injectin: (): string => path.join(TOOLS_BIN, "injectin"),
};

/**
 * The ONLY correct mouth device. Playing into plain `BlackHole2ch_UID` gets erased
 * by FaceTime's echo canceller (live-proven, -60dB); the patched driver's hidden
 * second device surfaces on the mic stream without touching the echo reference.
 * Always target by UID — a reboot once flipped the system DEFAULT input to Inject
 * and broke everything, so nothing here may ever rely on device defaults.
 */
export const INJECT_DEVICE_UID = "BlackHoleInject2ch_UID";

/** Call-lane working files (session logs, transcripts in flight). */
export function callStateDir(): string {
  const dir = path.join(config.stateDir, "call");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
