import { config, normalizeNumber, redact } from "../core/config";
import { err, log, warn } from "../core/log";
import type { InboundMessage, Reaction, SendOptions, Transport } from "./types";
import { isClassicReaction } from "./types";

/**
 * Telegram transport — a reliable backup channel that has no Mac/iCloud/phone-plan
 * dependency and doesn't do the zombie-stall thing a hosted iMessage stream does.
 * Pure Bot API over `fetch` (the REST surface is trivial and the rest of our
 * transports are raw fetch too).
 *
 * Inbound uses long-polling getUpdates in a background pump that fills a buffer; the
 * daemon's poll() just drains it (the same shape the other transports present). On
 * startup we advance past the backlog so we never reply to old messages — except
 * anything from the last few minutes, so a text sent right before a restart isn't dropped.
 *
 * Identity bridge: the whole app gates on E.164 phone numbers (isOwner).
 * Telegram speaks numeric chat ids, so THIS file is the only place that knows chat ids
 * exist — it maps your chat id <-> your owner number both ways, and every existing
 * owner check keeps working unchanged.
 *
 *   TELEGRAM_BOT_TOKEN      from @BotFather
 *   TELEGRAM_OWNER_CHAT_ID  your chat id (text the bot once; it's logged on first contact)
 */

const PRIME_GRACE_MS = 3 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split into Telegram's 4096-char-per-message limit, preferring newline boundaries. */
function chunkText(s: string, max = 4096): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // no decent newline — hard split
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Our tapbacks -> a Telegram emoji from the default allowed reaction set. A
 * custom `{ emoji }` reaction passes straight through: Telegram accepts
 * arbitrary emoji here, and setMessageReaction simply fails (already caught by
 * the caller) when the chat's allowed set doesn't include it.
 */
function reactionEmoji(r: Reaction): string {
  if (!isClassicReaction(r)) return r.emoji;
  switch (r) {
    case "like": return "👍";
    case "love": return "❤";
    case "dislike": return "👎";
    case "laugh": return "😁";
    case "emphasize": return "🔥";
    case "question": return "🤔";
  }
}

