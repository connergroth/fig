import net from "node:net";

import {
  fallbackAllows,
  fallbackCapabilityByName,
  fallbackInstructions,
  fallbackToolList,
} from "../tools/fallback";
import { warn } from "../core/log";
import {
  lineFramer,
  readBridgeArgs,
  type BridgeMethod,
  type BridgeResponse,
  type BridgeToolInfo,
} from "./toolBridgeWire";

/**
 * The raw JSON-RPC stdio MCP server Codex spawns as `fig_tools`.
 *
 * TWO MODES, and the difference is which process runs the handler.
 *
 *  - NO bridge endpoint in argv (delegated codex jobs, the review lane): unchanged behaviour —
 *    it serves the `fallback: "allow"` subset derived from `src/tools/registry.ts` and executes
 *    those handlers HERE, in this spawned process. A delegated job has no live turn to route a
 *    🔐 to, so this is the correct surface for it, not a degradation.
 *  - WITH `--bridge-socket`/`--bridge-token` (main-role runs, i.e. `/model codex`): pure PROXY.
 *    Every list/call is forwarded over a unix socket to the running bot process, which executes
 *    the capability in-process with fig's real state, the live turn's approvals, and the ack
 *    channel. See runtimes/toolBridge.ts.
 *
 * Either way it publishes nothing of its own: names, descriptions and schemas are all derived
 * from the registry. It used to read a parallel `figTools` array that was the only home for
 * `policy.fallback` and served hand-written JSON Schema verbatim — two authored schemas for one
 * input, with nothing comparing them.
 */

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id: JsonRpcId | undefined, value: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── bridge client ──────────────────────────────────────────────────────────────────────────
const bridge = readBridgeArgs(process.argv.slice(2));
let connection: Promise<net.Socket> | null = null;
/** Once the socket is gone it stays gone for this run — retrying a dead endpoint per call is noise. */
let bridgeDown = !bridge;
let nextId = 1;
const pending = new Map<number, (res: BridgeResponse) => void>();

function loseBridge(why: string): void {
  if (!bridgeDown) warn(`fig-tools bridge unavailable (${why}) — serving the reduced in-child surface`);
  bridgeDown = true;
  connection = null;
  // In-flight calls do NOT get re-run locally: the handler may already have sent an email or
  // spent money on the other side, and a silent double-execution is worse than a failed call.
  for (const [id, resolve] of pending) resolve({ id, ok: false, error: `bridge connection lost (${why})` });
  pending.clear();
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("connect", () => resolve(socket));
    socket.once("error", (e) => {
      loseBridge(e.message);
      reject(e);
    });
    socket.on("close", () => loseBridge("closed"));
    socket.on(
      "data",
      lineFramer((line) => {
        let res: BridgeResponse;
        try {
          res = JSON.parse(line) as BridgeResponse;
        } catch (e) {
          warn(`fig-tools bridge parse failed: ${e}`);
          return;
        }
        const resolve = pending.get(res.id);
        if (!resolve) return;
        pending.delete(res.id);
        resolve(res);
      }),
    );
  });
}

/**
 * One bridge round-trip. `null` means "no bridge, decide locally"; a response with `ok: false`
 * means the bridge was there and answered no, which is NOT the same thing and must not be
 * retried in-child.
 *
 * Deliberately no timeout here: a bridged call can legitimately park for minutes waiting on a
 * 🔐 on the owner's phone. The cap belongs to codex's own `tool_timeout_sec`, which the main-role
 * config raises for exactly this reason.
 */
async function bridgeRequest(
  method: BridgeMethod,
  name?: string,
  args?: Record<string, unknown>,
): Promise<BridgeResponse | null> {
  if (!bridge || bridgeDown) return null;
  let socket: net.Socket;
  try {
    socket = await (connection ??= connect(bridge.socketPath));
  } catch {
    return null; // loseBridge already warned
  }
  const id = nextId++;
  return new Promise<BridgeResponse>((resolve) => {
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ id, token: bridge.token, method, name, arguments: args })}\n`);
  });
}

async function bridgedToolList(): Promise<BridgeToolInfo[] | null> {
  const res = await bridgeRequest("tools/list");
  return res && res.ok && res.tools ? res.tools : null;
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method } = msg;
  try {
    switch (method) {
      case "initialize": {
        const res = await bridgeRequest("instructions");
        return result(id, {
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fig-tools", version: "1.0.0" },
          instructions: (res && res.ok && res.instructions) || fallbackInstructions(),
        });
      }
      case "notifications/initialized":
        return;
      case "tools/list":
        return result(id, { tools: (await bridgedToolList()) ?? fallbackToolList() });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const bridged = await bridgeRequest("tools/call", name, args);
        if (bridged) {
          const payload = bridged.ok
            ? (bridged.call ?? { text: "bridge returned no result", isError: true })
            : { text: bridged.error, isError: true };
          return result(id, { content: [{ type: "text", text: payload.text }], isError: payload.isError });
        }
        const found = fallbackCapabilityByName(name);
        if (!found) {
          // Two distinct failures, kept distinct: a name the registry doesn't publish at all,
          // versus one it publishes but denies to fallback runtimes.
          return error(
            id,
            -32602,
            fallbackAllows(name) ? `Unknown tool: ${name}` : `Tool is not available to fallback runtimes: ${name}`,
          );
        }
        const text = await found.capability.handler(args);
        return result(id, {
          content: [{ type: "text", text }],
          isError: false,
        });
      }
      case "ping":
        return result(id, {});
      default:
        return error(id, -32601, `Method not found: ${method ?? "(missing)"}`);
    }
  } catch (e) {
    warn(`fig-tools MCP ${method ?? "(missing)"} failed: ${e}`);
    return result(id, {
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    });
  }
}

const readStdin = lineFramer((line) => {
  try {
    void handle(JSON.parse(line));
  } catch (e) {
    warn(`fig-tools MCP parse failed: ${e}`);
  }
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => readStdin(String(chunk)));

process.stdin.on("end", () => process.exit(0));
