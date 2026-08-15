import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { deliverAck } from "../ack/deliver";
import { ACK_TOOL_NAME } from "../ack/tools";
import { config } from "../core/config";
import { log, warn } from "../core/log";
import type { Approver } from "../specialists/approval";
import { inLane, type Lane } from "../scheduling/lane";
import { capabilitySchema } from "../tools/define";
import { allCapabilities, type RegisteredCapability } from "../tools/registry";
import { makeCanUseTool } from "./permissions";
import { summarizeToolUse } from "./progress";
import {
  lineFramer,
  type BridgeCallResult,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeToolInfo,
} from "./toolBridgeWire";

/**
 * The Codex tool bridge: fig's REAL tool surface, for a runtime that lives in another process.
 *
 * The problem it exists for. `/model codex` makes Codex fig's main brain, but codex runs as a
 * child process (`codex exec`), so it cannot mount fig's tools — those are in-process SDK MCP
 * servers, only mountable by the Agent SDK inside THIS process. What codex got instead was one
 * stdio server that executed a ~16-tool `fallback: "allow"` subset IN ITS OWN spawned process,
 * which structurally couldn't do the things that need main-process state (the job registry is
 * the obvious one) and had nowhere to send a 🔐 approval, no way to deliver an ack, and no way
 * to report which tools a run actually called.
 *
 * So the stdio server stops executing and becomes a proxy: it forwards `tools/list` and
 * `tools/call` over a unix socket to this module, which runs the capability HERE, with the live
 * turn's `askOwner`, the live `emit`, the real job registry — and sees every call, which is what
 * makes `toolsUsed` (scheduling/requiredTools.ts) and work-start reporting possible at all.
 *
 * WHY ONE LISTENER PER RUN, rather than one process-wide server with a token→context map: a
 * live turn and a scheduled pass can be in flight at the same time, and a module-level singleton
 * holding "the current run's askOwner" is the exact shape that made overlapping queries mount
 * each other's MCP instances for six weeks (runtimes/mcpInstances.ts). A run owns its socket,
 * its token and its context, and closes all three when it ends, so cross-talk isn't guarded
 * against — it's unrepresentable. The token is still checked per request, so a leaked/stale
 * child can't call into a run that isn't its own.
 *
 * Failure is always a DEGRADE, never a thrown turn: if the socket can't be created the caller
 * gets null and codex runs with today's reduced in-child surface. A parity gap is survivable.
 */

/** What only a LIVE turn can provide: the owner on the other end of an approval, and a bubble channel. */
export interface ToolBridgeLiveHooks {
  /** `Approver`, so a 🔐 raised on the codex lane keeps any system-built preview attached. */
  askOwner: Approver;
  /** Delivers the ack opener immediately, same as the Claude lane's session loop does. */
  emit: (text: string) => Promise<void>;
  /** Reacts on the owner's latest message — the ack tool's `tapback` field. */
  tapback?: (emoji: string) => Promise<boolean>;
  onWorkStarted?: () => void;
}

export interface ToolBridgeContext extends Partial<ToolBridgeLiveHooks> {
  /** Which lane's surface to publish — the same question `scheduling/lane.ts` answers for Claude. */
  lane: Lane;
  askOwner: Approver;
  /** Job-board progress sink (`report`/`onProgress`), fired per bridged call. */
  report?: (action: string) => void;
  /** The run's abort signal, handed to the permission callback. */
  signal?: AbortSignal;
}

export interface ToolBridgeHandle {
  socketPath: string;
  token: string;
  /** Distinct fully-qualified (`mcp__server__tool`) names this run called, in first-call order. */
  toolsUsed(): string[];
  close(): void;
}

/**
 * The bridged surface, derived from the SAME thing the Claude lanes derive from: a server's own
 * `exposure` decides lane membership (scheduling/lane.ts → `inLane`), and the registry supplies
 * names and schemas. No second tool list exists here to drift.
 *
 * Two honest gaps, both structural rather than chosen: file-mcp servers (browser, gmail,
 * agent-cards, peekaboo) contribute nothing because `defineServer` forbids external servers from
 * declaring capabilities — their tools live in yet another process and aren't enumerable from
 * this one — and codex is limited to exactly ONE `mcp_servers` block, so we can't hand it their
 * configs either. And built-in tool denial (FIG_DISALLOWED_TOOLS) doesn't apply: codex brings
 * its own shell/edit tools, governed by its sandbox, not by our lane denylist.
 */
