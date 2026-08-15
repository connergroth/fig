import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { config } from "../../core/config";
import { log, warn } from "../../core/log";
import { lineFramer, type CallBridgeRequest, type CallBridgeResponse } from "./wire";

/**
 * The call brain bridge, SERVER half: a per-SESSION unix socket the session child
 * calls into to reach the running bot. Same mechanics as the codex tool bridge
 * (`runtimes/toolBridge.ts` — one listener per run, per-request token check,
 * newline-JSON framing, close() owns cleanup), opposite direction: instead of
 * publishing fig's tools to another runtime, it answers a voice session's four
 * needs — context, a real fig turn, hangup, transcript.
 *
 * One listener per CALL for the same reason toolBridge is one per run: the socket, the
 * token, and the handlers live and die with exactly one session, so a stale child (or
 * anything else on the box that finds the path) can't call into a call that isn't its own.
 */

export interface CallBridgeHandlers {
  context: () => string;
  ask: (question: string) => Promise<string>;
  /**
   * Streamed fig turn for `ask_stream`: text deltas fan out to the caller as they
   * generate, the resolved value is the full reply. Optional — when absent,
   * `ask_stream` degrades to a plain `ask` answered in one done-frame, so an old
   * lane and a new child (or vice versa) still talk.
   *
   * `signal` aborts when the child drops the request socket, which is how it says "this
   * turn is superseded, stop". A turn that keeps running after that still EXECUTES ITS
   * TOOL CALLS — that's how a discarded reply hung up a live call — so the signal
   * has to reach the real turn, not just its output.
   *
   * `spoken` says the question is verbatim what the owner said, so this turn — and only
   * this turn — records it in the conversation transcript (see wire.ts).
   *
   * `interrupted` is set when they talked over the previous reply; its value is what they had
   * heard of it. Prompt-only, this turn only.
   */
  askStream?: (
    question: string,
    onDelta: (delta: string) => void,
    signal: AbortSignal,
    spoken: boolean,
    interrupted?: string,
  ) => Promise<string>;
  hangup: () => Promise<void>;
  note: (speaker: "owner" | "fig", text: string) => void;
  ended: (reason: string) => void;
}

export interface CallBridgeHandle {
  socketPath: string;
  token: string;
  close(): void;
}

async function serve(
  req: CallBridgeRequest,
  handlers: CallBridgeHandlers,
  sendFrame: (res: CallBridgeResponse) => void,
  gone: AbortSignal,
): Promise<CallBridgeResponse> {
  try {
    switch (req.method) {
      case "context":
        return { id: req.id, ok: true, text: handlers.context() };
      case "ask":
        return { id: req.id, ok: true, text: await handlers.ask(String(req.question ?? "")) };
      case "ask_stream": {
        const question = String(req.question ?? "");
        if (!handlers.askStream) {
          // Degrade to the collect-all turn; the single done-frame is still a valid stream.
          return { id: req.id, ok: true, done: true, text: await handlers.ask(question) };
        }
        const text = await handlers.askStream(
          question,
          (delta) => {
            if (delta) sendFrame({ id: req.id, ok: true, delta });
          },
          gone,
          req.spoken === true,
          typeof req.interrupted === "string" ? req.interrupted : undefined,
        );
        return { id: req.id, ok: true, done: true, text };
      }
      case "hangup":
        await handlers.hangup();
        return { id: req.id, ok: true };
      case "note":
        handlers.note(req.speaker === "fig" ? "fig" : "owner", String(req.text ?? ""));
        return { id: req.id, ok: true };
      case "ended":
        handlers.ended(String(req.reason ?? "unknown"));
        return { id: req.id, ok: true };
      default:
        return { id: req.id, ok: false, error: `Unknown bridge method: ${String(req.method)}` };
    }
  } catch (e) {
    warn(`call bridge ${req.method} failed: ${e}`);
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
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

export async function startCallBrainBridge(handlers: CallBridgeHandlers): Promise<CallBridgeHandle | null> {
  const token = crypto.randomBytes(16).toString("hex");
  // Short name on purpose — unix socket paths cap ~104 bytes on macOS (see toolBridge.ts).
  const socketPath = path.join(config.stateDir, `call-${process.pid}-${crypto.randomBytes(3).toString("hex")}.sock`);
  const sockets = new Set<net.Socket>();
  let closed = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    // One connection per request (the children dial fresh each time), so this socket
    // dying IS "abandon that request" — the child drops it the moment it supersedes a turn.
    const gone = new AbortController();
    socket.on("close", () => {
      sockets.delete(socket);
      gone.abort();
    });
    socket.on("error", () => socket.destroy());
    const reply = (res: CallBridgeResponse): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
    };
    socket.on(
      "data",
      lineFramer((line) => {
        let req: CallBridgeRequest;
        try {
          req = JSON.parse(line) as CallBridgeRequest;
        } catch (e) {
          warn(`call bridge parse failed: ${e}`);
          return;
        }
        if (
          typeof req.token !== "string" ||
          req.token.length !== token.length ||
          !crypto.timingSafeEqual(Buffer.from(req.token), Buffer.from(token))
        ) {
          warn("call bridge rejected a request with a bad token");
          reply({ id: req.id ?? 0, ok: false, error: "bad bridge token" });
          socket.destroy();
          return;
        }
        void serve(req, handlers, reply, gone.signal).then(reply);
      }),
    );
  });

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    await listen(server, socketPath);
  } catch (e) {
    warn(`call brain bridge could not listen (${e}) — call session can't reach the brain`);
    try {
      server.close();
    } catch {
      /* never listened */
    }
    return null;
  }
  server.unref();
  log(`call brain bridge up (${socketPath})`);

  return {
    socketPath,
    token,
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
