/**
 * Shared "paced delivery" helper. The proactive/scheduled/peer senders all do the
 * same inner thing: split a (already-cleaned) string into iMessage bubbles, send each
 * bubble over the Transport, and sleep a human-feeling beat between bubbles. That loop
 * lived copy-pasted across scheduler/proactive/research/news; this is the single copy.
 *
 * Only the inner split→send→delay loop lives here. Everything a call site does AROUND
 * it — markdown stripping, <output> unwrapping, logOutbound, quiet-hours gating, target
 * resolution, session reset — stays at the call site. Per-site differences are threaded
 * through `opts` (static SendOptions, the failure log label). Sites whose per-bubble
 * logic genuinely differs (e.g. spot's per-chunk image/effect branching) keep their own
 * loop rather than distorting this one.
 */

import {
  extractEffect,
  isImageUrl,
  isLocalFilePath,
  lowercaseSentenceStarts,
  naturalChunkDelayMs,
  parsePoll,
  sleep,
  splitIntoChunks,
  stripMarkdown,
  tapbackForEmoji,
} from "./chunking";
import { fileAttachmentOpts } from "../image/sink";
import { rewriteEmailLinks } from "./emailLink";
import { bareRichLinkUrl, rewriteLinkPreviews } from "./linkPreview";
import { formatDraftPreview, getDraft } from "../google/gmail";
import { registerBgReplyGuid } from "../session/bgReplyRegistry";
import { logOutbound } from "../session/transcript";
import { warn } from "../core/log";
import { resolveOwnerTz } from "../location/timezone";
import type { Reaction, SendOptions, Transport } from "../transport/types";

/**
 * Prefix `text` with a compact `[replying to "…"]:` marker when it's an inline reply to an
 * earlier message — the convention the system prompt already documents, so fig knows WHICH
 * message they're responding to. Injected into the model-visible turn only (never the raw
 * transcript). No-op when there's no reply target. Truncates the quoted text to keep the
 * marker short.
 */
export function withReplyContext(text: string, repliedToText?: string | null): string {
  const quote = (repliedToText ?? "").replace(/\s+/g, " ").trim();
  if (!quote) return text;
  return `[replying to "${quote.slice(0, 120)}"]: ${text}`;
}

/**
 * Prefix `text` with a `[sent HH:MM, while the previous turn was still running…]` marker when
 * the message was QUEUED mid-turn — i.e. the owner sent it before the previous turn's reply had
 * landed, so they were not responding to that reply. Without the marker a queued message reads as
 * a fresh follow-up and the agent answers something it already covered (or reads a question as
 * a challenge to the answer it just gave). Model-visible only, never the raw transcript.
 * No-op when `queuedAt` is undefined (the normal, non-queued path).
 */
export function withQueuedContext(text: string, queuedAt?: number): string {
  if (!queuedAt) return text;
  const at = new Date(queuedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: resolveOwnerTz(),
  });
  return `[sent ${at}, while you were still working on the previous turn — they had NOT seen your reply yet, so this is not a response to it]: ${text}`;
}

/**
 * Fire a `[[poll:…]]` chunk. Prefers the transport's native poll (imsg → Apple Messages
 * Polls balloon); if the channel has none (e.g. Telegram backup), degrades to a plain-text
 * poll so the question + options still land. Returns the text that was logged to the
 * transcript (a one-line summary for the native case, the full text for the fallback) plus
 * the sent bubble's `guid` when the channel surfaces one (native poll OR the text-poll
 * fallback's send) — so the /bg lane can register the poll bubble and a threaded reply onto
 * it continues the branch. `guid` is null when no channel returns one.
 */
