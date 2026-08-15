import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config } from "../../src/core/config";

/**
 * TS-side protocol smoke for the Rust session child. `npm run test:call-rust` builds
 * the debug binary and sets CALL_RUST_PROTOCOL_BIN, making this check mandatory there.
 * The ordinary TS-only suite skips when Rust has not been built on the machine.
 */

const binary =
  process.env.CALL_RUST_PROTOCOL_BIN ||
  path.join(config.repoRoot, "tools", "call", "child", "target", "debug", "fig-call-child");

async function main(): Promise<void> {
  if (!fs.existsSync(binary)) {
    console.log("↷ rust call child protocol smoke skipped (build it with npm run build:call-rust)");
    return;
  }
  const child = spawn(binary, ["--hold", "--protocol-probe"], {
    cwd: config.repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let aborted = false;
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.includes("READY") && !stdout.includes("lane heartbeat")) {
      child.stdin.write("hold\n");
      setTimeout(() => child.stdin.write("go\n"), 20);
      // The hangup contract: the lane holds its End press until DRAINED comes back,
      // and only ends the call once it has.
      setTimeout(() => child.stdin.write("drain\n"), 40);
    }
    if (!aborted && /(?:^|\n)DRAINED(?:\n|$)/.test(stdout)) {
      aborted = true;
      child.stdin.write("abort protocol smoke\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`rust protocol smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5_000);
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /(?:^|\n)READY(?:\n|$)/, "exact READY marker");
  assert.match(stdout, /lane heartbeat — hold renewed/, "hold heartbeat accepted");
  assert.match(stdout, /lane says go/, "go accepted");
  assert.match(stdout, /(?:^|\n)DRAINED(?:\n|$)/, "exact DRAINED marker on its own line");
  assert.match(stdout, /aborted by lane \(protocol smoke\)/, "abort reason retained");
  assert.ok(
    stdout.indexOf("\nDRAINED") < stdout.indexOf("aborted by lane"),
    "the child reports DRAINED BEFORE the call is ended — the hangup must not cut the goodbye",
  );
  console.log("✓ rust call child stdio protocol smoke passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
