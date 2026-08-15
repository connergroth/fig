import fs from "node:fs";
import path from "node:path";

import type { ImapFlow, MessageStructureObject, FetchMessageObject } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import nodemailer from "nodemailer";

import { warn } from "../core/log";
import { imapCreds, primaryAccount, type MailAccount } from "./accounts";
import { closeImapConnections, withImap, withMailbox } from "./imapClient";
import {
  isExcludedSearchFolder,
  mergeSearchHits,
  TAXONOMY_FOLDERS,
  textFromSource,
  type MailFull,
  type MailHead,
} from "./outlookMail";

/**
 * Direct IMAP/SMTP driver — the same surface as the Apple Mail driver in
 * ./outlookMail.ts (same function names, same argument shapes, same return types), over
 * the wire instead of over AppleScript. ./driver.ts picks between the two by the
 * account's transport, so nothing upstream knows which one it got.
 *
 * WHY THIS EXISTS: a second account was supposed to be a second Apple Mail account, and on
 * a headless mini it can't be. Mail's setup sheet is GUI-only and Screen Recording isn't
 * granted to the Peekaboo Bridge host, so automation drives that sheet blind; `profiles
 * install` (the scripted-account path) was removed in macOS 26; and Mail's own `make new
 * imap account` returns an account object that never persists to accountsd — a ghost that
 * vanishes on the next launch. A plain IMAP mailbox we can read ourselves, skipping the client.
 *
 * IDENTITY IS THE CONTRACT: everything is keyed on the RFC Message-ID with the angle
 * brackets stripped, exactly the form Apple Mail's `message id` reports. That's what lets
 * one poll-state seen-set, one retry ledger and one taxonomy work identically across both
 * transports. UIDs are never persisted — they're per-mailbox and change on a move.
 *
 * The taxonomy is literally the same list (imported, not copied): each canonical label
 * from System/Policies/email-labels.md is a folder, `moveToFolder` is label+archive in one step,
 * and Action mail stays in INBOX flagged.
 */

export { TAXONOMY_FOLDERS, type MailFull, type MailHead };
export { closeImapConnections };

const INBOX = "INBOX";
const BODY_CAP = 60_000;

/**
 * The names a server might give its Sent mailbox. Exchange says "Sent Items", most IMAP
 * servers say "Sent", and a caller asking for sent mail shouldn't have to know which —
 * so `sent` is a shorthand that resolves through the \Sent special-use flag first and
 * falls back to these names.
 */
const SENT_ALIASES = ["sent", "sent items", "sent mail", "sent messages"];

/**
 * Strip the angle brackets IMAP reports and Apple Mail doesn't. Both sides of the
 * system must agree on this: the poller's seen-set, the retry ledger and every tool
 * call key on the result, so `<abc@x>` and `abc@x` becoming two different messages
 * would re-triage everything forever.
 */