export function bridgeCapabilities(lane: Lane): RegisteredCapability[] {
  return allCapabilities().filter((c) => inLane(c.server.exposure, lane));
}

export function bridgeToolList(lane: Lane): BridgeToolInfo[] {
  return bridgeCapabilities(lane).map(({ capability, fallbackName }) => ({
    name: fallbackName,
    description: capability.notes ? `${capability.description}\nPolicy: ${capability.notes}` : capability.description,
    inputSchema: capabilitySchema(capability),
  }));
}

export function bridgeCapabilityByName(name: string, lane: Lane): RegisteredCapability | undefined {
  return bridgeCapabilities(lane).find((c) => c.fallbackName === name);
}

/** The `initialize` instructions the proxied server serves. Names the folding rule, once. */
export function bridgeInstructions(lane: Lane): string {
  return [
    "fig's own tools, executed in fig's main process.",
    `This server publishes every tool fig's ${lane} lane carries, with \`mcp__<server>__<tool>\` folded to \`<server>__<tool>\` (one flat server, so the server key has to live in the name).`,
    "Calls run with fig's real state and permissions: an action that needs the owner's approval will block here until they answer, and a declined one comes back as an error you should respect rather than retry another way.",
  ].join(" ");
}

/** Per-run mutable state. Lives in the closure of ONE bridge, never at module level. */
interface BridgeRunState {
  toolsUsed: string[];
  workStarted: boolean;
  canUseTool: ReturnType<typeof makeCanUseTool>;
}

const NEVER_ABORTS = new AbortController().signal;

/**
 * Execute one bridged tool call in-process: record it, gate it, run it.
 *
 * The permission decision reuses `makeCanUseTool` verbatim — the same callback the Claude lane
 * passes to the SDK — because a second copy of "which actions need a 🔐" is how the two lanes
 * would drift into disagreeing about what's dangerous. One callback per RUN, not per call: it
 * carries per-turn state (the browser's current domain) that a fresh callback would lose.
 */
async function callBridged(
  req: BridgeRequest,
  ctx: ToolBridgeContext,
  state: BridgeRunState,
): Promise<BridgeCallResult> {
  const name = String(req.name ?? "");
  const args = (req.arguments ?? {}) as Record<string, unknown>;
  const found = bridgeCapabilityByName(name, ctx.lane);
  if (!found) {
    // Kept distinct on purpose: a name that exists but isn't in THIS lane is a wiring answer
    // ("that tool is live-only and this is a 3am pass"), not a typo, and the model should be
    // told which one it hit instead of guessing at spellings.
    const elsewhere = allCapabilities().some((c) => c.fallbackName === name);
    return {
      text: elsewhere
        ? `Tool ${name} exists but is not published to this lane (${ctx.lane}).`
        : `Unknown tool: ${name}`,
      isError: true,
    };
  }

  if (!state.toolsUsed.includes(found.name)) state.toolsUsed.push(found.name);
  // Work-start semantics copied from the Claude lane (session.ts): fires ONCE per run, on the
  // first non-ack tool call, so a message arriving from here on queues behind the turn instead
  // of aborting completed work. The ack is excluded because acking isn't work.
  if (found.name !== ACK_TOOL_NAME && !state.workStarted) {
    state.workStarted = true;
    try {
      ctx.onWorkStarted?.();
    } catch (e) {
      warn(`codex tool bridge onWorkStarted threw: ${e}`);
    }
  }
  if (ctx.report) {
    try {
      ctx.report(summarizeToolUse(found.name, args));
    } catch {
      /* progress reporting is best-effort, never worth failing a tool call over */
    }
  }

  // `toolUseID` is required by the SDK's CanUseTool signature and only ever echoed back in a
  // PermissionResult, which nothing on this path reads — codex owns its own call ids, so a
  // synthetic one keeps the shared decision logic reusable without inventing a fake SDK id space.
  const decision = await state.canUseTool(found.name, args, {
    signal: ctx.signal ?? NEVER_ABORTS,
    toolUseID: `codex-bridge-${state.toolsUsed.length}-${found.fallbackName}`,
  });
  if (decision.behavior === "deny") return { text: decision.message, isError: true };
  const input = decision.updatedInput ?? args;

  // The ack is a delivery mechanism, not a computation: on the Claude lane the session loop
  // lifts `text` out of the streaming tool_use block and emits it, and the handler only returns
  // the "now work silently" instruction. Same split here — otherwise a codex turn's opener sits
  // invisible in a tool result and the owner stares at silence.
  if (found.name === ACK_TOOL_NAME && ctx.emit) {
    const emit = ctx.emit;
    try {
      // Same two-field contract as the Claude lanes: react first, then speak.
      await deliverAck(input, { emit, tapback: ctx.tapback });
    } catch (e) {
      warn(`codex tool bridge ack emit failed: ${e}`);
    }
  }

  const text = await found.capability.handler(input as Record<string, any>);
  return { text, isError: false };
}

