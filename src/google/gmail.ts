import fs from "node:fs";
import path from "node:path";

import { google, gmail_v1 } from "googleapis";

import { accountFor, googleAccounts, oauth2For, primaryLabel } from "./accounts";

/**
 * Shared Gmail core. Used both by the in-process mcp__gmail__* tools and
 * by the watch/triage path. Multi-account: every function takes an optional `account`
 * label (defaults to the primary account); clients are cached per label.
 */

const clients = new Map<string, gmail_v1.Gmail>();

export function gmailClient(account?: string): gmail_v1.Gmail {
  const label = accountFor(account).label; // validates + normalizes (undefined → primary)
  let c = clients.get(label);
  if (!c) {
    c = google.gmail({ version: "v1", auth: oauth2For(label) });
    clients.set(label, c);
  }
  return c;
}

/** The Gmail address behind an account label (cached). Used to route + tag pings. */
const emailCache = new Map<string, string>();
export async function accountEmail(account?: string): Promise<string> {
  const label = accountFor(account).label;
  const hit = emailCache.get(label);
  if (hit) return hit;
  const res = await gmailClient(label).users.getProfile({ userId: "me" });
  const email = (res.data.emailAddress ?? "").toLowerCase();
  if (email) emailCache.set(label, email);
  return email;
}

// Gmail message ids are per-account, so an id alone doesn't say which mailbox it's in.
// We learn the mapping when listing/getting and cache it, so follow-up actions (get,
// label, trash…) resolve the account from the id automatically — the agent never has
// to track it, and the owner never specifies an inbox.
const idAccount = new Map<string, string>();
function rememberId(id: string, label: string): void {
  idAccount.set(id, label);
  if (idAccount.size > 5000) for (const k of [...idAccount.keys()].slice(0, 2500)) idAccount.delete(k);
}

/**
 * Which account owns this message id. Uses the `hint` if given, then the cache, then
 * probes each account (cheap metadata get) until one has it. Throws if none do.
 */
export async function accountForId(id: string, hint?: string): Promise<string> {
  if (hint) return accountFor(hint).label;
  const cached = idAccount.get(id);
  if (cached) return cached;
  for (const acct of googleAccounts()) {
    try {
      await gmailClient(acct.label).users.messages.get({ userId: "me", id, format: "minimal" });
      rememberId(id, acct.label);
      return acct.label;
    } catch {
      /* not in this account — try the next */
    }
  }
  throw new Error(`Message ${id} not found in any configured account.`);
}