export function normalizeMessageId(raw: string): string {
  return (raw || "").trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Id for a message whose sender shipped it without a Message-ID header. Rare but real
 * (some mailers omit it), and dropping such a message would mean never triaging it.
 * The UID is stable per mailbox, and `locate` reads this form back directly — which is
 * also why a filed one has to be found by UID in the folder it was filed into.
 */
export function syntheticMessageId(uid: number, account: MailAccount): string {
  return `imap-uid-${uid}@${account.key}.fig`;
}

export function parseSyntheticUid(messageId: string, account: MailAccount): number {
  const m = normalizeMessageId(messageId).match(/^imap-uid-(\d+)@(.+)\.fig$/);
  return m && m[2] === account.key ? Number(m[1]) : 0;
}

function epochOf(value: Date | string | undefined): number {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Envelope + flags → the shared MailHead shape, sender formatted the way Mail reports it
 * ("Name <addr>"). Exported because this mapping IS the cross-transport contract — the
 * id it produces has to be byte-identical to the Apple Mail driver's for one seen-set
 * and one taxonomy to work across both.
 */
export function messageHead(msg: FetchMessageObject, account: MailAccount): MailHead {
  const env = msg.envelope;
  const from = env?.from?.[0];
  const sender = from ? (from.name ? `${from.name} <${from.address ?? ""}>` : from.address ?? "") : "";
  const messageId = normalizeMessageId(env?.messageId ?? "");
  return {
    messageId: messageId || syntheticMessageId(msg.uid, account),
    dateEpoch: epochOf(env?.date) || epochOf(msg.internalDate),
    read: Boolean(msg.flags?.has("\\Seen")),
    sender,
    subject: env?.subject ?? "",
  };
}

/** Mailbox paths that currently exist on the account (INBOX first). */
async function folderPaths(client: ImapFlow): Promise<string[]> {
  const boxes = await client.list();
  return boxes.map((b) => b.path);
}

/** The server's Drafts mailbox — its special-use flag if it has one, else the name. */
async function draftsPath(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === "\\Drafts");
  const named = boxes.find((b) => b.path.toLowerCase() === "drafts");
  return special?.path ?? named?.path ?? "Drafts";
}

/**
 * Where a message id lives right now: INBOX first, then the taxonomy folders (a message
 * we already filed) — the same search order as the Apple Mail driver's `findMessage`.
 * Only folders that actually exist are opened, so a fresh account doesn't pay eight
 * failed SELECTs per lookup.
 */
async function locate(client: ImapFlow, messageId: string, account: MailAccount): Promise<{ path: string; uid: number }> {
  const bare = normalizeMessageId(messageId);
  const syntheticUid = parseSyntheticUid(bare, account);
  const existing = new Set((await folderPaths(client)).map((p) => p.toLowerCase()));
  const candidates = [INBOX, ...TAXONOMY_FOLDERS].filter((p) => existing.has(p.toLowerCase()));
  for (const box of candidates) {
    const uid = await withMailbox(client, box, { readOnly: true }, async () => {
      if (syntheticUid) {
        const probe = await client.fetchOne(String(syntheticUid), { uid: true }, { uid: true });
        return probe ? syntheticUid : 0;
      }
      // Substring match on the header is how IMAP SEARCH works, so the bare id matches
      // the bracketed header. Newest wins if a duplicate was ever appended.
      const uids = await client.search({ header: { "message-id": bare } }, { uid: true });
      return Array.isArray(uids) && uids.length ? uids[uids.length - 1] : 0;
    });
    if (uid) return { path: box, uid };
  }
  throw new Error(`message not found: ${messageId}`);
}

/**
 * Newest `limit` inbox heads starting at `offset` (0-based from the newest). Sequence
 * numbers are oldest→newest on every IMAP server, so the newest window is the tail —
 * no direction sniffing needed (unlike Mail.app, whose ordering isn't guaranteed).
 */
export async function listInboxHeads(limit: number, offset = 0, account = primaryAccount()): Promise<MailHead[]> {
  return withImap(imapCreds(account), (client) =>
    withMailbox(client, INBOX, { readOnly: true }, async () => {
      const total = client.mailbox ? client.mailbox.exists : 0;
      if (!total) return [];
      const to = total - offset;
      if (to < 1) return [];
      const from = Math.max(1, to - limit + 1);
      const heads: MailHead[] = [];
      for await (const msg of client.fetch(`${from}:${to}`, { envelope: true, flags: true, internalDate: true })) {
        heads.push({ ...messageHead(msg, account), folder: INBOX });
      }
      return heads.reverse(); // fetch walks oldest→newest; callers want newest first
    }),
  );
}

/** Every mailbox name under the account. */
export async function listMailboxes(account = primaryAccount()): Promise<string[]> {
  return withImap(imapCreds(account), (client) => folderPaths(client));
}

/** Raw RFC822 source of a message (the MIME fallback, and what `getMessage` reads). */
export async function getSource(messageId: string, account = primaryAccount()): Promise<string> {
  return withImap(imapCreds(account), async (client) => {
    const { path: box, uid } = await locate(client, messageId, account);
    return withMailbox(client, box, { readOnly: true }, async () => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return msg && msg.source ? msg.source.toString("utf8") : "";
    });
  });
}

/** Attachment leaf nodes of a BODYSTRUCTURE — anything with a filename on it. */
function attachmentParts(node: MessageStructureObject | undefined, out: { part: string; filename: string }[] = []) {
  if (!node) return out;
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const isAttachment = node.disposition?.toLowerCase() === "attachment" || Boolean(filename);
  if (node.part && filename && isAttachment) out.push({ part: node.part, filename });
  for (const child of node.childNodes ?? []) attachmentParts(child, out);
  return out;
}

