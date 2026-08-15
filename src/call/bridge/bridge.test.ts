import assert from "node:assert/strict";
import net from "node:net";

import { startCallBrainBridge } from "./server";
import { lineFramer, type CallBridgeRequest, type CallBridgeResponse } from "./wire";

/**
 * Round-trips the call brain bridge over a REAL unix socket: context, a (stubbed)
 * ask turn, transcript notes, ended — plus the two security properties inherited
 * from the codex tool bridge shape: a bad token is refused, and close() actually
 * tears the socket down.
 */

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath, () => resolve(s));
    s.on("error", reject);
  });
}

function requester(socket: net.Socket): (req: Omit<CallBridgeRequest, "id"> & { id: number }) => Promise<CallBridgeResponse> {
  const pending = new Map<number, (r: CallBridgeResponse) => void>();
  socket.setEncoding("utf8");
  socket.on(
    "data",
    lineFramer((line) => {
      const res = JSON.parse(line) as CallBridgeResponse;
      pending.get(res.id)?.(res);
      pending.delete(res.id);
    }),
  );
  return (req) =>
    new Promise((resolve) => {
      pending.set(req.id, resolve);
      socket.write(`${JSON.stringify(req)}\n`);
    });
}

async function main(): Promise<void> {
  const notes: string[] = [];
  let endedReason = "";
  let hungUp = false;
  const bridge = await startCallBrainBridge({
    context: () => "CONTEXT BLOCK",
    ask: async (q) => `answered: ${q}`,
    hangup: async () => {
      hungUp = true;
    },
    note: (speaker, text) => notes.push(`${speaker}: ${text}`),
    ended: (reason) => {
      endedReason = reason;
    },
  });
  assert.ok(bridge, "bridge must start");

  const socket = await connect(bridge.socketPath);
  const request = requester(socket);

  const ctx = await request({ id: 1, token: bridge.token, method: "context" });
  assert.deepEqual(ctx, { id: 1, ok: true, text: "CONTEXT BLOCK" });

  const ask = await request({ id: 2, token: bridge.token, method: "ask", question: "what's pending?" });
  assert.deepEqual(ask, { id: 2, ok: true, text: "answered: what's pending?" });

  // ask_stream without an askStream handler degrades to a single done-frame plain ask.
  const askFallback = await request({ id: 20, token: bridge.token, method: "ask_stream", question: "still there?" });
  assert.deepEqual(askFallback, { id: 20, ok: true, done: true, text: "answered: still there?" });

  const note = await request({ id: 3, token: bridge.token, method: "note", speaker: "owner", text: "yo" });
  assert.equal(note.ok, true);
  const note2 = await request({ id: 4, token: bridge.token, method: "note", speaker: "fig", text: "hey" });
  assert.equal(note2.ok, true);
  assert.deepEqual(notes, ["owner: yo", "fig: hey"]);

  const hang = await request({ id: 5, token: bridge.token, method: "hangup" });
  assert.equal(hang.ok, true);
  assert.equal(hungUp, true);

  const end = await request({ id: 6, token: bridge.token, method: "ended", reason: "test over" });
  assert.equal(end.ok, true);
  assert.equal(endedReason, "test over");

  // Bad token: refused AND the socket is destroyed (a stale child can't probe further).
  const evil = await connect(bridge.socketPath);
  const evilReq = requester(evil);
  const denied = await evilReq({ id: 7, token: "0".repeat(32), method: "context" });
  assert.equal(denied.ok, false);
  await new Promise((r) => evil.once("close", r));

  socket.destroy();
  bridge.close();
  await assert.rejects(connect(bridge.socketPath), "closed bridge must not accept connections");

  // --- streaming: a bridge WITH askStream fans deltas out, then a done frame — and the
  // BridgeClient (the child's half) reassembles exactly that. ---
  const { BridgeClient } = await import("./client");
  const bridge2 = await startCallBrainBridge({
    context: () => "",
    ask: async () => "collect-all",
    askStream: async (q, onDelta) => {
      onDelta("first chunk, ");
      await new Promise((r) => setTimeout(r, 10));
      onDelta("second chunk.");
      return `full: ${q}`;
    },
    hangup: async () => undefined,
    note: () => undefined,
    ended: () => undefined,
  });
  assert.ok(bridge2, "streaming bridge must start");
  const client = new BridgeClient(bridge2.socketPath, bridge2.token);
  await client.connect();
  const deltas: string[] = [];
  const streamed = await client.requestStream({ method: "ask_stream", question: "q1" }, (d) => deltas.push(d), 5000);
  assert.deepEqual(deltas, ["first chunk, ", "second chunk."]);
  assert.ok(streamed.ok && streamed.done && streamed.text === "full: q1", `done frame carries the full text: ${JSON.stringify(streamed)}`);
  // plain requests still work over the same client
  const plain = await client.request({ method: "ask", question: "x" }, 5000);
  assert.ok(plain.ok && plain.text === "collect-all");
  client.close();
  bridge2.close();

  // --- `spoken`: the question is verbatim what they said, so the lane writes their transcript
  // line for THIS turn and nothing else does. It's carried on the request, never guessed:
  // the realtime front-end's ask_fig question is composed by its model, not spoken. ---
  const spokenFlags: boolean[] = [];
  const interruptions: (string | undefined)[] = [];
  const bridgeSpoken = await startCallBrainBridge({
    context: () => "",
    ask: async () => "",
    askStream: async (_q, _onDelta, _signal, spoken, interrupted) => {
      spokenFlags.push(spoken);
      interruptions.push(interrupted);
      return "ok";
    },
    hangup: async () => undefined,
    note: () => undefined,
    ended: () => undefined,
  });
  assert.ok(bridgeSpoken, "spoken-flag bridge must start");
  const spokenSocket = await connect(bridgeSpoken.socketPath);
  const spokenReq = requester(spokenSocket);
  await spokenReq({ id: 40, token: bridgeSpoken.token, method: "ask_stream", question: "yo", spoken: true });
  await spokenReq({ id: 41, token: bridgeSpoken.token, method: "ask_stream", question: "model-composed" });
  assert.deepEqual(spokenFlags, [true, false], "the flag rides the request and defaults to off");

  // `interrupted` rides the same request: PRESENT means they talked over the last reply, and
  // the value is what they heard of it. Absent on an ordinary turn; an empty string is still
  // an interruption (they cut in before any clause played).
  await spokenReq({
    id: 42,
    token: bridgeSpoken.token,
    method: "ask_stream",
    question: "that we can make as well.",
    interrupted: "both queued and written down",
  });
  await spokenReq({ id: 43, token: bridgeSpoken.token, method: "ask_stream", question: "yo", interrupted: "" });
  assert.deepEqual(interruptions, [undefined, undefined, "both queued and written down", ""]);
  spokenSocket.destroy();
  bridgeSpoken.close();

  // --- a dropped request socket aborts the turn behind it. This is how the session child
  // says "superseded": it cancels its ask_stream request, and the turn has to actually
  // STOP in the bot — a turn that keeps running still fires its tools, and a discarded reply
  // calling hang_up ends a live call. ---
  let turnSignal: AbortSignal | null = null;
  const bridge3 = await startCallBrainBridge({
    context: () => "",
    ask: async () => "",
    askStream: async (_q, _onDelta, signal) => {
      turnSignal = signal;
      await new Promise((r) => setTimeout(r, 200));
      return "too late";
    },
    hangup: async () => undefined,
    note: () => undefined,
    ended: () => undefined,
  });
  assert.ok(bridge3, "abort bridge must start");
  const abandoning = await connect(bridge3.socketPath);
  abandoning.write(`${JSON.stringify({ id: 30, token: bridge3.token, method: "ask_stream", question: "q" })}\n`);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(turnSignal, "the turn got a signal");
  assert.equal((turnSignal as AbortSignal).aborted, false, "still live while the child is listening");
  abandoning.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((turnSignal as AbortSignal).aborted, true, "dropping the request aborts the turn");
  bridge3.close();

  console.log("✓ call brain bridge tests passed");
}

void main().then(() => process.exit(0));
