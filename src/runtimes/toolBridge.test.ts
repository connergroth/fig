import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { config } from "../core/config";
import { fallbackToolList } from "../tools/fallback";
import { codexFigToolsArgs, codexTextRuntime } from "./codex";
import { bridgeCapabilities, bridgeToolList, startToolBridge, type ToolBridgeHandle } from "./toolBridge";
import { BRIDGE_SOCKET_FLAG, BRIDGE_TOKEN_FLAG, lineFramer, readBridgeArgs } from "./toolBridgeWire";

/**
 * Codex tool-bridge tests. The interesting ones are end-to-end over a real unix socket with a
 * real spawned `fig-tools-mcp.ts`, because every gap this bridge closes lives at that boundary:
 * the reduced surface, approvals, the ack, work-start, and toolsUsed were all things the
 * in-child executor structurally could not do.
 */

const RPC_TIMEOUT_MS = 60_000;

interface Child {
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  stop(): void;
}

function startFigToolsChild(extraArgs: string[]): Child {
  const child = spawn(
    path.join(config.repoRoot, "node_modules", ".bin", "tsx"),
    [path.join(config.repoRoot, "src", "runtimes", "fig-tools-mcp.ts"), ...extraArgs],
    { cwd: config.repoRoot, stdio: ["pipe", "pipe", "inherit"], env: process.env },
  );
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on(
    "data",
    lineFramer((line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // a stray non-JSON line (module-load logging) is not a response
      }
      const resolve = pending.get(msg.id);
      if (!resolve) return;
      pending.delete(msg.id);
      resolve(msg);
    }),
  );
  return {
    rpc: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`fig-tools ${method} timed out`)), RPC_TIMEOUT_MS);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) return reject(new Error(`${method}: ${msg.error.message}`));
          resolve(msg.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    stop: () => child.kill("SIGKILL"),
  };
}

/** One raw request straight at the socket — for the paths no child would ever send. */
function rawBridgeCall(socketPath: string, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on(
      "data",
      lineFramer((line) => {
        socket.end();
        resolve(JSON.parse(line));
      }),
    );
  });
}