/** Full message by RFC message id: heads + body (+ attachment names). */
export async function getMessage(messageId: string, account = primaryAccount()): Promise<MailFull> {
  const full = await withImap(imapCreds(account), async (client) => {
    const { path: box, uid } = await locate(client, messageId, account);
    return withMailbox(client, box, { readOnly: true }, async () => {
      const msg = await client.fetchOne(
        String(uid),
        { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: true },
        { uid: true },
      );
      if (!msg) throw new Error(`message not found: ${messageId}`);
      return {
        head: messageHead(msg, account),
        source: msg.source ? msg.source.toString("utf8") : "",
        attachments: attachmentParts(msg.bodyStructure).map((a) => a.filename),
      };
    });
  });
  let text = textFromSource(full.source).trim();
  if (text.length > BODY_CAP) text = `${text.slice(0, BODY_CAP)}\n\n[... body truncated at ${BODY_CAP} chars]`;
  return { ...full.head, attachments: full.attachments, body: text };
}

/** Create `folder` under the account if it isn't there. Returns true when it made one. */
async function ensureFolder(client: ImapFlow, folder: string): Promise<boolean> {
  const existing = (await folderPaths(client)).map((p) => p.toLowerCase());
  if (existing.includes(folder.toLowerCase())) return false;
  try {
    await client.mailboxCreate(folder);
    return true;
  } catch (e) {
    // ALREADYEXISTS races (or a server that lists lazily) are not failures.
    if (/already exists/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

/**
 * Move a message into `folder`, creating the folder if it doesn't exist yet. This is the
 * archive-equivalent: the message leaves the Inbox, server-side, so it's gone from
 * webmail and every other client too.
 */
export async function moveToFolder(messageId: string, folder: string, account = primaryAccount()): Promise<void> {
  await withImap(imapCreds(account), async (client) => {
    const { path: box, uid } = await locate(client, messageId, account);
    if (box.toLowerCase() === folder.toLowerCase()) return; // already filed there
    await ensureFolder(client, folder);
    await withMailbox(client, box, {}, async () => {
      await client.messageMove(String(uid), folder, { uid: true });
    });
  });
}

/**
 * Create every taxonomy folder that's missing, and report what it made. `moveToFolder`
 * already creates on demand, so this is the deliberate first-run pass for a newly added
 * account — it answers "does the write path work?" before live mail depends on it.
 */
export async function ensureTaxonomyFolders(account = primaryAccount()): Promise<string[]> {
  return withImap(imapCreds(account), async (client) => {
    const created: string[] = [];
    for (const folder of TAXONOMY_FOLDERS) {
      if (await ensureFolder(client, folder)) created.push(folder);
    }
    return created;
  });
}

async function setFlag(messageId: string, flag: string, on: boolean, account: MailAccount): Promise<void> {
  await withImap(imapCreds(account), async (client) => {
    const { path: box, uid } = await locate(client, messageId, account);
    await withMailbox(client, box, {}, async () => {
      const range = String(uid);
      if (on) await client.messageFlagsAdd(range, [flag], { uid: true });
      else await client.messageFlagsRemove(range, [flag], { uid: true });
    });
  });
}

export async function setReadStatus(messageId: string, read: boolean, account = primaryAccount()): Promise<void> {
  await setFlag(messageId, "\\Seen", read, account);
}

export async function setFlagged(messageId: string, flagged: boolean, account = primaryAccount()): Promise<void> {
  await setFlag(messageId, "\\Flagged", flagged, account);
}

/** Save a message's attachments into `dir`; returns saved file paths. */
export async function saveAttachments(messageId: string, dir: string, account = primaryAccount()): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  return withImap(imapCreds(account), async (client) => {
    const { path: box, uid } = await locate(client, messageId, account);
    return withMailbox(client, box, { readOnly: true }, async () => {
      const msg = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
      const parts = msg ? attachmentParts(msg.bodyStructure) : [];
      if (!parts.length) return [];
      const downloaded = await client.downloadMany(String(uid), parts.map((p) => p.part), { uid: true });
      const saved: string[] = [];
      for (const { part, filename } of parts) {
        const content = downloaded[part]?.content;
        if (!content) continue;
        // The filename comes from the sender — never let it climb out of `dir`.
        const safe = path.basename(filename).replace(/[/\\]/g, "_") || `part-${part}`;
        const file = path.join(dir, safe);
        fs.writeFileSync(file, content);
        saved.push(file);
      }
      return saved;
    });
  });
}

/**
 * Which mailboxes a search walks. Named folders are honored as given (missing ones are
 * dropped rather than erroring); with none named it's EVERY selectable mailbox on the
 * account except Trash/Junk/Spam, Inbox first.
 *
 * "Everything" is the right default because the thing being searched for is usually mail
 * that triage already FILED — the folder it landed in is exactly what the caller doesn't
 * know. The server does the matching, so breadth here costs one SEARCH per mailbox on an
 * already-open connection, not a message walk.
 */
export async function searchableMailboxes(client: Pick<ImapFlow, "list">, folders?: string[]): Promise<string[]> {
  const boxes = await client.list();
  if (folders?.length) {
    const wanted = folders.map((f) => f.trim().toLowerCase()).filter(Boolean);
    return boxes.filter((b) => wanted.includes(b.path.toLowerCase())).map((b) => b.path);
  }
  const usable = boxes
    // \Noselect mailboxes are pure containers — SELECT on one is an error, not a result.
    .filter((b) => !b.flags?.has("\\Noselect"))
    .filter((b) => b.specialUse !== "\\Trash" && b.specialUse !== "\\Junk")
    .filter((b) => !isExcludedSearchFolder(b.name) && !isExcludedSearchFolder(b.path))
    .map((b) => b.path);
  return [
    ...usable.filter((p) => p.toUpperCase() === INBOX),
    ...usable.filter((p) => p.toUpperCase() !== INBOX),
  ];
}

/**
 * Full-content search across the account's folders: every term ANDed, case-insensitive,
 * matched against headers AND body, each hit tagged with the folder it lives in. Unlike
 * the Apple Mail path — which has to walk messages itself and budget how many bodies it
 * can afford to read — the server does the matching, so there's no scan cap and no
 * partial-coverage caveat. AND is an intersection of one SEARCH per term because IMAP's
 * TEXT key takes a single string.
 *
 * WHY IT ISN'T INBOX-ONLY ANY MORE: triage files inbound mail OUT of INBOX minutes after
 * it lands, so `{text: term}` inside INBOX structurally cannot see most of the mailbox: it
 * answers "no such email" for a message `get` returns in full by id, and a watch built on
 * that search says "nothing yet" forever.
 *
 * One connection, one mailbox at a time: withImap serializes per account anyway, so
 * looping here reuses the open session instead of paying a TLS handshake per folder.
 */
export async function searchInbox(
  query: string,
  limit = 25,
  account = primaryAccount(),
  folders?: string[],
): Promise<MailHead[]> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return withImap(imapCreds(account), async (client) => {
    const boxes = await searchableMailboxes(client, folders);
    const hits: MailHead[] = [];
    for (const box of boxes) {
      const found = await withMailbox(client, box, { readOnly: true }, async () => {
        let uids: number[] | null = null;
        for (const term of terms) {
          const matched = await client.search({ text: term }, { uid: true });
          const list = Array.isArray(matched) ? matched : [];
          uids = uids === null ? list : uids.filter((u) => list.includes(u));
          if (!uids.length) return [];
        }
        // UIDs ascend with arrival within a mailbox, so the tail is the newest window —
        // capped per folder so a hoarded Archive can't cost us a thousand-message fetch.
        const newest = (uids ?? []).sort((a, b) => a - b).slice(-limit);
        if (!newest.length) return [];
        const heads: MailHead[] = [];
        for await (const msg of client.fetch(newest, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          heads.push({ ...messageHead(msg, account), folder: box });
        }
        return heads;
      });
      hits.push(...found);
    }
    return mergeSearchHits(hits, limit); // newest first across folders, same as the Apple Mail driver
  });
}

interface DraftOptions {
  to: string;
  subject: string;
  body: string;
  replyToId?: string;
  cc?: string;
}

/** Headers that make a reply thread, pulled off the message being replied to. */
async function replyContext(
  client: ImapFlow,
  replyToId: string,
  account: MailAccount,
): Promise<{ to: string; subject: string; inReplyTo: string; references: string }> {
  const { path: box, uid } = await locate(client, replyToId, account);
  return withMailbox(client, box, { readOnly: true }, async () => {
    const msg = await client.fetchOne(String(uid), { envelope: true, headers: ["references"] }, { uid: true });
    if (!msg) throw new Error(`message not found: ${replyToId}`);
    const env = msg.envelope;
    const from = env?.replyTo?.[0] ?? env?.from?.[0];
    const subject = env?.subject ?? "";
    const original = `<${normalizeMessageId(env?.messageId ?? replyToId)}>`;
    const priorRefs = (msg.headers?.toString("utf8") ?? "").replace(/^references:\s*/i, "").replace(/\s+/g, " ").trim();
    return {
      to: from?.address ?? "",
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: original,
      references: [priorRefs, original].filter(Boolean).join(" "),
    };
  });
}

type ReplyContext = Awaited<ReturnType<typeof replyContext>>;

/** Compose the RFC822 bytes once — the draft APPENDs them, a send transmits them. */
async function composeRaw(opts: DraftOptions, reply: ReplyContext | null, from: string): Promise<{ raw: Buffer; to: string }> {
  const to = reply?.to || opts.to;
  if (!to.trim()) throw new Error("this message needs a recipient (`to`, or a replyToId whose sender we can read)");
  const raw = await new MailComposer({
    from,
    to,
    ...(opts.cc ? { cc: opts.cc } : {}),
    subject: reply?.subject || opts.subject,
    text: opts.body,
    ...(reply ? { inReplyTo: reply.inReplyTo, references: reply.references } : {}),
  })
    .compile()
    .build();
  return { raw, to };
}

/**
 * Create a DRAFT and APPEND it to the account's Drafts folder with the \Draft flag —
 * this NEVER sends. Same contract as the Apple Mail driver: outbound mail from the owner's
 * own accounts is theirs to press send on. It syncs, so the draft is waiting in webmail and
 * on their phone.
 *
 * Threading works properly here, which it doesn't on the AppleScript path: we compose
 * the message ourselves, so In-Reply-To and References are set from the original.
 */
export async function createDraft(opts: DraftOptions, account = primaryAccount()): Promise<{ ok: true; note: string }> {
  const creds = imapCreds(account);
  return withImap(creds, async (client) => {
    const reply = opts.replyToId ? await replyContext(client, opts.replyToId, account) : null;
    const { raw } = await composeRaw(opts, reply, creds.user);
    const box = await draftsPath(client);
    const appended = await client.append(box, raw, ["\\Draft"], new Date());
    if (!appended) throw new Error(`could not append the draft to "${box}" on ${account.label}`);
    return {
      ok: true as const,
      note:
        `Draft saved to the ${box} folder on ${account.label} (${creds.user})${reply ? ", threaded onto the original" : ""}. ` +
        `It syncs, so the owner can review and send it from webmail or their phone. Nothing was sent.`,
    };
  });
}

export interface SendOptions extends DraftOptions {
  /**
   * Must be exactly true. Sending as the owner is irreversible, so no caller reaches this by
   * forgetting an argument. It is NOT the human gate — that's the permission layer, which
   * asks the owner before mcp__outlook__send ever runs (src/runtimes/permissions.ts).
   */
  confirm: boolean;
}

/**
 * Send over SMTP as this account, and file a copy in Sent. GATED — see `confirm`, and
 * above it the approval the owner gives before the tool that calls this runs at all.
 * Drafting stays the default surface; this is what "yes, send it" actually does.
 */
export async function sendMail(opts: SendOptions, account = primaryAccount()): Promise<{ ok: true; messageId: string }> {
  if (opts.confirm !== true) {
    throw new Error(`refusing to send from ${account.key}: sendMail requires an explicit confirm: true`);
  }
  const creds = imapCreds(account);
  const reply = opts.replyToId
    ? await withImap(creds, (client) => replyContext(client, opts.replyToId as string, account))
    : null;
  const { raw, to } = await composeRaw(opts, reply, creds.user);
  const transporter = nodemailer.createTransport({
    host: creds.smtpHost,
    port: creds.smtpPort,
    secure: true, // implicit TLS on 465, verified against this server
    auth: { user: creds.user, pass: creds.password },
  });
  // `raw` (not the fields) so the bytes that go out are the bytes we file in Sent below.
  await transporter.sendMail({ envelope: { from: creds.user, to }, raw });
  const messageId = normalizeMessageId(raw.toString("utf8").match(/^message-id:\s*(.+)$/im)?.[1] ?? "");
  // SMTP files nothing: without this the sent mail exists nowhere the owner can see it.
  try {
    await withImap(creds, async (client) => {
      const boxes = await client.list();
      const sent = boxes.find((b) => b.specialUse === "\\Sent")?.path ?? boxes.find((b) => b.path === "Sent")?.path;
      if (sent) await client.append(sent, raw, ["\\Seen"], new Date());
    });
  } catch (e) {
    warn(`imap [${account.key}]: sent the message but couldn't copy it to Sent: ${e}`);
  }
  return { ok: true, messageId };
}

/**
 * Where a human goes to see this message. IMAP has no per-message deep link and this
 * account isn't in Mail.app (that's the whole reason this driver exists), so it's the
 * account's webmail root — callers word it as "opens webmail", not "opens the message".
 */
export function messageLink(_messageId: string, account = primaryAccount()): string {
  return imapCreds(account).webmailUrl;
}