const SYSTEM_LABELS = new Set([
  "INBOX", "SENT", "UNREAD", "STARRED", "IMPORTANT", "SPAM", "TRASH", "DRAFT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export interface MsgSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  account: string; // which account label this message lives in
}

export async function listMessages(opts: { query?: string; max?: number; account?: string } = {}): Promise<MsgSummary[]> {
  const label = accountFor(opts.account).label;
  const g = gmailClient(label);
  const max = Math.min(opts.max ?? 15, 250);
  // Paginate the (cheap) id list until we have `max` ids or run out.
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const res = await g.users.messages.list({
      userId: "me",
      q: opts.query,
      maxResults: Math.min(100, max - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  const out: MsgSummary[] = [];
  for (const id of ids.slice(0, max)) {
    const m = await g.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const p = m.data.payload;
    const mid = m.data.id ?? id;
    rememberId(mid, label);
    out.push({
      id: mid,
      threadId: m.data.threadId ?? "",
      from: header(p, "From"),
      subject: header(p, "Subject"),
      date: header(p, "Date"),
      snippet: m.data.snippet ?? "",
      unread: (m.data.labelIds ?? []).includes("UNREAD"),
      labels: m.data.labelIds ?? [],
      account: label,
    });
  }
  return out;
}

/**
 * Search EVERY configured account and merge, newest first. This is the default for
 * the agent: it doesn't know (and the owner shouldn't have to say) which inbox a
 * message is in, so we look in all of them and each result carries its `account`.
 */
export async function listMessagesAll(opts: { query?: string; max?: number } = {}): Promise<MsgSummary[]> {
  const accounts = googleAccounts();
  const per = await Promise.all(
    accounts.map((a) =>
      listMessages({ query: opts.query, max: opts.max, account: a.label }).catch(() => [] as MsgSummary[]),
    ),
  );
  const merged = per.flat();
  merged.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return typeof opts.max === "number" ? merged.slice(0, opts.max) : merged;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a message's readable body. Prefers text/plain, falls back to text/html
 * (tag-stripped). Most parts carry their content inline as base64url in `body.data`,
 * but LARGE parts (e.g. big HTML newsletters) come back from `messages.get` with a
 * `body.attachmentId` and NO `body.data` — those must be fetched separately via
 * `messages.attachments.get` (same idiom as saveAttachments). We handle both so big
 * emails don't resolve to an empty body. Never throws: a failed attachment fetch
 * falls back to whatever inline text we have (or "").
 */
async function resolveBody(
  g: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart | undefined,
): Promise<string> {
  if (!payload) return "";
  // A part is usable if it has inline data OR an attachmentId we can fetch.
  const find = (part: gmail_v1.Schema$MessagePart, mime: string): gmail_v1.Schema$MessagePart | undefined => {
    if (part.mimeType === mime && (part.body?.data || part.body?.attachmentId)) return part;
    for (const c of part.parts ?? []) {
      const r = find(c, mime);
      if (r) return r;
    }
    return undefined;
  };
  const part = find(payload, "text/plain") ?? find(payload, "text/html");
  if (!part) return "";
  let data = part.body?.data ?? null;
  if (!data && part.body?.attachmentId && messageId) {
    try {
      const res = await g.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      data = res.data.data ?? null;
    } catch {
      // attachment fetch failed — fall back gracefully (no inline text to use here)
      data = null;
    }
  }
  if (!data) return "";
  let text = Buffer.from(data, "base64url").toString("utf8");
  if (part.mimeType === "text/html") {
    text = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ");
  }
  return text.trim();
}

export interface Attachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface FullMessage extends MsgSummary {
  to: string;
  cc: string;
  body: string;
  attachments: Attachment[];
  webUrl: string;
}

/** Open-this-message URL in Gmail web (tappable in iMessage; opens the Gmail app on iOS). */
export function messageWebUrl(id: string): string {
  return `https://mail.google.com/mail/u/0/#all/${id}`;
}

function collectAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
  out: Attachment[] = [],
): Attachment[] {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? "",
      attachmentId: payload.body.attachmentId,
      size: payload.body.size ?? 0,
    });
  }
  for (const part of payload.parts ?? []) collectAttachments(part, out);
  return out;
}

export async function getMessage(id: string, account?: string): Promise<FullMessage> {
  const label = await accountForId(id, account); // resolve which inbox owns it
  const g = gmailClient(label);
  let m = await g.users.messages.get({ userId: "me", id, format: "full" });
  let body = await resolveBody(g, m.data.id ?? id, m.data.payload); // full body, never truncated
  if (!body) {
    // Just-arrived race: Gmail's push/history can fire a beat before the body is fully
    // materializable. One bounded retry after a short delay; if it's still empty the
    // caller falls back to `snippet`.
    await delay(1500);
    try {
      const retry = await g.users.messages.get({ userId: "me", id, format: "full" });
      const retryBody = await resolveBody(g, retry.data.id ?? id, retry.data.payload);
      if (retryBody) {
        m = retry;
        body = retryBody;
      }
    } catch {
      /* keep whatever we already have */
    }
  }
  const p = m.data.payload;
  return {
    id: m.data.id ?? id,
    threadId: m.data.threadId ?? "",
    from: header(p, "From"),
    to: header(p, "To"),
    cc: header(p, "Cc"),
    subject: header(p, "Subject"),
    date: header(p, "Date"),
    snippet: m.data.snippet ?? "",
    body,
    attachments: collectAttachments(p),
    webUrl: messageWebUrl(m.data.id ?? id),
    unread: (m.data.labelIds ?? []).includes("UNREAD"),
    labels: m.data.labelIds ?? [],
    account: label,
  };
}

/** Download every attachment on a message to destDir; returns the saved file paths. */
export async function saveAttachments(
  messageId: string,
  destDir: string,
  account?: string,
): Promise<{ filename: string; path: string; mimeType: string }[]> {
  const g = gmailClient(await accountForId(messageId, account));
  const m = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const atts = collectAttachments(m.data.payload);
  if (!atts.length) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const saved: { filename: string; path: string; mimeType: string }[] = [];
  for (const a of atts) {
    const res = await g.users.messages.attachments.get({ userId: "me", messageId, id: a.attachmentId });
    if (!res.data.data) continue;
    const safe = (a.filename.replace(/[^\w.\-]+/g, "_").slice(0, 120) || `att-${a.attachmentId.slice(0, 8)}`);
    const dest = path.join(destDir, safe);
    fs.writeFileSync(dest, Buffer.from(res.data.data, "base64url"));
    saved.push({ filename: a.filename, path: dest, mimeType: a.mimeType });
  }
  return saved;
}

/**
 * Current label ids on a message (cheap `minimal` get — ids only, no body/headers).
 * Used by the watch to re-check spam/trash status right before triage: Gmail's spam
 * classifier often moves a message to SPAM a beat AFTER it lands in INBOX, so the
 * push notification fires on a message that's spam by the time we'd act on it.
 */
export async function messageLabelIds(id: string, account?: string): Promise<string[]> {
  const label = await accountForId(id, account);
  const m = await gmailClient(label).users.messages.get({ userId: "me", id, format: "minimal" });
  return m.data.labelIds ?? [];
}

export async function listLabels(account?: string): Promise<{ id: string; name: string }[]> {
  const g = gmailClient(account);
  const res = await g.users.labels.list({ userId: "me" });
  return (res.data.labels ?? [])
    .filter((l) => l.id && l.name)
    .map((l) => ({ id: l.id as string, name: l.name as string }));
}

async function resolveLabelId(name: string, createIfMissing: boolean, account?: string): Promise<string | null> {
  const upper = name.toUpperCase();
  if (SYSTEM_LABELS.has(upper)) return upper;
  const existing = (await listLabels(account)).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  if (!createIfMissing) return null;
  const created = await gmailClient(account).users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id ?? null;
}

/** Create a label (idempotent — returns the existing id if it already exists). */
export async function createLabel(name: string, account?: string): Promise<string> {
  return (await resolveLabelId(name, true, account)) ?? "";
}

export async function renameLabel(oldName: string, newName: string, account?: string): Promise<void> {
  const id = await resolveLabelId(oldName, false, account);
  if (!id || SYSTEM_LABELS.has(id)) throw new Error(`No editable label named "${oldName}".`);
  await gmailClient(account).users.labels.patch({ userId: "me", id, requestBody: { name: newName } });
}

export async function deleteLabel(name: string, account?: string): Promise<void> {
  const id = await resolveLabelId(name, false, account);
  if (!id || SYSTEM_LABELS.has(id)) throw new Error(`No editable label named "${name}" (system labels can't be deleted).`);
  await gmailClient(account).users.labels.delete({ userId: "me", id });
}

/** Move a message to Trash (recoverable for 30 days). */
export async function trashMessage(id: string, account?: string): Promise<void> {
  await gmailClient(await accountForId(id, account)).users.messages.trash({ userId: "me", id });
}

export async function modifyLabels(id: string, addNames: string[], removeNames: string[], account?: string): Promise<void> {
  const label = await accountForId(id, account); // labels are per-account; act on the right one
  const addLabelIds: string[] = [];
  for (const n of addNames) {
    const lid = await resolveLabelId(n, true, label);
    if (lid) addLabelIds.push(lid);
  }
  const removeLabelIds: string[] = [];
  for (const n of removeNames) {
    const lid = await resolveLabelId(n, false, label);
    if (lid) removeLabelIds.push(lid);
  }
  await gmailClient(label).users.messages.modify({ userId: "me", id, requestBody: { addLabelIds, removeLabelIds } });
}

interface OutgoingArgs {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  cc?: string;
  account?: string;
}

function buildRaw(args: OutgoingArgs): string {
  const lines = [`To: ${args.to}`];
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  lines.push(
    `Subject: ${args.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.body,
  );
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export async function createDraft(args: OutgoingArgs): Promise<string> {
  const res = await gmailClient(args.account).users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: buildRaw(args), threadId: args.threadId } },
  });
  return res.data.id ?? "";
}

export interface DraftPreview {
  id: string;
  from: string; // the sending address
  to: string;
  subject: string;
  body: string;
  account: string;
}

/**
 * Read a saved draft back from Gmail by its draft id. The account label is required
 * (a draft id alone doesn't say which mailbox it lives in). Used to render the exact
 * saved draft for the owner — From falls back to the account address, since drafts we
 * create don't carry a From header until they're sent.
 */
export async function getDraft(id: string, account: string): Promise<DraftPreview> {
  const label = accountFor(account).label;
  const g = gmailClient(label);
  const res = await g.users.drafts.get({ userId: "me", id, format: "full" });
  const msg = res.data.message;
  const p = msg?.payload;
  return {
    id: res.data.id ?? id,
    from: header(p, "From") || (await accountEmail(label)),
    to: header(p, "To"),
    subject: header(p, "Subject"),
    // attachmentId-only parts are fetched against the draft's underlying message id.
    body: await resolveBody(g, msg?.id ?? "", p),
    account: label,
  };
}

/** Turn a raw "Name <addr>" recipient header into the "Name (addr)" preview form. */
function previewRecipient(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1].trim() ? `${m[1].trim()} (${m[2].trim()})` : raw.trim();
}

/** Render a draft in the exact preview shape the owner sees (one bubble, headers + body). */
export function formatDraftPreview(d: DraftPreview): string {
  return [
    `From: ${d.from}`,
    `To: ${previewRecipient(d.to)}`,
    `Subject: ${d.subject}`,
    "",
    d.body.trim(),
  ].join("\n");
}

/** Overwrite an existing draft in place (same id) — the refine loop edits, never piles up new drafts. */
export async function updateDraft(id: string, args: OutgoingArgs): Promise<string> {
  const res = await gmailClient(args.account).users.drafts.update({
    userId: "me",
    id,
    requestBody: { message: { raw: buildRaw(args), threadId: args.threadId } },
  });
  return res.data.id ?? id;
}

/** Send a saved draft by id — dispatches exactly what's stored, so send == the approved preview. */
export async function sendDraft(id: string, account: string): Promise<string> {
  const res = await gmailClient(accountFor(account).label).users.drafts.send({
    userId: "me",
    requestBody: { id },
  });
  return res.data.id ?? "";
}

export async function sendMessage(args: OutgoingArgs): Promise<string> {
  const res = await gmailClient(args.account).users.messages.send({
    userId: "me",
    requestBody: { raw: buildRaw(args), threadId: args.threadId },
  });
  return res.data.id ?? "";
}

/** Re-exported so callers (tools, watch) get the account registry from one place. */
export { googleAccounts, primaryLabel };