async function firePoll(
  transport: Transport,
  to: string,
  poll: { question: string; options: string[] },
  opts?: SendOptions,
): Promise<{ text: string; guid: string | null }> {
  if (transport.sendPoll) {
    try {
      const guid = await transport.sendPoll(to, poll.question, poll.options, opts);
      return { text: `📊 poll: ${poll.question} (${poll.options.join(" / ")})`, guid };
    } catch (e) {
      // Native poll failed (CLI hiccup, or no child channel supports polls) — degrade to a
      // plain-text poll so the question + options still reach them rather than vanishing.
      warn(`native poll failed, falling back to text poll: ${e}`);
    }
  }
  const textPoll = `📊 ${poll.question}\n${poll.options.map((o) => `- ${o}`).join("\n")}`;
  const guid = await transport.send(to, textPoll, opts);
  return { text: textPoll, guid };
}

export interface PacedSendOptions {
  /** Static per-send options applied to every bubble's transport.send (e.g. a group chatGuid). */
  sendOpts?: SendOptions;
  /**
   * Called when a bubble's send throws. The loop always continues to the next bubble
   * (matching the original try/catch-and-warn sites); this is just the site-specific log.
   * Receives the error plus the 0-based bubble index and the total bubble count.
   */
  onError?: (err: unknown, index: number, total: number) => void;
}

/**
 * Split `body` into paced bubbles and send them to `to` over `transport`, sleeping
 * `naturalChunkDelayMs(bubble)` between consecutive bubbles. Empty bubbles are skipped.
 * `body` is expected to be already cleaned/unwrapped by the caller — this does no
 * stripping of its own, so cadence and content match the prior inline loops exactly.
 */
export async function pacedSend(
  transport: Transport,
  to: string,
  body: string,
  opts?: PacedSendOptions,
): Promise<void> {
  // Proactive/scheduled lane doesn't funnel through buildChunks, so apply the same
  // email-link rewrite here — bare gmail urls / [[email:…]] tokens in an automated message
  // (briefing, watch, check-in) become clean open-email.cc short links too. Email first, then
  // wrap whatever GENERAL links remain in open-url.cc preview cards (email links are already
  // minted + skipped by rewriteLinkPreviews).
  body = await rewriteEmailLinks(body);
  body = await rewriteLinkPreviews(body);
  const chunks = splitIntoChunks(body);
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]) continue;

    // A `[[poll:…]]` bubble → fire a native Messages poll (text fallback if unsupported).
    const pollP = parsePoll(chunks[i]);
    if (pollP) {
      try {
        // Proactive/scheduled lane — no /bg branch, so the returned guid is unused.
        await firePoll(transport, to, pollP, opts?.sendOpts);
      } catch (e) {
        opts?.onError?.(e, i, chunks.length);
      }
      if (i < chunks.length - 1) await sleep(naturalChunkDelayMs(pollP.question));
      continue;
    }

    // A bare image URL on its own line → send as a real inline attachment, not a
    // tappable link. Mirrors the reactive deliverReply path so proactive/scheduled
    // messages attach images the same way. Falls back to sending the URL as text if
    // the transport can't attach it.
    if (isImageUrl(chunks[i])) {
      const url = chunks[i].trim();
      try {
        await transport.send(to, "", { ...opts?.sendOpts, mediaUrl: url });
      } catch (e) {
        opts?.onError?.(e, i, chunks.length);
        try {
          await transport.send(to, url, opts?.sendOpts);
        } catch (e2) {
          opts?.onError?.(e2, i, chunks.length);
        }
      }
      if (i < chunks.length - 1) await sleep(naturalChunkDelayMs(url));
      continue;
    }

    // A local media/doc file path on its own line → attach the REAL file (read bytes +
    // infer MIME), the same way a bare image URL becomes an inline image. If it isn't a
    // readable file on disk we skip this branch and send the path as ordinary text below.
    if (isLocalFilePath(chunks[i])) {
      const p = chunks[i].trim();
      const att = fileAttachmentOpts(p);
      if (att) {
        try {
          await transport.send(to, "", { ...opts?.sendOpts, ...att });
        } catch (e) {
          opts?.onError?.(e, i, chunks.length);
          try {
            await transport.send(to, p, opts?.sendOpts);
          } catch (e2) {
            opts?.onError?.(e2, i, chunks.length);
          }
        }
        if (i < chunks.length - 1) await sleep(naturalChunkDelayMs(p));
        continue;
      }
    }

    // Apply any inline ((effect)) marker per bubble — mirrors the reactive deliverReply
    // path. Without this, a proactive/scheduled message (evening check-in, briefing,
    // watch, goal…) ships the raw `((gentle))` token as literal text with no effect.
    const { text, effectId } = extractEffect(chunks[i]);
    if (!text) continue;
    // Link-only bubble → native rich-link card, same as the reactive lane (see below).
    const richLinkUrl = bareRichLinkUrl(text) ?? undefined;
    try {
      const extra = { ...opts?.sendOpts, ...(effectId ? { effectId } : {}), ...(richLinkUrl ? { richLinkUrl } : {}) };
      await transport.send(to, text, Object.keys(extra).length ? extra : opts?.sendOpts);
    } catch (e) {
      opts?.onError?.(e, i, chunks.length);
    }
    if (i < chunks.length - 1) await sleep(naturalChunkDelayMs(text));
  }
}

