/**
 * Transport abstraction. The agent loop talks to this interface and never to a
 * specific channel — so imsg (the live iMessage transport) and Telegram (backup)
 * are drop-in swaps behind the same shape.
 */

/**
 * The six classic iMessage tapbacks. These are the `associated_message_type`
 * 2000–2005 reactions every receiver renders, on every OS version.
 */
export type ClassicReaction =
  | "like"
  | "love"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

/**
 * An ARBITRARY emoji tapback — iOS 18 / macOS 15's "react with any emoji"
 * (`associated_message_type` 2006, emoji carried in `associated_message_emoji`).
 * It is a real reaction, not a sticker and not a text bubble. `emoji` must be a
 * single emoji; imsg rejects anything else rather than guessing.
 */
export interface EmojiReaction {
  emoji: string;
}

/**
 * What a transport can react WITH. Deliberately a union rather than a widened
 * string: a classic stays a named kind (so it renders everywhere), and anything
 * else has to be explicitly wrapped as `{ emoji }` — there is no code path that
 * mines an emoji out of prose.
 */
export type Reaction = ClassicReaction | EmojiReaction;

/** Narrow a Reaction to one of the six classics. */
export function isClassicReaction(r: Reaction): r is ClassicReaction {
  return typeof r === "string";
}

export interface InboundMessage {
  /** Provider message id — used for dedup and (later) reactions. */
  id: string;
  /** Sender, E.164. */
  from: string;
  text: string;
  isGroup?: boolean;
  /** Group thread identity. Lets us recognize a specific chat and reply INTO it. */
  chatGuid?: string;
  chatName?: string;
  /** The agent's handle was @-mentioned in a group. */
  isMention?: boolean;
  mediaUrls?: string[];
  /**
   * Already-local attachment files the transport staged itself (vs. mediaUrls,
   * which the daemon downloads). imsg stages inbound attachments to local paths
   * directly, so the daemon doesn't need to re-fetch or re-derive file extensions.
   */
  mediaPaths?: string[];
  /**
   * Threaded-reply target: the guid of the EARLIER message this one is an inline
   * iMessage reply to. Set ONLY on genuine threaded replies (read from chat.db's
   * `thread_originator_guid`); undefined for a normal, non-reply message. The `imsg
   * watch` stream carries no reply field and imsg's own `reply_to_guid` is fabricated,
   * so the transport resolves this straight from chat.db per inbound (see imsg poll()).
   */
  replyToId?: string;
  /** Text of the replied-to message (best-effort — from the transport's text cache or
   *  chat.db). Used to show fig WHAT they replied to via a `[replying to "…"]` marker. */
  replyToText?: string;
  /** True when the replied-to message was fig's own (is_from_me) — e.g. a reply onto a bubble. */
  replyToFromMe?: boolean;
  at?: string;
}

/** Per-send options. `effectId` is an Apple expressive-send id (imsg). */
export interface SendOptions {
  effectId?: string;
  /** Send this image/media URL as an actual attachment (the transport fetches & attaches it). */
  mediaUrl?: string;
  /**
   * Send raw bytes as an actual attachment, no URL/disk round-trip. Used for things the
   * agent generates in-process (e.g. gpt-image-2 output, which comes back as base64).
   * imsg attaches these bytes directly via the IMCore bridge. `mediaUrl` wins if
   * both are set.
   */
  mediaBase64?: string;
  mediaFilename?: string;
  mediaMime?: string;
  /**
   * Target a group thread by its guid instead of the `to` phone number.
   * When set, imsg sends into that chat; `to` is ignored for delivery.
   */
  chatGuid?: string;
  /**
   * Send this bubble as a THREADED reply to an existing message (its guid) — the
   * inline "reply" bubble in Messages, distinct from a tapback. Routed via the IMCore
   * bridge (`send-rich --reply-to`); the AppleScript fallback can't thread, so it
   * degrades to a normal bubble. Used by the /btw lane so a background reply threads
   * onto the exact /bg message it answers (tells parallel /bg runs apart).
   */
  replyToId?: string;
  /**
   * Send this bubble as a NATIVE iMessage rich link — a real preview card, not the grey
   * "Tap to Load Preview" stub. Routed via `imsg send-rich --url`, which resolves the
   * target's LinkPresentation metadata on THIS mac and bakes an LPLinkMetadata payload
   * into the message; the receiving device renders that payload without fetching anything.
   * (Programmatic sends carry no link metadata by default — THAT, not scraping, is why
   * every link the bot has ever sent showed a grey stub.) Needs the IMCore bridge with
   * imsg ≥ 0.13.0; anything else falls back to sending the url as plain text.
   */
  richLinkUrl?: string;
}

export interface Transport {
  /** Pull new inbound messages. imsg pushes into a buffer we drain here; other channels may poll. */
  poll(): Promise<InboundMessage[]>;
  /**
   * Send one text chunk to a recipient, optionally with an iMessage effect. Returns the
   * sent message's guid when the channel can surface one (imsg's bridge send), else null.
   * The guid lets the /bg lane register its own reply bubbles so a threaded reply onto one
   * auto-continues the branch; callers that don't need it just ignore the return.
   */
  send(to: string, text: string, opts?: SendOptions): Promise<string | null>;
  /** Optional typing indicator (assert/refresh "is typing…"). */
  typing?(to: string): Promise<void>;
  /** Optional: clear the typing indicator immediately. */
  stopTyping?(to: string): Promise<void>;
  /** Optional tapback reaction (where the channel supports it, e.g. imsg). */
  react?(to: string, messageId: string, reaction: Reaction): Promise<void>;
  /**
   * Optional native poll (imsg → Apple Messages Polls balloon). `options` needs ≥ 2.
   * `opts.replyToId` threads the poll onto a message; `opts.chatGuid` targets a group.
   * Channels without native polls leave this undefined; the delivery layer falls back
   * to a plain-text poll. Returns the sent poll bubble's guid when the channel surfaces
   * one (imsg's bridge), else null — lets the /bg lane register the poll bubble so a
   * threaded reply onto it continues the branch, mirroring send()'s guid return.
   */
  sendPoll?(to: string, question: string, options: string[], opts?: SendOptions): Promise<string | null>;
}
