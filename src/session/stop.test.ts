import assert from "node:assert/strict";

import type { Transport } from "../transport/types";
import { Conversation } from "./session";

async function main(): Promise<void> {
  const sends: string[] = [];
  const transport = {
    send: async (_to: string, text: string) => {
      sends.push(text);
      return "guid-stop-test";
    },
  } as Transport;

  const convo = new Conversation(transport, "+15555550123");
  const state = convo as any;

  state.buffer = [{ text: "keep investigating the old bug", media: [] }];
  state.processing = true;
  state.currentAbort = new AbortController();
  state.killAll();

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(state.buffer, [], "stop must clear buffered work so the next message starts clean");
  assert.equal(state.currentAbort.signal.aborted, true, "stop must abort the active turn");
  assert.equal(state.stopKilled, true, "the flush unwind must know not to re-run the killed exchange");
  assert.deepEqual(sends, ["stopped ✋"]);

  console.log("✓ stop kill-switch tests passed");
}

void main();
