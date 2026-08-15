import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { err, log, warn } from "../core/log";

/**
 * Messages.app dual-dylib injection + durability watchdog.
 *
 * fig's whole iMessage stack rides ONE Messages.app process launched with two
 * dylibs in DYLD_INSERT_LIBRARIES:
 *   1. imsg's bridge helper  → typing / read receipts / effects / tapbacks / rich send
 *   2. findmy.dylib         → the reverse-engineered Find My location reader
 * Both load in the same process because DYLD_INSERT_LIBRARIES is colon-separated.
 * SIP is off, so the adhoc-signed dylibs load without library validation.
 *
 * The fragile part this module fixes: if Messages.app ever relaunches CLEAN — a
 * reboot, a crash, or a plain `imsg send`/AppleScript auto-launching it while it's
 * dead — it comes back with NO dylibs, silently killing BOTH messaging-bridge
 * features AND Find My with no error. We detect that and re-inject.
 *
 * Health is TWO independent signals, because either dylib can die on its own:
 *
 *   1. the Find My dylib's heartbeat file, rewritten every ~2s (cheap: one stat)
 *   2. the imsg IMCore bridge's reported version, which must be v2 (a subprocess,
 *      so it runs on a slower cadence and is cached)
 *
 * Signal 2 exists because signal 1 lies about the bridge. A wedged bridge leaves the
 * Find My dylib ticking happily while imagent refuses the IMCore path: `imsg status`
 * still says "connected" but reports `bridge version: v0`, and every send-rich fails
 * and silently falls back to plain AppleScript sends — no rich-link cards, no
 * threading, no effects, no typing indicator, no read receipts, for hours, with the
 * watchdog reporting healthy the whole time. Connection state lies; the VERSION is
 * the signal. Repeated send-rich failures are the third, event-driven tripwire on the
 * same fault (see noteRichSend*).
 *
 *   IMSG_DYLIB     override path to imsg-bridge-helper.dylib
 *   FINDMY_DYLIB   override path to findmy.dylib (built from tools/findmy/)
 *   IMSG_BIN       path to the imsg binary (default "imsg" on PATH)
 */

const HOME = os.homedir();

/** Messages sandbox tmp — the find-my dylib writes heartbeat + result files here. */
export const MESSAGES_TMP = path.join(HOME, "Library/Containers/com.apple.MobileSMS/Data/tmp");
const HEARTBEAT_FILE = path.join(MESSAGES_TMP, "findmy-heartbeat.txt");
const MESSAGES_BIN = "/System/Applications/Messages.app/Contents/MacOS/Messages";

/** The dylib ticks heartbeat ~every 2s; 20s stale ⇒ ~10 missed ticks ⇒ truly dropped. */
const HEARTBEAT_STALE_MS = 20_000;
/** Don't relaunch more than once a minute — guards against a crash-loop. */
const RELAUNCH_COOLDOWN_MS = 60_000;

/** Exported (with the dylib resolvers below) so doctor reports the same paths this module loads — one resolution, no drift. */
export const IMSG_BIN = (process.env.IMSG_BIN || "imsg").trim();
/** The bridge version we require: anything below v2 means rich sends are dead. */
const REQUIRED_BRIDGE_VERSION = 2;
/** `imsg status` spawns a process, so probe far less often than the heartbeat stat. */
const BRIDGE_PROBE_INTERVAL_MS = 120_000;
/** Two send-rich failures in a row ⇒ the bridge is wedged, not one flaky message. */
const RICH_FAIL_THRESHOLD = 2;

export function imsgDylib(): string {
  const fromEnv = process.env.IMSG_DYLIB?.trim();
  if (fromEnv) return fromEnv;
  // Stable brew symlink (survives imsg version bumps) → version-pinned Cellar path.
  return "/opt/homebrew/opt/imsg/libexec/imsg-bridge-helper.dylib";
}