/**
 * The FULL live-turn delivery path (richer than pacedSend), factored out of the
 * Conversation so the main serial loop AND a concurrent `/btw` background fig instance
 * render replies identically — chunking, lone-emoji→tapback, inline image URLs,
 * ((effects)), and [[draft:…]] expansion — with zero drift. The only per-lane inputs are
 * the reply target, the tapback target (last inbound id), and an optional abort signal.
 */

/**
 * Expand any [[draft:<account>:<id>]] tokens into the exact saved Gmail draft, rendered
 * as a single verbatim bubble — so the preview is byte-for-byte what's saved (and what
 * will send), not the model's retyping. Prose around a token is transformed and split
 * normally; the draft block bypasses lowercasing/markdown-stripping and stays atomic.
 */
async function buildChunks(raw: string): Promise<string[]> {
  // FIRST: rewrite any email links to clean open-email.cc short links (an explicit
  // [[email:<url>]] token or a bare gmail web url). Done before chunking so the minted
  // open-email.cc link is what chunking sees — and chunking deliberately keeps it INLINE
  // (not its own bubble) so iMessage renders a tappable link, not a rich preview card.
  raw = await rewriteEmailLinks(raw);
  // THEN: wrap any remaining GENERAL external web links in open-url.cc preview wrappers, so a
  // bare url gets a clean baked OpenGraph card. Runs after the email rewrite so email links
  // are already minted (open-email.cc) and skipped here; images / maps / our own domains are
  // left untouched (see shouldWrapUrl). The scheme-less wrapper is lifted onto its own bubble
  // by chunking (LINK_PREVIEW_SHORT_LINK_RE) so the card renders.
  raw = await rewriteLinkPreviews(raw);
  // Both special tokens carve themselves out of the prose as their own atomic bubble:
  //   [[draft:<account>:<id>]] → the verbatim Gmail draft preview
  //   [[poll: q | opt | opt]]  → a native Messages poll (kept verbatim; delivery fires it)
  const TOKEN = /\[\[(?:draft:(?<acct>[^:\]]+):(?<id>[^\]]+)|poll:(?<poll>[^\]]*))\]\]/gi;
  if (!TOKEN.test(raw)) {
    const full = lowercaseSentenceStarts(stripMarkdown(raw)).trim();
    return full ? splitIntoChunks(full) : [];
  }
  const prose = (s: string): string[] => {
    const f = lowercaseSentenceStarts(stripMarkdown(s)).trim();
    return f ? splitIntoChunks(f) : [];
  };
  TOKEN.lastIndex = 0;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(raw)) !== null) {
    out.push(...prose(raw.slice(last, m.index)));
    if (m.groups?.poll !== undefined) {
      out.push(m[0]); // verbatim [[poll:…]] — deliverReply parses + fires it as a native poll
    } else {
      try {
        out.push(formatDraftPreview(await getDraft(m.groups!.id, m.groups!.acct))); // atomic bubble
      } catch (e) {
        warn(`draft preview fetch failed (${m.groups!.acct}:${m.groups!.id}): ${e}`);
        out.push("⚠️ couldn't pull that draft from gmail — it may have been deleted. want me to recreate it?");
      }
    }
    last = m.index + m[0].length;
  }
  out.push(...prose(raw.slice(last)));
  return out;
}

