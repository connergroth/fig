import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Transcript logging writes into the vault, so point the whole run at a temp one
// BEFORE anything imports config. (Same trick the other config-touching tests use.)
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-tapback-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type Reaction = import("../transport/types").Reaction;
type Transport = import("../transport/types").Transport;

type DeliverTapback = typeof import("./deliver").deliverTapback;

function fakeTransport(opts: { react?: boolean; throws?: boolean } = {}): {
  transport: Transport;
  calls: { to: string; messageId: string; reaction: Reaction }[];
} {
  const calls: { to: string; messageId: string; reaction: Reaction }[] = [];
  const transport = {
    poll: async () => [],
    send: async () => null,
    ...(opts.react === false
      ? {}
      : {
          react: async (to: string, messageId: string, reaction: Reaction): Promise<void> => {
            if (opts.throws) throw new Error("imsg tapback failed: Unknown reactionType: emoji");
            calls.push({ to, messageId, reaction });
          },
        }),
  } as Transport;
  return { transport, calls };
}

/**
 * A mapped emoji goes out as one of the six CLASSIC tapbacks, not as a custom
 * 2006 reaction — classics render on every receiver, custom emoji need iOS 18+.
 */
async function mappedEmojiSendsAClassicReaction(): Promise<void> {
  for (const [emoji, kind] of [
    ["👍", "like"],
    ["❤️", "love"],
    ["😂", "laugh"],
    ["👎", "dislike"],
    ["‼️", "emphasize"],
    ["❓", "question"],
    ["🔥", "love"], // fig's wider synonym set still folds onto the six
  ] as const) {
    const { transport, calls } = fakeTransport();
    const ok = await deliverTapback({ transport, to: "+1", messageId: "guid-1", emoji });
    assert.equal(ok, true);
    assert.deepEqual(calls[0]?.reaction, kind, `${emoji} should send as ${kind}`);
  }
}

/** Anything else rides the arbitrary-emoji path as a structured `{ emoji }`. */
async function arbitraryEmojiSendsTheCustomReaction(): Promise<void> {
  for (const emoji of ["💀", "🎉", "🫡", "🥲"]) {
    const { transport, calls } = fakeTransport();
    const ok = await deliverTapback({ transport, to: "+1", messageId: "guid-1", emoji });
    assert.equal(ok, true);
    assert.deepEqual(calls[0]?.reaction, { emoji }, `${emoji} should send as a custom reaction`);
  }
}

/** No message to react to → false, so the caller falls back to a bubble. */
async function missingTargetReportsFailure(): Promise<void> {
  const { transport, calls } = fakeTransport();
  assert.equal(await deliverTapback({ transport, to: "+1", messageId: undefined, emoji: "💀" }), false);
  assert.deepEqual(calls, []);
}

/** A channel with no reaction support → false, never a throw. */
async function transportWithoutReactReportsFailure(): Promise<void> {
  const { transport } = fakeTransport({ react: false });
  assert.equal(await deliverTapback({ transport, to: "+1", messageId: "guid-1", emoji: "👍" }), false);
}

/** A bridge that rejects the emoji (older imsg without --emoji) → false, not a crash. */
async function bridgeRejectionReportsFailure(): Promise<void> {
  const { transport } = fakeTransport({ throws: true });
  assert.equal(await deliverTapback({ transport, to: "+1", messageId: "guid-1", emoji: "💀" }), false);
}

let deliverTapback: DeliverTapback;

async function main(): Promise<void> {
  ({ deliverTapback } = await import("./deliver"));
  try {
    await mappedEmojiSendsAClassicReaction();
    await arbitraryEmojiSendsTheCustomReaction();
    await missingTargetReportsFailure();
    await transportWithoutReactReportsFailure();
    await bridgeRejectionReportsFailure();
    console.log("render/tapback.test.ts: 5 passed");
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