export function findmyDylib(): string {
  const fromEnv = process.env.FINDMY_DYLIB?.trim();
  if (fromEnv) return fromEnv;
  return path.join(HOME, "imsg-findmy/findmy.dylib");
}

/** Age of the find-my heartbeat in ms, or null if the file isn't there at all. */
export function heartbeatAgeMs(): number | null {
  try {
    return Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * True when the Find My dylib's heartbeat is ticking. NOTE: this proves the find-my
 * dylib is loaded and says NOTHING about the imsg bridge — a wedged bridge keeps this
 * green. Callers that care about rich sends want `isBridgeHealthy()` too; the watchdog
 * checks both. Kept as-is (and cheap) because the Find My callers only need this half.
 */
export function isInjectionHealthy(): boolean {
  const age = heartbeatAgeMs();
  return age !== null && age < HEARTBEAT_STALE_MS;
}

let lastRelaunch = 0;
let relaunching = false;

// ── bridge health (signal 2) ────────────────────────────────────────────────────
let lastBridgeVersion: number | null = null;
let lastBridgeProbe = 0;
let consecutiveRichFailures = 0;

/**
 * Ask imsg what bridge version it actually has. Returns the version number, or null
 * if the probe itself failed (imsg missing, timeout, unparseable) — null is "unknown",
 * deliberately NOT treated as unhealthy, so a broken probe can't crash-loop Messages.
 */
export function probeBridgeVersion(timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(IMSG_BIN, ["status", "--json"], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : parseBridgeVersion(stdout));
    });
  });
}

/** Pull the bridge version out of `imsg status --json`. null ⇒ couldn't tell. */
export function parseBridgeVersion(stdout: string): number | null {
  try {
    const s = JSON.parse(stdout) as { bridge_version?: number; v2_ready?: boolean };
    if (typeof s.bridge_version === "number") return s.bridge_version;
    // Older imsg builds only expose the boolean.
    if (typeof s.v2_ready === "boolean") return s.v2_ready ? 2 : 0;
    return null;
  } catch {
    return null;
  }
}

/** Cached bridge check — re-probes at most every BRIDGE_PROBE_INTERVAL_MS unless forced. */
async function bridgeVersion(force = false): Promise<number | null> {
  if (!force && Date.now() - lastBridgeProbe < BRIDGE_PROBE_INTERVAL_MS) return lastBridgeVersion;
  lastBridgeProbe = Date.now();
  const v = await probeBridgeVersion();
  if (v !== null) lastBridgeVersion = v;
  return lastBridgeVersion;
}

/** Last known bridge version (null = never successfully probed). No I/O. */
export function knownBridgeVersion(): number | null {
  return lastBridgeVersion;
}

/**
 * True when the IMCore bridge is at the version rich sends need. Unknown (probe never
 * succeeded) counts as healthy so we never thrash Messages over a broken probe.
 */
export async function isBridgeHealthy(force = false): Promise<boolean> {
  const v = await bridgeVersion(force);
  return v === null || v >= REQUIRED_BRIDGE_VERSION;
}

/**
 * Event-driven tripwire: the send path calls these on every send-rich attempt. A run of
 * failures is the earliest possible signal that the bridge went to v0 — it shows up on
 * the next send, not on the next 2-minute probe.
 */
export function noteRichSendFailure(): void {
  consecutiveRichFailures += 1;
  if (consecutiveRichFailures === RICH_FAIL_THRESHOLD) {
    warn(`inject: ${consecutiveRichFailures} consecutive send-rich failures — checking the bridge`);
    void healIfBridgeWedged();
  }
}

export function noteRichSendSuccess(): void {
  consecutiveRichFailures = 0;
}

/**
 * Force a bridge probe and relaunch if it really is below v2. Rate-limited by the same
 * relaunch cooldown, so a burst of failed sends can't stack relaunches.
 */