async function serve(req: BridgeRequest, ctx: ToolBridgeContext, state: BridgeRunState): Promise<BridgeResponse> {
  try {
    switch (req.method) {
      case "instructions":
        return { id: req.id, ok: true, instructions: bridgeInstructions(ctx.lane) };
      case "tools/list":
        return { id: req.id, ok: true, tools: bridgeToolList(ctx.lane) };
      case "tools/call":
        return { id: req.id, ok: true, call: await callBridged(req, ctx, state) };
      default:
        return { id: req.id, ok: false, error: `Unknown bridge method: ${String(req.method)}` };
    }
  } catch (e) {
    // A handler that throws is a tool failure, not a transport failure: report it as an error
    // RESULT so codex sees the message and can react, rather than as a dead socket.
    warn(`codex tool bridge ${req.method} failed: ${e}`);
    return { id: req.id, ok: true, call: { text: e instanceof Error ? e.message : String(e), isError: true } };
  }
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * Stand up a bridge for ONE codex run. Returns null (and warns) if it can't — the caller then
 * runs codex with the reduced in-child surface, which is degraded but works.
 */
export async function startToolBridge(ctx: ToolBridgeContext): Promise<ToolBridgeHandle | null> {
  const token = crypto.randomBytes(16).toString("hex");
  // Short filename on purpose: a unix socket path is capped around 104 bytes on macOS, and
  // stateDir already spends most of that. Long names here fail at listen() with ENAMETOOLONG,
  // which would silently cost the whole tool surface.
  const socketPath = path.join(config.stateDir, `cbr-${process.pid}-${crypto.randomBytes(3).toString("hex")}.sock`);
  const state: BridgeRunState = { toolsUsed: [], workStarted: false, canUseTool: makeCanUseTool(ctx.askOwner) };
  const sockets = new Set<net.Socket>();
  let closed = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const reply = (res: BridgeResponse) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
    };
    socket.on(
      "data",
      lineFramer((line) => {
        let req: BridgeRequest;
        try {
          req = JSON.parse(line) as BridgeRequest;
        } catch (e) {
          warn(`codex tool bridge parse failed: ${e}`);
          return;
        }
        // Token check per REQUEST, not per connection: cheap, and it's the only thing standing
        // between this run's askOwner and any other process on the box that finds the socket.
        if (typeof req.token !== "string" || req.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(req.token), Buffer.from(token))) {
          warn("codex tool bridge rejected a request with a bad token");
          reply({ id: req.id ?? 0, ok: false, error: "bad bridge token" });
          socket.destroy();
          return;
        }
        void serve(req, ctx, state).then(reply);
      }),
    );
  });

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    await listen(server, socketPath);
  } catch (e) {
    warn(`codex tool bridge could not listen (${e}) — codex falls back to the reduced in-child tool surface`);
    try {
      server.close();
    } catch {
      /* never listened */
    }
    return null;
  }
  // A leaked bridge must never be the reason the process can't exit; close() below is the
  // normal path, this is the backstop.
  server.unref();
  log(`codex tool bridge up (${ctx.lane} lane, ${bridgeCapabilities(ctx.lane).length} tools)`);

  return {
    socketPath,
    token,
    toolsUsed: () => [...state.toolsUsed],
    close: () => {
      if (closed) return;
      closed = true;
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}