export interface DeliverOptions {
  transport: Transport;
  /** The handle to send to (owner number/email, or a /btw's own reply target). */
  to: string;
  raw: string;
  /** Target for a lone-emoji tapback; omit to always send emojis as normal bubbles. */
  lastInboundId?: string;
  /**
   * When set, each text bubble is sent as a THREADED reply to this message guid (the
   * inline reply bubble in Messages). The /btw lane passes the /bg message's id so a
   * background reply threads onto the exact message it answers — telling parallel /bg
   * runs apart. Omit for a normal flat reply.
   */
  replyToId?: string;
  /** When aborted, delivery stops (no stale bubbles); omit for an uninterruptible lane. */
  signal?: AbortSignal;
  /**
   * Mark the delivered text as a `/bg` (ephemeral-branch) turn in the transcript,
   * so it's tagged `fig[bg]:` and main's reseed filter strips it (recentHistory).
   * The /btw lane sets this; the main loop leaves it off for normal logging.
   */
  bg?: boolean;
}

/**
 * Put an EXPLICIT tapback on `messageId` — the `ack({ tapback })` path.
 *
 * Unlike deliverReply's lone-emoji conversion (which infers a reaction from a
 * reply that happens to be one emoji), nothing is inferred here: the model
 * asked for a reaction in a dedicated field. A mapped emoji still goes out as
 * one of the six CLASSIC tapbacks, because those render on every receiver;
 * anything else rides the arbitrary-emoji path (iMessage type 2006), which
 * needs an iOS 18-era receiver and a bridge that can build it.
 *
 * Returns true if the reaction landed. On false the caller is expected to fall
 * back to a text bubble rather than leave the owner with no acknowledgement.
 */
export async function deliverTapback(opts: {
  transport: Transport;
  to: string;
  messageId?: string;
  emoji: string;
  bg?: boolean;
}): Promise<boolean> {
  const { transport, to, messageId, emoji, bg } = opts;
  if (!transport.react || !messageId) return false;
  const classic = tapbackForEmoji(emoji);
  const reaction: Reaction = classic ? (classic as Reaction) : { emoji };
  try {
    await transport.react(to, messageId, reaction);
    logOutbound(emoji, { bg });
    return true;
  } catch (e) {
    warn(`tapback ${emoji} failed: ${e}`);
    return false;
  }
}

/**
 * Render `raw` into paced iMessage bubbles and send them to `to`. A reply that is JUST a
 * tapback emoji reacts on the last inbound instead of sending a bubble. Logs the delivered
 * text to the transcript exactly like a normal turn.
 */