async function healIfBridgeWedged(): Promise<void> {
  if (relaunching || Date.now() - lastRelaunch < RELAUNCH_COOLDOWN_MS) return;
  const v = await bridgeVersion(true);
  if (v === null || v >= REQUIRED_BRIDGE_VERSION) return; // probe broken, or bridge is fine
  err(`inject: imsg bridge is v${v} (need v${REQUIRED_BRIDGE_VERSION}) — rich sends are dead, relaunching`);
  consecutiveRichFailures = 0;
  await relaunchInjected();
}

function killMessages(): Promise<void> {
  return new Promise((resolve) => {
    execFile("/usr/bin/killall", ["Messages"], () => resolve());
  });
}

function spawnInjected(): void {
  const dyld = `${imsgDylib()}:${findmyDylib()}`;
  const child = spawn(MESSAGES_BIN, [], {
    env: { ...process.env, DYLD_INSERT_LIBRARIES: dyld },
    stdio: "ignore",
    detached: true,
  });
  child.on("error", (e) => err(`inject: failed to spawn Messages (${e})`));
  child.unref();
  log(`inject: launched Messages with dual injection`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHeartbeat(timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isInjectionHealthy()) return true;
    await delay(1000);
  }
  return false;
}

/** Kill Messages and relaunch it with both dylibs; resolves once the heartbeat returns. */
export async function relaunchInjected(): Promise<boolean> {
  if (relaunching) return false; // a relaunch is already in flight
  relaunching = true;
  try {
    for (const f of [imsgDylib(), findmyDylib()]) {
      if (!fs.existsSync(f)) {
        err(`inject: dylib missing (${f}) — cannot re-inject`);
        return false;
      }
    }
    lastRelaunch = Date.now();
    warn("inject: Messages injection unhealthy — relaunching with both dylibs");
    await killMessages();
    await delay(1500); // let the old process(es) die before relaunch
    spawnInjected();
    const ok = await waitForHeartbeat();
    if (!ok) {
      err("inject: heartbeat never returned after relaunch — Find My + bridge may be down");
      return false;
    }
    // Heartbeat back ⇒ find-my dylib loaded. Confirm the OTHER half actually came back
    // too, since that's the failure this whole path exists for.
    consecutiveRichFailures = 0;
    const v = await bridgeVersion(true);
    if (v !== null && v < REQUIRED_BRIDGE_VERSION) {
      err(`inject: relaunched but bridge is still v${v} — rich sends will keep falling back to plain`);
      return false;
    }
    log(`inject: injection restored (heartbeat live, bridge v${v ?? "?"})`);
    return true;
  } finally {
    relaunching = false;
  }
}

/**
 * Cheap when healthy (one stat()): returns true if injection is live, otherwise
 * relaunches — unless we relaunched within the cooldown, in which case we just
 * report current health rather than thrash Messages.
 */
export async function ensureInjected(): Promise<boolean> {
  if (isInjectionHealthy()) return true;
  if (Date.now() - lastRelaunch < RELAUNCH_COOLDOWN_MS) return isInjectionHealthy();
  return relaunchInjected();
}

let watchdogStarted = false;
/**
 * Periodically self-heal the injection so a clean Messages relaunch never sticks, AND so
 * a wedged-but-loaded bridge doesn't sit at v0 unnoticed. Every tick does the cheap
 * heartbeat check; the bridge probe self-throttles to BRIDGE_PROBE_INTERVAL_MS.
 */
export function startInjectionWatchdog(intervalMs = 30_000): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  const tick = async (): Promise<void> => {
    const healed = await ensureInjected();
    if (!healed) return; // heartbeat path owns it; don't probe a Messages that's down
    if (Date.now() - lastBridgeProbe < BRIDGE_PROBE_INTERVAL_MS) return;
    if (!(await isBridgeHealthy(true))) await healIfBridgeWedged();
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  log(`inject: watchdog started (heartbeat every ${intervalMs / 1000}s, bridge every ${BRIDGE_PROBE_INTERVAL_MS / 1000}s)`);
}
