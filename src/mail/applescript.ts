import { spawn } from "node:child_process";

import { warn } from "../core/log";

/**
 * Hardened osascript runner for driving Mail.app.
 *
 * Mail is a GUI app, not a service: it can be mid-sync (the CU Exchange account's
 * initial sync throws AppleEvent -1712 timeouts for every query), briefly busy, or
 * not running at all. So every script run here gets three layers of protection:
 *   1. an AppleScript-side `with timeout of N seconds` so Mail itself is given a
 *      bounded window to answer each event,
 *   2. a hard kill of the osascript child a beat after that window (a wedged
 *      osascript must never block the poll loop or leak processes),
 *   3. retry-with-backoff on the known-transient error shapes (-1712 timeouts,
 *      dead connections), since those resolve on their own once Mail settles.
 *
 * Anything non-transient (bad account name, missing mailbox) throws immediately.
 */

export interface OsaOptions {
  /** AppleScript `with timeout` window (seconds) — how long Mail gets per event. */
  timeoutSec?: number;
  /** Retries on TRANSIENT errors only (default 2, waits 5s then 15s). */
  retries?: number;
}

const DEFAULT_TIMEOUT_SEC = 30;
const RETRY_WAITS_MS = [5_000, 15_000];

/** Errors that mean "Mail is busy/syncing/not up yet" — worth retrying, never fatal. */
export function isTransientOsaError(message: string): boolean {
  return /-1712|AppleEvent timed out|timed out\b|-600\b|-609\b|-10810|connection is invalid|application isn.t running|osascript killed after/i.test(
    message,
  );
}

export class OsaError extends Error {
  constructor(
    message: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "OsaError";
  }
}

/** Quote a JS string as an AppleScript string literal. */
export function asQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One osascript run: script over stdin, bounded by a hard kill. Rejects with OsaError. */
function runOnce(script: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    let done = false;
    // Hard kill: AppleScript timeout + slack. A wedged Mail.app can hang osascript
    // past its own `with timeout`, and the poller must never block on it.
    const killer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new OsaError(`osascript killed after ${timeoutSec + 10}s hard timeout`, true));
    }, (timeoutSec + 10) * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      reject(new OsaError(`osascript spawn failed: ${e}`, false));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      if (code === 0) return resolve(out.replace(/\n$/, ""));
      const msg = (errOut || out || `osascript exited ${code}`).trim();
      reject(new OsaError(msg, isTransientOsaError(msg)));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

/**
 * Run an AppleScript body (auto-wrapped in `with timeout`), retrying transient
 * Mail busyness with backoff. Returns stdout with the trailing newline stripped.
 */
export async function runAppleScript(body: string, opts: OsaOptions = {}): Promise<string> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const retries = opts.retries ?? 2;
  const script = `with timeout of ${timeoutSec} seconds\n${body}\nend timeout`;
  let lastErr: OsaError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runOnce(script, timeoutSec);
    } catch (e) {
      const oe = e instanceof OsaError ? e : new OsaError(String(e), false);
      if (!oe.transient || attempt === retries) throw oe;
      lastErr = oe;
      const wait = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)];
      warn(`applescript transient (attempt ${attempt + 1}/${retries + 1}): ${oe.message.slice(0, 120)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new OsaError("applescript failed", false);
}
