import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { callBinaries } from "../call/paths";
import {
  IMSG_BIN,
  findmyDylib,
  heartbeatAgeMs,
  imsgDylib,
  isInjectionHealthy,
} from "../transport/inject";
import { type CheckResult, type TierReport, evaluate, formatText, toJson } from "./tiers";

/**
 * `npm run doctor` — report the machine's capability tier and what the next one
 * needs. Runs on a stranger's mac with nothing installed, so every probe here
 * must degrade to a plain ✗ with a hint: no throws, every spawned command gets a
 * timeout, and a missing dep is a finding, not an error. Path resolution is
 * IMPORTED from the modules that actually load these deps (inject.ts, call/paths.ts)
 * so doctor can never report a different path than the runtime uses.
 */

/** execFile that never rejects — a dead/missing/slow command is just ok:false. */
function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? "") });
    });
  });
}

// ── tier 0 · plain iMessage ─────────────────────────────────────────────────────

async function checkImsgCli(): Promise<CheckResult> {
  const hint = "brew install steipete/tap/imsg";
  // IMSG_BIN may be an absolute override or a bare name on PATH — resolve accordingly.
  const installed = IMSG_BIN.includes("/")
    ? fs.existsSync(IMSG_BIN)
    : (await run("/usr/bin/which", [IMSG_BIN], 5_000)).ok;
  if (!installed) return { name: "imsg CLI", ok: false, detail: `${IMSG_BIN} not found`, hint };
  const ver = await run(IMSG_BIN, ["--version"], 10_000);
  return { name: "imsg CLI", ok: true, detail: ver.ok ? `imsg ${ver.stdout.trim()}` : IMSG_BIN };
}

function checkFullDiskAccess(): CheckResult {
  const name = "Full Disk Access";
  const db = path.join(os.homedir(), "Library/Messages/chat.db");
  const hint = "System Settings → Privacy & Security → Full Disk Access → add your terminal (and the daemon's parent)";
  // TCC denies at open(2), so actually open and read — a stat can lie.
  try {
    const fd = fs.openSync(db, "r");
    try {
      fs.readSync(fd, Buffer.alloc(16), 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    return { name, ok: true, detail: "chat.db opens and reads" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { name, ok: false, detail: "no chat.db — has Messages ever run here?", hint };
    return { name, ok: false, detail: `chat.db unreadable (${code ?? "denied"})`, hint };
  }
}

// ── tier 1 · rich iMessage bridge ───────────────────────────────────────────────

async function checkSipDisabled(): Promise<CheckResult> {
  const name = "SIP disabled";
  const hint = "boot into recovery and run `csrutil disable` — the price of injecting into Messages.app";
  const res = await run("/usr/bin/csrutil", ["status"], 5_000);
  if (!res.ok) return { name, ok: false, detail: "csrutil didn't answer", hint };
  const disabled = /disabled/i.test(res.stdout);
  return { name, ok: disabled, detail: res.stdout.trim().replace(/^System Integrity Protection status:\s*/i, "SIP "), hint };
}

function checkBridgeDylib(): CheckResult {
  const p = imsgDylib();
  return {
    name: "bridge dylib",
    ok: fs.existsSync(p),
    detail: p,
    hint: "ships with the imsg brew install; set IMSG_DYLIB if yours lives elsewhere",
  };
}

/**
 * The heartbeat file is written by the find-my dylib riding the SAME injected
 * Messages process as the bridge, so it's inject.ts's cheap "injection is alive"
 * signal — which also means tier 1 and tier 2 share it. That's honest to how the
 * runtime works today: one injection, one heartbeat.
 */
function checkInjectionHeartbeat(name: string): CheckResult {
  const age = heartbeatAgeMs();
  const hint = "launch Messages with the dylibs injected — the daemon's watchdog does this on start";
  if (age === null) return { name, ok: false, detail: "no heartbeat file", hint };
  const secs = Math.round(age / 1000);
  return { name, ok: isInjectionHealthy(), detail: `heartbeat ${secs}s old`, hint };
}

// ── tier 2 · find my ────────────────────────────────────────────────────────────

function checkFindmyDylib(): CheckResult {
  const p = findmyDylib();
  return {
    name: "find-my dylib",
    ok: fs.existsSync(p),
    detail: p,
    hint: "tools/findmy/build.sh compiles the dylib; put it at that path or point FINDMY_DYLIB at it",
  };
}

// ── tier 3 · calls ──────────────────────────────────────────────────────────────

function checkCallBinaries(): CheckResult {
  const missing = Object.entries(callBinaries)
    .filter(([, resolve]) => !fs.existsSync(resolve()))
    .map(([key]) => key);
  return {
    name: "call binaries",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : `all ${Object.keys(callBinaries).length} in tools/call/bin`,
    hint: "tools/call/build.sh compiles them from the swift sources in tools/call/",
  };
}

async function checkBlackhole(): Promise<CheckResult> {
  const name = "patched BlackHole driver";
  const hint = "install BlackHole with the AEC-bypass patch — stock BlackHole lacks the hidden Inject device calls need";
  // system_profiler is slow but it's the no-extra-deps way to list CoreAudio devices.
  const res = await run("/usr/sbin/system_profiler", ["-json", "SPAudioDataType"], 20_000);
  if (!res.ok) return { name, ok: false, detail: "couldn't list audio devices", hint };
  let names: string[] = [];
  try {
    const parsed = JSON.parse(res.stdout) as { SPAudioDataType?: Array<{ _items?: Array<{ _name?: string }> }> };
    names = (parsed.SPAudioDataType ?? []).flatMap((g) => (g._items ?? []).map((i) => i._name ?? ""));
  } catch {
    return { name, ok: false, detail: "unparseable audio device list", hint };
  }
  // The patch's tell is the hidden second device (paths.ts targets it by UID; the
  // profiler only exposes names, so match the name). Plain "BlackHole 2ch" is stock.
  const ok = names.some((n) => /blackhole\s*inject/i.test(n));
  const seen = names.filter((n) => /blackhole/i.test(n));
  return { name, ok, detail: seen.length ? `devices: ${seen.join(", ")}` : "no BlackHole devices", hint };
}

// ── report ──────────────────────────────────────────────────────────────────────

async function collect(): Promise<TierReport[]> {
  return [
    { tier: 0, label: "plain iMessage", checks: [await checkImsgCli(), checkFullDiskAccess()] },
    {
      tier: 1,
      label: "rich iMessage bridge",
      checks: [await checkSipDisabled(), checkBridgeDylib(), checkInjectionHeartbeat("injection alive")],
    },
    { tier: 2, label: "find my", checks: [checkFindmyDylib(), checkInjectionHeartbeat("find-my heartbeat")] },
    { tier: 3, label: "calls", checks: [checkCallBinaries(), await checkBlackhole()] },
  ];
}

async function main(): Promise<void> {
  const reports = await collect();
  const verdict = evaluate(reports);
  console.log(process.argv.includes("--json") ? toJson(reports, verdict) : formatText(reports, verdict));
}

void main();