export function makeTelegramTransport(): Transport {
  const token = config.telegram.botToken;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN not set — create a bot via @BotFather and put the token in .env.",
    );
  }

  const API = `https://api.telegram.org/bot${token}`;
  const FILE_API = `https://api.telegram.org/file/bot${token}`;
  const ownerNumber = config.ownerNumbers[0] ?? "";
  const ownerChatId = config.telegram.ownerChatId;
  const norm = normalizeNumber;

  const inbox: InboundMessage[] = [];
  const startedAt = Date.now();
  const hinted = new Set<string>(); // chat ids we've already logged an authorize-hint for
  let offset = 0;
  let botUsername = "";
  let botId = 0;

  /** POST a JSON Bot API call. Throws with `.status`/`.retryAfter` on Telegram errors. */
  async function call(method: string, body: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        const e: any = new Error(`telegram ${method}: ${j?.description || `HTTP ${res.status}`}`);
        e.status = res.status;
        e.retryAfter = j?.parameters?.retry_after;
        throw e;
      }
      return j.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST a multipart call (for raw-bytes attachments). */
  async function callForm(method: string, form: FormData): Promise<any> {
    const res = await fetch(`${API}/${method}`, { method: "POST", body: form });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j?.ok === false) {
      const e: any = new Error(`telegram ${method}: ${j?.description || `HTTP ${res.status}`}`);
      e.status = res.status;
      e.retryAfter = j?.parameters?.retry_after;
      throw e;
    }
    return j.result;
  }

  /** Retry transient failures (429 w/ retry_after, 5xx, network) with backoff. */
  async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
    const backoff = [700, 1600, 3200];
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        const status: number | undefined = e?.status;
        const transient =
          status === 429 ||
          (typeof status === "number" && status >= 500) ||
          /abort|fetch failed|network|timeout|socket|econn/i.test(e?.message || "");
        if (!transient || attempt >= backoff.length) throw e;
        const wait = e?.retryAfter ? e.retryAfter * 1000 : backoff[attempt];
        warn(`telegram: ${what} failed (${e?.message}) — retry ${attempt + 1}/${backoff.length} in ${wait}ms`);
        await sleep(wait);
      }
    }
  }

  // ── identity bridge ───────────────────────────────────────────────────────
  /** Inbound chat/sender -> the E.164 the app gates on (so isOwner works unchanged). */
  function fromFor(chatId: number, senderId: number | undefined): string {
    if (ownerChatId && String(chatId) === ownerChatId && ownerNumber) return ownerNumber;
    return String(senderId ?? chatId);
  }
  /** Outbound owner-number (or raw chat id) -> the Telegram chat id to send to. */
  function chatIdFor(to: string): string | undefined {
    if (ownerChatId && ownerNumber && norm(to) === norm(ownerNumber)) return ownerChatId;
    if (/^-?\d+$/.test(to.trim())) return to.trim(); // already a chat id
    return undefined;
  }

  // ── inbound mapping ───────────────────────────────────────────────────────
  async function fileUrl(fileId: string): Promise<string | undefined> {
    try {
      const f = await call("getFile", { file_id: fileId });
      return f?.file_path ? `${FILE_API}/${f.file_path}` : undefined;
    } catch (e: any) {
      warn(`telegram: getFile failed: ${e?.message}`);
      return undefined;
    }
  }

  async function collectMedia(m: any): Promise<string[]> {
    const ids: string[] = [];
    if (Array.isArray(m.photo) && m.photo.length) ids.push(m.photo[m.photo.length - 1].file_id); // largest size
    if (m.document?.file_id) ids.push(m.document.file_id);
    if (m.video?.file_id) ids.push(m.video.file_id);
    if (m.voice?.file_id) ids.push(m.voice.file_id);
    if (m.audio?.file_id) ids.push(m.audio.file_id);
    const urls = await Promise.all(ids.map(fileUrl));
    return urls.filter((u): u is string => !!u);
  }

  async function toInbound(m: any): Promise<InboundMessage | null> {
    const chat = m.chat;
    if (!chat) return null;
    const chatId: number = chat.id;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const senderId: number | undefined = m.from?.id;
    const text: string = m.text ?? m.caption ?? "";
    const mediaUrls = await collectMedia(m);
    if (!text && !mediaUrls.length) return null;

    // One-time discovery hint so the owner can authorize their chat from the log.
    if (!isGroup && !(ownerChatId && String(chatId) === ownerChatId) && !hinted.has(String(chatId))) {
      hinted.add(String(chatId));
      log(`telegram: message from unauthorized chat ${chatId} — set TELEGRAM_OWNER_CHAT_ID=${chatId} in .env to allow`);
    }

    let isMention = false;
    if (isGroup) {
      const ents = (m.entities ?? m.caption_entities ?? []) as any[];
      isMention = ents.some(
        (e) =>
          (e.type === "mention" &&
            botUsername &&
            text.substr(e.offset, e.length).toLowerCase() === `@${botUsername.toLowerCase()}`) ||
          (e.type === "text_mention" && e.user?.id === botId),
      );
    }

    return {
      id: `${chatId}:${m.message_id}`,
      from: isGroup ? String(senderId ?? chatId) : fromFor(chatId, senderId),
      text,
      isGroup: isGroup || undefined,
      chatGuid: isGroup ? String(chatId) : undefined,
      chatName: isGroup ? chat.title : undefined,
      isMention: isMention || undefined,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      at: new Date((m.date ?? 0) * 1000).toISOString(),
    };
  }

  // ── background long-poll pump ─────────────────────────────────────────────
  async function identify(): Promise<void> {
    try {
      const me = await call("getMe", {});
      botUsername = me?.username ?? "";
      botId = me?.id ?? 0;
      const auth = ownerChatId
        ? `owner chat ${ownerChatId} → ${ownerNumber ? redact(ownerNumber) : "(no OWNER_NUMBERS)"}`
        : "NO TELEGRAM_OWNER_CHAT_ID set — text the bot once, then set it in .env";
      log(`telegram: bot @${botUsername} up (${auth})`);
    } catch (e: any) {
      err(`telegram: getMe failed — token bad? ${e?.message}`);
    }
  }

  async function prime(): Promise<void> {
    try {
      const ups: any[] = await call("getUpdates", { timeout: 0, allowed_updates: ["message"] }, 15000);
      let ignored = 0;
      for (const u of ups) {
        offset = Math.max(offset, u.update_id + 1);
        const m = u.message;
        if (!m) continue;
        const recent = startedAt - (m.date ?? 0) * 1000 < PRIME_GRACE_MS;
        if (recent) {
          const im = await toInbound(m);
          if (im) inbox.push(im);
        } else {
          ignored++;
        }
      }
      log(`telegram primed — offset=${offset}, ignoring ${ignored} old update(s), watching recent`);
    } catch (e: any) {
      warn(`telegram prime failed: ${e?.message}`);
    }
  }

  async function pump(): Promise<void> {
    await identify();
    await prime();
    let backoff = 1000;
    for (;;) {
      try {
        const ups: any[] = await call(
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message"] },
          35000,
        );
        backoff = 1000;
        for (const u of ups) {
          offset = Math.max(offset, u.update_id + 1);
          const m = u.message;
          if (!m) continue;
          try {
            const im = await toInbound(m);
            if (im) inbox.push(im);
          } catch (e: any) {
            warn(`telegram: failed to map update ${u.update_id}: ${e?.message}`);
          }
        }
      } catch (e: any) {
        warn(`telegram: getUpdates failed (${e?.message}) — retry in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  void pump();

  // ── outbound ──────────────────────────────────────────────────────────────
  async function sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await withRetry(() => call("sendMessage", { chat_id: chatId, text: chunk }), "sendMessage");
    }
  }

  async function sendMedia(chatId: string, text: string, opts: SendOptions): Promise<void> {
    const caption = text && text.length <= 1024 ? text : "";
    if (opts.mediaUrl) {
      // Telegram fetches the URL itself; fall back to document if it isn't a photo.
      try {
        await withRetry(
          () => call("sendPhoto", { chat_id: chatId, photo: opts.mediaUrl, ...(caption ? { caption } : {}) }),
          "sendPhoto",
        );
      } catch {
        await withRetry(
          () => call("sendDocument", { chat_id: chatId, document: opts.mediaUrl, ...(caption ? { caption } : {}) }),
          "sendDocument",
        );
      }
    } else if (opts.mediaBase64) {
      const buf = Buffer.from(opts.mediaBase64, "base64");
      const isImg = (opts.mediaMime || "").startsWith("image/");
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption);
      const blob = new Blob([buf], { type: opts.mediaMime || "application/octet-stream" });
      form.append(isImg ? "photo" : "document", blob, opts.mediaFilename || (isImg ? "image.png" : "file.bin"));
      await withRetry(() => callForm(isImg ? "sendPhoto" : "sendDocument", form), "sendMedia");
    }
    // Caption maxes at 1024; if the text was longer it was dropped above — send it in full.
    if (text && !caption) await sendText(chatId, text);
  }

  return {
    async poll(): Promise<InboundMessage[]> {
      return inbox.splice(0);
    },

    async send(to: string, text: string, opts?: SendOptions): Promise<string | null> {
      // Telegram never surfaces a guid the /bg reply-registry can use, so always null.
      const chatId = opts?.chatGuid?.trim() || chatIdFor(to);
      if (!chatId) {
        warn(`telegram: no chat mapping for ${redact(to)} — set TELEGRAM_OWNER_CHAT_ID in .env. Dropping send.`);
        return null;
      }
      if (opts?.mediaUrl || opts?.mediaBase64) {
        await sendMedia(chatId, text, opts);
        return null;
      }
      if (text) await sendText(chatId, text);
      return null;
    },

    async typing(to: string): Promise<void> {
      try {
        const chatId = chatIdFor(to);
        if (chatId) await call("sendChatAction", { chat_id: chatId, action: "typing" });
      } catch {
        /* typing is best-effort */
      }
    },

    async react(to: string, messageId: string, reaction: Reaction): Promise<void> {
      try {
        const chatId = chatIdFor(to) ?? messageId.split(":")[0];
        const mid = Number(messageId.split(":").pop());
        if (!chatId || !Number.isFinite(mid)) return;
        await call("setMessageReaction", {
          chat_id: chatId,
          message_id: mid,
          reaction: [{ type: "emoji", emoji: reactionEmoji(reaction) }],
        });
      } catch {
        /* reactions are best-effort (emoji may be outside the chat's allowed set) */
      }
    },
  };
}