async function main(): Promise<void> {
  // ── surface derivation ─────────────────────────────────────────────────────────────────────
  const liveNames = bridgeCapabilities("live").map((c) => c.fallbackName);
  const unattendedNames = bridgeCapabilities("unattended").map((c) => c.fallbackName);

  // The whole point of gap #1: the job control plane lives in the main process, so the in-child
  // executor could never publish it. Bridged, it's just another tool.
  assert.ok(liveNames.includes("jobs__list"), "bridged live surface must carry the jobs control plane");
  assert.ok(liveNames.includes("ack__ack"), "bridged live surface must carry the ack channel");
  // Lane parity with the Claude side, derived from each server's own `exposure`.
  assert.ok(!unattendedNames.includes("ack__ack"), "ack is live-only — an unattended pass must not get it");
  assert.ok(!unattendedNames.includes("codex__delegate"), "coding delegation is live-only");
  assert.ok(unattendedNames.includes("jobs__list"), "exposure:both servers reach both lanes");
  // Strict superset of the old reduced surface: bridging may not LOSE a tool codex already had.
  for (const t of fallbackToolList()) {
    assert.ok(liveNames.includes(t.name), `bridged surface dropped ${t.name}, which the fallback surface had`);
  }
  assert.ok(liveNames.length > fallbackToolList().length, "the bridge exists to be a bigger surface");
  // Schemas are derived from the registry's Zod shape, not authored here.
  const listedJobs = bridgeToolList("live").find((t) => t.name === "jobs__list");
  assert.ok(listedJobs && typeof listedJobs.inputSchema === "object", "tool list must carry a derived schema");

  // ── wire ───────────────────────────────────────────────────────────────────────────────────
  assert.equal(readBridgeArgs(["--other", "x"]), null, "no endpoint in argv → no bridge");
  assert.deepEqual(readBridgeArgs([BRIDGE_SOCKET_FLAG, "/tmp/s.sock", BRIDGE_TOKEN_FLAG, "tok"]), {
    socketPath: "/tmp/s.sock",
    token: "tok",
  });
  const framed: string[] = [];
  const feed = lineFramer((l) => framed.push(l));
  feed('{"a":1}\n{"b":');
  feed('2}\n');
  assert.deepEqual(framed, ['{"a":1}', '{"b":2}'], "framing must survive a split chunk");

  // ── codex args: one mcp_servers block, endpoint only when bridged ───────────────────────────
  const fakeBridge: ToolBridgeHandle = {
    socketPath: "/tmp/fake.sock",
    token: "tok",
    toolsUsed: () => [],
    close: () => {},
  };
  for (const [label, args, bridged] of [
    ["unbridged", codexFigToolsArgs(), false],
    ["bridged", codexFigToolsArgs(fakeBridge), true],
  ] as const) {
    const servers = new Set(args.filter((a) => a.startsWith("mcp_servers.")).map((a) => a.split(".")[1]));
    assert.equal(servers.size, 1, `${label}: codex must be configured with exactly one mcp_servers block`);
    assert.equal(
      args.some((a) => a.includes(BRIDGE_SOCKET_FLAG)),
      bridged,
      `${label}: bridge endpoint present iff a bridge is running`,
    );
    assert.ok(
      args.some((a) => a.includes(`tool_timeout_sec=${bridged ? 900 : 60}`)),
      `${label}: tool timeout must leave room for a 🔐 round-trip only when one is possible`,
    );
  }

  // ── role scoping: only main-role runs get a bridge ─────────────────────────────────────────
  // CODEX_ENABLED=0 makes runCodex return immediately, so this exercises the wiring without
  // spawning the codex CLI.
  process.env.CODEX_ENABLED = "0";
  const delegatedRun = await codexTextRuntime.runTextResult({
    label: "test",
    prompt: "hi",
    providerOptions: { role: "delegated" },
  });
  assert.equal(delegatedRun.toolsUsed, undefined, "a delegated codex run must not get a bridge at all");
  const mainRun = await codexTextRuntime.runTextResult({
    label: "test",
    prompt: "hi",
    providerOptions: { role: "main" },
  });
  assert.deepEqual(mainRun.toolsUsed, [], "a main-role run reports toolsUsed (empty here: it called nothing)");
  delete process.env.CODEX_ENABLED;

  // ── end-to-end: bridged child ──────────────────────────────────────────────────────────────
  const asked: string[] = [];
  const emitted: string[] = [];
  let workStarted = 0;
  const bridge = await startToolBridge({
    lane: "live",
    askOwner: async (q) => {
      asked.push(q);
      return false;
    },
    emit: async (t) => {
      emitted.push(t);
    },
    onWorkStarted: () => {
      workStarted++;
    },
  });
  assert.ok(bridge, "bridge must come up");

  const bridged = startFigToolsChild([BRIDGE_SOCKET_FLAG, bridge.socketPath, BRIDGE_TOKEN_FLAG, bridge.token]);
  try {
    const init = await bridged.rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.match(init.instructions, /fig's main process/, "bridged initialize must advertise in-process execution");

    const listed = await bridged.rpc("tools/list");
    const names = (listed.tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes("jobs__list"), "the child must serve the BRIDGED list, not its own fallback one");
    assert.ok(names.includes("ack__ack"));

    // gap #3 + #4: the ack lands as a bubble immediately, and acking is not "work started".
    const ack = await bridged.rpc("tools/call", { name: "ack__ack", arguments: { text: "on it" } });
    assert.deepEqual(emitted, ["on it"], "ack text must reach the owner through emit, not sit in a tool result");
    assert.equal(workStarted, 0, "the ack must not trip work-start");
    assert.match(ack.content[0].text, /opener delivered/);

    // A tool that CANNOT work out of process: the job registry only exists in this process.
    const jobs = await bridged.rpc("tools/call", { name: "jobs__list", arguments: {} });
    assert.equal(jobs.isError, false, `jobs__list should have executed in-process: ${jobs.content?.[0]?.text}`);
    assert.equal(workStarted, 1, "first non-ack call starts work");
    await bridged.rpc("tools/call", { name: "jobs__check", arguments: { id: "nope" } });
    assert.equal(workStarted, 1, "work-start fires exactly once per run");

    // gap #5: distinct top-level names, first-call order, fully qualified for requiredTools.ts.
    assert.deepEqual(bridge.toolsUsed(), ["mcp__ack__ack", "mcp__jobs__list", "mcp__jobs__check"]);
    assert.deepEqual(asked, [], "none of those tools is gated, so the owner must not have been pestered");

    const unknown = await bridged.rpc("tools/call", { name: "nope__nope", arguments: {} });
    assert.match(unknown.content[0].text, /Unknown tool/);
    assert.equal(unknown.isError, true);

    // A bad token can't reach this run's context, even from a process that found the socket.
    const badToken = await rawBridgeCall(bridge.socketPath, { id: 99, token: "wrong-token", method: "tools/list" });
    assert.equal(badToken.ok, false);
    assert.match(badToken.error, /bad bridge token/);
  } finally {
    bridged.stop();
    bridge.close();
  }

  // A wrong-lane call is answered differently from an unknown name — the same distinction
  // scheduling/lane.ts draws between "not wired into this lane" and "doesn't exist".
  const unattendedBridge = await startToolBridge({ lane: "unattended", askOwner: async () => false });
  assert.ok(unattendedBridge);
  try {
    const res = await rawBridgeCall(unattendedBridge.socketPath, {
      id: 1,
      token: unattendedBridge.token,
      method: "tools/call",
      name: "ack__ack",
      arguments: { text: "hi" },
    });
    assert.equal(res.ok, true);
    assert.equal(res.call.isError, true);
    assert.match(res.call.text, /not published to this lane \(unattended\)/);
  } finally {
    unattendedBridge.close();
  }

  // ── back-compat: no bridge endpoint → today's in-child surface, byte for byte ───────────────
  const plain = startFigToolsChild([]);
  try {
    const init = await plain.rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.match(init.instructions, /fallback runtimes/, "unbridged initialize must serve the fallback instructions");
    const listed = await plain.rpc("tools/list");
    assert.deepEqual(
      listed.tools,
      fallbackToolList(),
      "a delegated codex run with no bridge must list EXACTLY the fallback:allow set",
    );
    const names = (listed.tools as { name: string }[]).map((t) => t.name);
    assert.ok(!names.includes("jobs__list"), "the unbridged surface must not gain main-process tools");
  } finally {
    plain.stop();
  }

  console.log("codex tool bridge tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