export async function deliverReply(opts: DeliverOptions): Promise<void> {
  const { transport, to, raw, lastInboundId, replyToId, signal, bg } = opts;
  if (signal?.aborted) return; // turn was cancelled — don't emit stale bubbles
  const chunks = await buildChunks(raw);
  if (!chunks.length) return;

  // A reply that is JUST a tapback emoji → react on their last message, no text bubble.
  const reaction = chunks.length === 1 ? tapbackForEmoji(chunks[0]) : null;
  if (reaction && transport.react && lastInboundId) {
    try {
      await transport.react(to, lastInboundId, reaction as Reaction);
      logOutbound(chunks[0], { bg });
      return;
    } catch (e) {
      warn(`react failed, sending as text instead: ${e}`);
    }
  }

  // Normal delivery: split into paced bubbles, applying any ((effect)) marker per bubble.
  const sent: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) break; // stop paced delivery of a cancelled reply

    // A `[[poll:…]]` bubble → fire a native Messages poll balloon (threaded if replying),
    // falling back to a plain-text poll on channels without native polls.
    const poll = parsePoll(chunks[i]);
    if (poll) {
      try {
        const res = await firePoll(transport, to, poll, replyToId ? { replyToId } : undefined);
        // /bg lane: remember the poll bubble's guid so a threaded reply onto it
        // auto-continues the branch (routing B for poll bubbles). No-op on null.
        if (bg) registerBgReplyGuid(res.guid);
        sent.push(res.text);
      } catch (e) {
        warn(`poll ${i + 1}/${chunks.length} FAILED to send (not delivered): ${e}`);
      }
      if (i < chunks.length - 1) {
        void transport.typing?.(to).catch(() => {});
        await sleep(naturalChunkDelayMs(poll.question));
      }
      continue;
    }

    // A local media/doc file path on its own line → attach the REAL file (read bytes +
    // infer MIME), the same way a bare image URL becomes an inline image. Falls back to
    // sending the path as text if it isn't a readable file on disk.
    if (isLocalFilePath(chunks[i])) {
      const p = chunks[i].trim();
      const att = fileAttachmentOpts(p);
      if (att) {
        try {
          const guid = await transport.send(to, "", att);
          // /bg lane: remember this image/file bubble's guid so a threaded reply onto
          // it auto-continues the branch (routing B for attachment bubbles). No-op on null.
          if (bg) registerBgReplyGuid(guid);
          sent.push(`[file: ${att.mediaFilename}]`);
        } catch (e) {
          warn(`file attach failed, sending path as text instead: ${e}`);
          try {
            await transport.send(to, p);
            sent.push(p);
          } catch (e2) {
            warn(`path fallback also failed: ${e2}`);
          }
        }
        if (i < chunks.length - 1) {
          void transport.typing?.(to).catch(() => {});
          await sleep(naturalChunkDelayMs(p));
        }
        continue;
      }
    }

    // A bare image URL on its own line → send it as an actual inline image, not a
    // link. If the transport can't attach it (can't fetch it, MMS rejected), fall
    // back to sending the URL as text so it at least stays tappable.
    let body: string;
    let effectId: string | undefined;
    if (isImageUrl(chunks[i])) {
      const url = chunks[i].trim();
      sent.push(url);
      try {
        const guid = await transport.send(to, "", { mediaUrl: url });
        // /bg lane: remember this image bubble's guid so a threaded reply onto it
        // auto-continues the branch (routing B for image bubbles). No-op on null.
        if (bg) registerBgReplyGuid(guid);
      } catch (e) {
        warn(`image send failed, sending as link instead: ${e}`);
        try {
          await transport.send(to, url);
        } catch (e2) {
          warn(`link fallback also failed: ${e2}`);
        }
      }
      body = url;
    } else {
      ({ text: body, effectId } = extractEffect(chunks[i]));
      if (!body) continue;
      // A bubble that's nothing but a link → ask the transport for a NATIVE rich-link
      // card. imsg bakes the LinkPresentation payload into the message so it renders a
      // real preview; without it every link lands as the grey "Tap to Load Preview" stub.
      // The transport falls back to a plain text bubble if the card can't be built.
      const richLinkUrl = bareRichLinkUrl(body) ?? undefined;
      try {
        const guid = await transport.send(
          to,
          body,
          effectId || replyToId || richLinkUrl ? { effectId, replyToId, richLinkUrl } : undefined,
        );
        // /bg lane: remember this bubble's guid so a threaded reply onto it auto-continues
        // the branch (routing B). No-op on null (AppleScript fallback / non-imsg channel).
        if (bg) registerBgReplyGuid(guid);
        sent.push(body);
      } catch (e) {
        // Already retried inside the transport — if it still failed, the bubble did
        // NOT reach them. Don't record it as sent; warn loudly so it isn't invisible.
        warn(`bubble ${i + 1}/${chunks.length} FAILED to send (not delivered): ${e}`);
      }
    }
    if (i < chunks.length - 1) {
      // Re-show typing during the inter-bubble pause (a sent message clears it), so it
      // reads as "composing the next one" rather than going quiet between bubbles.
      void transport.typing?.(to).catch(() => {});
      await sleep(naturalChunkDelayMs(body));
    }
  }
  if (sent.length) logOutbound(sent.join("\n\n"), { bg });
}
