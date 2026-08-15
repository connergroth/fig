import { normalizeNumber } from "../core/config";
import { log, warn } from "../core/log";
import type { InboundMessage, Reaction, SendOptions, Transport } from "./types";

/**
 * Fan-out transport — runs several channels at once behind the one Transport the
 * rest of the app talks to. Built for "imessage + telegram, both live": you can
 * reach fig from either, and it stays reachable if one channel stalls.
 *
 * Routing rules:
 *  - REPLIES land on the channel you last texted from. poll() tags every inbound
 *    with its origin channel and remembers it per-peer; a send() to that peer
 *    within STICKY_MS goes back out the same way.
 *  - PROACTIVE / idle sends (briefing, email pings, research, reminders) have no
 *    recent inbound to anchor to, so they fall back to the PRIMARY channel
 *    (children[0]) — iMessage. Telegram is the backup, not a second home base.
 *  - TAPBACKS route to the exact channel the reacted-to message came in on (the
 *    message id is channel-specific), falling back to the peer's last channel.
 *  - If a send throws on its chosen channel (e.g. imsg down), it retries
 *    on another channel so a reply still lands — that's the whole point of a backup.
 *
 * Configured by a comma list: TRANSPORT=imsg,telegram. First = primary.
 */

interface Child {
  kind: string;
  t: Transport;
}

const STICKY_MS = 10 * 60 * 1000; // an active convo holds its channel; after this, sends default back to primary

export function makeFanoutTransport(children: Child[]): Transport {
  if (!children.length) throw new Error("fanout transport needs at least one child");
  const PRIMARY = 0;
  const norm = normalizeNumber;

  // which child each inbound id came from — so a tapback/typing routes to that exact channel
  const channelByMsgId = new Map<string, number>();
  // most-recent inbound channel per peer — so replies land where they last texted
  const lastInbound = new Map<string, { idx: number; at: number }>();

  log(`fanout transport — primary=${children[PRIMARY].kind}, channels=[${children.map((c) => c.kind).join(", ")}]`);

  /** Where should an outbound to `to` go? Recent inbound channel, else primary. */
  function routeFor(to: string): number {
    const rec = lastInbound.get(norm(to));
    if (rec && Date.now() - rec.at < STICKY_MS) return rec.idx;
    return PRIMARY;
  }

  return {
    async poll(): Promise<InboundMessage[]> {
      const batches = await Promise.all(
        children.map(async (c, i) => {
          try {
            const msgs = await c.t.poll();
            for (const m of msgs) {
              channelByMsgId.set(m.id, i);
              lastInbound.set(norm(m.from), { idx: i, at: Date.now() });
            }
            return msgs;
          } catch (e: any) {
            warn(`fanout: poll ${c.kind} failed: ${e?.message}`);
            return [] as InboundMessage[];
          }
        }),
      );
      // keep the id->channel map from growing without bound
      if (channelByMsgId.size > 5000) {
        const stale = [...channelByMsgId.keys()].slice(0, channelByMsgId.size - 4000);
        for (const k of stale) channelByMsgId.delete(k);
      }
      return batches.flat();
    },

    async send(to: string, text: string, opts?: SendOptions): Promise<string | null> {
      const idx = routeFor(to);
      try {
        return await children[idx].t.send(to, text, opts);
      } catch (e: any) {
        // chosen channel down — fall back to another so the reply still lands
        const alt = children.findIndex((_, i) => i !== idx);
        if (alt < 0) throw e;
        warn(`fanout: send via ${children[idx].kind} failed (${e?.message}) — falling back to ${children[alt].kind}`);
        return await children[alt].t.send(to, text, opts);
      }
    },

    async typing(to: string): Promise<void> {
      await children[routeFor(to)].t.typing?.(to);
    },

    async stopTyping(to: string): Promise<void> {
      await children[routeFor(to)].t.stopTyping?.(to);
    },

    async react(to: string, messageId: string, reaction: Reaction): Promise<void> {
      const idx = channelByMsgId.get(messageId) ?? routeFor(to);
      await children[idx].t.react?.(to, messageId, reaction);
    },

    async sendPoll(to: string, question: string, options: string[], opts?: SendOptions): Promise<string | null> {
      // Route like send(): the channel they last texted from, else primary. If that channel
      // has no native poll (or throws), fall back to another child so it still lands — the
      // deliver layer's own text fallback only triggers if NO child implements sendPoll.
      // Propagate the poll bubble's guid (as send() does) so the /bg lane can register it.
      const idx = routeFor(to);
      if (children[idx].t.sendPoll) {
        try {
          return await children[idx].t.sendPoll!(to, question, options, opts);
        } catch (e: any) {
          warn(`fanout: sendPoll via ${children[idx].kind} failed (${e?.message}) — trying another channel`);
        }
      }
      const alt = children.find((c, i) => i !== idx && c.t.sendPoll);
      if (!alt) throw new Error("no channel supports native polls");
      return await alt.t.sendPoll!(to, question, options, opts);
    },
  };
}
