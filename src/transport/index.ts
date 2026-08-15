import { config } from "../core/config";
import { isSilence } from "../render/chunking";
import { warn } from "../core/log";
import { makeFanoutTransport } from "./fanout";
import { makeImsgTransport } from "./imsg";
import { makeTelegramTransport } from "./telegram";
import type { Transport } from "./types";

/** Build a single channel by kind name. */
function buildOne(kind: string): Transport {
  switch (kind) {
    case "telegram":
      return makeTelegramTransport();
    case "imsg":
      return makeImsgTransport();
    default:
      throw new Error(`Unknown TRANSPORT "${kind}". Supported: imsg, telegram.`);
  }
}

/**
 * Last-line backstop, wrapped around EVERY outbound send regardless of channel or call
 * site. Every caller upstream (the live turn, the scheduler/watch/goal/reconcile passes,
 * research, proactive email/calendar) is supposed to catch the quiet sentinel (`NOTHING`,
 * bare or wrapped in `<output>` tags — see isQuietOutput in render/chunking.ts) or the
 * live-session `[no reply]` token before ever calling send(). One of them missed a wrapped
 * `<output>NOTHING</output>` once already and it reached the owner's phone as a literal
 * "NOTHING" bubble with nothing left downstream to catch it (the 22:56 leak). This is that
 * downstream catch: it structurally cannot reach the transport even if a future call site
 * forgets its own check. Only blocks a body that IS the sentinel in its entirety — never
 * touches real prose, so it can't accidentally eat a legitimate message.
 */
function guardSentinel(t: Transport): Transport {
  return {
    ...t,
    async send(to, text, opts): Promise<string | null> {
      const trimmed = (text ?? "").trim();
      if (trimmed && isSilence(trimmed)) {
        warn(`transport.send blocked — body was the quiet sentinel verbatim: "${trimmed.slice(0, 40)}"`);
        return null;
      }
      return t.send(to, text, opts);
    },
  };
}

/**
 * TRANSPORT is one kind ("imsg") or a comma list to run several at once
 * ("imsg,telegram"). With a list, the first is the PRIMARY (where proactive
 * messages go) and the rest are backup channels — see transport/fanout.ts.
 */
export function makeTransport(): Transport {
  const kinds = config.transport.kind
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const built =
    kinds.length <= 1
      ? buildOne(kinds[0] ?? "imsg")
      : makeFanoutTransport(kinds.map((kind) => ({ kind, t: buildOne(kind) })));
  return guardSentinel(built);
}

export type { Transport, InboundMessage, Reaction } from "./types";
