import fs from "node:fs";

import { primaryAccount, type MailAccount } from "./accounts";
import { asQuote, runAppleScript } from "./applescript";

/**
 * Apple Mail driver — the `applemail` transport (see ./accounts.ts), today a school
 * Outlook (Exchange) mailbox with no API grant. Mail.app does its own auth,
 * so it IS the programmatic path: we read messages and write back (move/read/flag)
 * through the client via AppleScript, and folder changes sync server-side so they show
 * up in Outlook everywhere.
 *
 * The OTHER transport is ./imapAccount.ts, which speaks IMAP directly and exposes this
 * exact surface; ./driver.ts routes between them. That one exists because the mini is
 * headless and Mail.app can't be given a new account there at all — so "add it to Mail"
 * is not a fallback for an account this file can't reach.
 *
 * WHICH account is data, not a constant: every function here takes a MailAccount and
 * defaults to the primary one (see ./accounts.ts), so single-account callers written
 * before the registry keep addressing exactly the account they always did.
 *
 * Identity: we key everything on the RFC `message id` (globally unique, stable),
 * never Mail's per-mailbox integer id (which shifts as messages move).
 *
 * Gmail-labels → folders mapping (neither Exchange nor IMAP has labels): each
 * canonical label from System/Policies/email-labels.md maps to ONE same-named folder under
 * the account, and a message lands in exactly one folder (its primary label).
 * "Archive" = the move out of Inbox into that folder. Action + important Personal
 * mail never leaves the Inbox (that IS the gmail behavior: stays in INBOX).
 */

/**
 * The folder taxonomy mirrored from System/Policies/email-labels.md. Action has no folder
 * on purpose — Action mail stays in the Inbox (flagged instead), same as gmail
 * keeps it in INBOX. Folders are created on first use (create-if-missing).
 */
export const TAXONOMY_FOLDERS = [
  "Waiting",
  "Reading",
  "Receipts",
  "Newsletters",
  "Promos",
  "Travel",
  "Finance",
  "Personal",
] as const;

export interface MailHead {
  messageId: string; // RFC message id (stable across moves)
  dateEpoch: number; // date received, unix seconds
  read: boolean;
  sender: string; // "Name <addr>" as Mail reports it
  subject: string;
  /**
   * Which mailbox this head came out of. Search spans folders now, so "where does it live"
   * is part of the answer: triage files mail OUT of the Inbox, and a hit reported without
   * its folder reads as an Inbox message that isn't there any more.
   */
  folder?: string;
}

/** The Inbox's canonical name in a result — both drivers report it identically. */
export const INBOX_FOLDER = "INBOX";

/**
 * The Sent mailbox, whatever this server calls it. Exchange says "Sent Items", most IMAP
 * servers say "Sent"; both are tried and a missing one is skipped, so neither driver has
 * to know which server it's on.
 */
export const SENT_FOLDER_NAMES = ["Sent Items", "Sent"] as const;

/**
 * Mailboxes a keyword search skips unless the caller names them. Deleted and spam mail is
 * noise in a "find this email" answer, and Junk in particular is big and full of the
 * words recruiters use — it would crowd out the real hit.
 */
export function isExcludedSearchFolder(name: string): boolean {
  return /^(trash|deleted items|deleted messages|junk|junk e-?mail|spam|bulk mail)$/i.test(name.trim());
}

/**
 * Merge per-folder hits into one answer: newest first, one line per message, capped at
 * `limit`. Deduped by message id because a message can legitimately be listed twice — a
 * server that exposes both "Sent" and "Sent Items", or an alias mailbox — and the same
 * mail appearing twice reads as two messages.
 */
export function mergeSearchHits(hits: MailHead[], limit: number): MailHead[] {
  const seen = new Set<string>();
  return hits
    .slice()
    .sort((a, b) => b.dateEpoch - a.dateEpoch)
    .filter((h) => {
      if (seen.has(h.messageId)) return false;
      seen.add(h.messageId);
      return true;
    })
    .slice(0, limit);
}

export interface MailFull extends MailHead {
  body: string;
  attachments: string[]; // attachment file names
}

const FS = "\x1f"; // unit separator between fields (character id 31)
const RS = "\x1e"; // record separator between messages (character id 30)

/**
 * Shared script prolog: resolve the account and its inbox. Inboxes are named
 * "INBOX" or "Inbox" depending on the server; AppleScript string compares are
 * case-insensitive by default, but the direct `mailbox "Inbox"` fallback covers
 * scriptable-name quirks. Everything downstream uses theAcct/theInbox.
 *
 * The last-resort error names the account: on a freshly added account the usual
 * cause is that Mail hasn't finished its first sync (or the name in the registry
 * doesn't match the one in Mail's sidebar), and "can't get mailbox Inbox" alone
 * doesn't say which of the two it was.
 */
function prolog(account: MailAccount): string {
  return [
    `tell application "Mail"`,
    `set theAcct to account ${asQuote(account.accountName)}`,
    `set theInbox to missing value`,
    `try`,
    `set theInbox to first mailbox of theAcct whose name is "INBOX"`,
    `end try`,
    `if theInbox is missing value then`,
    `try`,
    `set theInbox to mailbox "Inbox" of theAcct`,
    `on error`,
    `error "no Inbox mailbox on Mail account " & ${asQuote(account.accountName)} & " (still syncing, or the account name doesn't match Mail's sidebar)"`,
    `end try`,
    `end if`,
    // Locale-proof epoch math: shell gives now-as-epoch, AppleScript gives
    // second-offsets between dates; epoch(d) = nowEpoch + (d - now).
    `set nowEpoch to (do shell script "date +%s") as number`,
    `set nowAS to current date`,
    `set fs to character id 31`,
    `set rs to character id 30`,
  ].join("\n");
}

/** Find-by-message-id snippet (inbox first, then the taxonomy folders — a message we already filed). */
function findMessage(messageId: string): string {
  const folderChecks = TAXONOMY_FOLDERS.map((f) =>
    [
      `if theMsg is missing value then`,
      `try`,
      `set theMsg to first message of (mailbox ${asQuote(f)} of theAcct) whose message id is ${asQuote(messageId)}`,
      `end try`,
      `end if`,
    ].join("\n"),
  ).join("\n");
  return [
    `set theMsg to missing value`,
    `try`,
    `set theMsg to first message of theInbox whose message id is ${asQuote(messageId)}`,
    `end try`,
    folderChecks,
    `if theMsg is missing value then error "message not found: " & ${asQuote(messageId)}`,
  ].join("\n");
}

/**
 * One record per message: id, epoch, read, sender, FOLDER, subject. Subject is last and
 * re-joined because it's the only free-text field — a stray separator inside it must not
 * shift every column after it, and folder sitting in front of it is what keeps that true.
 */
function parseHeads(raw: string): MailHead[] {
  if (!raw.trim()) return [];
  const heads: MailHead[] = [];
  for (const rec of raw.split(RS)) {
    if (!rec.trim()) continue;
    const [messageId, ep, read, sender, folder, ...rest] = rec.split(FS);
    if (!messageId?.trim()) continue;
    heads.push({
      messageId: messageId.trim(),
      dateEpoch: Number(ep) || 0,
      read: /^true$/i.test((read || "").trim()),
      sender: (sender || "").trim(),
      subject: rest.join(FS).trim(),
      folder: (folder || "").trim() || INBOX_FOLDER,
    });
  }
  return heads;
}

/** The record every script emits for a message — see parseHeads for the field order. */
function emitRecord(msgVar: string, folderExpr: string): string {
  return (
    `set outText to outText & (message id of ${msgVar}) & fs & ((ep div 1) as text) & fs & ` +
    `((read status of ${msgVar}) as text) & fs & (sender of ${msgVar}) & fs & ${folderExpr} & fs & (subject of ${msgVar}) & rs`
  );
}

/**
 * Newest `limit` inbox heads starting at `offset` (0-based from the newest).
 * Mail *usually* indexes message 1 = newest, but that isn't guaranteed, so the
 * script sniffs direction by comparing first/last dates and walks from the
 * newest end either way.
 */
export async function listInboxHeads(limit: number, offset = 0, account = primaryAccount()): Promise<MailHead[]> {
  const body = [
    prolog(account),
    `set total to count of messages of theInbox`,
    `if total is 0 then return ""`,
    `set newestFirst to true`,
    `if total > 1 then`,
    `if (date received of message total of theInbox) > (date received of message 1 of theInbox) then set newestFirst to false`,
    `end if`,
    `set fromK to ${offset + 1}`,
    `set toK to ${offset + limit}`,
    `if toK > total then set toK to total`,
    `set outText to ""`,
    `if fromK ≤ total then`,
    `repeat with k from fromK to toK`,
    `if newestFirst then`,
    `set idx to k`,
    `else`,
    `set idx to total - k + 1`,
    `end if`,
    `set m to message idx of theInbox`,
    `set ep to nowEpoch + ((date received of m) - nowAS)`,
    emitRecord("m", `"${INBOX_FOLDER}"`),
    `end repeat`,
    `end if`,
    `return outText`,
    `end tell`,
  ].join("\n");
  return parseHeads(await runAppleScript(body, { timeoutSec: 60 }));
}

/** Strip tags out of an HTML body — last-resort readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Minimal MIME text extraction from a raw RFC822 source — the fallback for when
 * AppleScript `content` comes back empty (it can, right after arrival or on odd
 * encodings). Prefers text/plain, falls back to de-tagged text/html.
 */
export function textFromSource(source: string): string {
  const headerEnd = source.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return "";
  const headers = source.slice(0, headerEnd);
  const rest = source.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
  const boundary = headers.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i)?.[1];

  const decodePart = (partHeaders: string, body: string): { type: string; text: string } => {
    const type = (partHeaders.match(/content-type\s*:\s*([\w/+.-]+)/i)?.[1] || "text/plain").toLowerCase();
    const enc = (partHeaders.match(/content-transfer-encoding\s*:\s*([\w-]+)/i)?.[1] || "").toLowerCase();
    let text = body;
    if (enc === "base64") {
      try {
        text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
      } catch {
        text = "";
      }
    } else if (enc === "quoted-printable") {
      // Decode to BYTES then utf8 — per-char fromCharCode would mangle multi-byte sequences.
      const s = body.replace(/=\r?\n/g, "");
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
          bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(s.charCodeAt(i) & 0xff);
      }
      text = Buffer.from(bytes).toString("utf8");
    }
    return { type, text };
  };

  if (!boundary) {
    const { type, text } = decodePart(headers, rest);
    return type.includes("html") ? htmlToText(text) : text.trim();
  }

  let plain = "";
  let html = "";
  for (const part of rest.split(`--${boundary}`)) {
    const pEnd = part.search(/\r?\n\r?\n/);
    if (pEnd < 0) continue;
    const pHeaders = part.slice(0, pEnd);
    const pBody = part.slice(pEnd).replace(/^\r?\n\r?\n/, "");
    // Nested multipart (multipart/alternative inside mixed): recurse.
    if (/content-type\s*:\s*multipart\//i.test(pHeaders)) {
      const nested = textFromSource(part.replace(/^\r?\n/, ""));
      if (nested && !plain) plain = nested;
      continue;
    }
    const { type, text } = decodePart(pHeaders, pBody);
    if (type === "text/plain" && !plain) plain = text.trim();
    if (type === "text/html" && !html) html = text;
  }
  return plain || htmlToText(html);
}

const BODY_CAP = 60_000;

/** Full message by RFC message id: heads + body (+ attachment names). */
export async function getMessage(messageId: string, account = primaryAccount()): Promise<MailFull> {
  const body = [
    prolog(account),
    findMessage(messageId),
    `set ep to nowEpoch + ((date received of theMsg) - nowAS)`,
    `set attNames to ""`,
    `try`,
    `repeat with a in mail attachments of theMsg`,
    `set attNames to attNames & (name of a) & rs`,
    `end repeat`,
    `end try`,
    `set bodyText to ""`,
    `try`,
    `set bodyText to content of theMsg`,
    `end try`,
    `return (message id of theMsg) & fs & ((ep div 1) as text) & fs & ((read status of theMsg) as text) & fs & (sender of theMsg) & fs & (subject of theMsg) & fs & attNames & fs & bodyText`,
    `end tell`,
  ].join("\n");
  const raw = await runAppleScript(body, { timeoutSec: 60 });
  const parts = raw.split(FS);
  const [mid, ep, read, sender, subject, attNames] = parts;
  let text = parts.slice(6).join(FS).trim();
  if (!text) {
    // `content` came back empty — pull the raw source and MIME-extract instead.
    text = textFromSource(await getSource(messageId, account)).trim();
  }
  if (text.length > BODY_CAP) text = `${text.slice(0, BODY_CAP)}\n\n[... body truncated at ${BODY_CAP} chars]`;
  return {
    messageId: (mid || messageId).trim(),
    dateEpoch: Number(ep) || 0,
    read: /^true$/i.test((read || "").trim()),
    sender: (sender || "").trim(),
    subject: (subject || "").trim(),
    attachments: (attNames || "").split(RS).map((s) => s.trim()).filter(Boolean),
    body: text,
  };
}

/** Raw RFC822 source of a message (for the MIME fallback). */
export async function getSource(messageId: string, account = primaryAccount()): Promise<string> {
  const body = [prolog(account), findMessage(messageId), `return source of theMsg`, `end tell`].join("\n");
  return runAppleScript(body, { timeoutSec: 60 });
}

/** Every mailbox name under the account. */
export async function listMailboxes(account = primaryAccount()): Promise<string[]> {
  const body = [
    prolog(account),
    `set names to name of every mailbox of theAcct`,
    `set AppleScript's text item delimiters to rs`,
    `return names as text`,
    `end tell`,
  ].join("\n");
  const raw = await runAppleScript(body, { timeoutSec: 60 });
  return raw.split(RS).map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve `folder` under theAcct into `target`, creating it if it isn't there yet.
 *
 * The wait loop is there because `make new mailbox` creates the folder on the SERVER and
 * Mail doesn't necessarily list it back in the same AppleEvent — so a brand-new account's
 * first `file` could create the folder and then fail to find it. Poll for it instead of
 * assuming, and if it never appears, say which folder on which account rather than dying
 * on `move theMsg to missing value`.
 */
function ensureFolder(folder: string, account: MailAccount): string {
  const resolve = `set target to first mailbox of theAcct whose name is ${asQuote(folder)}`;
  return [
    `set target to missing value`,
    `try`,
    resolve,
    `end try`,
    `if target is missing value then`,
    `try`,
    `make new mailbox at theAcct with properties {name:${asQuote(folder)}}`,
    `on error`,
    `try`,
    `tell theAcct to make new mailbox with properties {name:${asQuote(folder)}}`,
    `end try`,
    `end try`,
    `repeat 5 times`,
    `try`,
    resolve,
    `end try`,
    `if target is not missing value then exit repeat`,
    `delay 1`,
    `end repeat`,
    `end if`,
    `if target is missing value then error "could not create or find mailbox " & ${asQuote(folder)} & " on Mail account " & ${asQuote(account.accountName)}`,
  ].join("\n");
}

/**
 * Move a message into `folder` under its account, creating the folder if it doesn't
 * exist yet (it syncs server-side, so it appears in Outlook / webmail too). This is
 * the archive-equivalent: the message leaves the Inbox.
 */
export async function moveToFolder(messageId: string, folder: string, account = primaryAccount()): Promise<void> {
  const body = [
    prolog(account),
    findMessage(messageId),
    ensureFolder(folder, account),
    `move theMsg to target`,
    `end tell`,
  ].join("\n");
  await runAppleScript(body, { timeoutSec: 60 });
}

/**
 * Create every taxonomy folder that's missing on an account, and report what it made.
 * `file` already creates-on-demand, so this is not required — it's the deliberate
 * first-run pass for a newly added account (npm run outlook:test -- --ensure-folders),
 * which turns "did the write path work?" into an answer before live mail depends on it.
 */
export async function ensureTaxonomyFolders(account = primaryAccount()): Promise<string[]> {
  const created: string[] = [];
  for (const folder of TAXONOMY_FOLDERS) {
    const body = [
      prolog(account),
      `set existed to true`,
      `try`,
      `set probe to first mailbox of theAcct whose name is ${asQuote(folder)}`,
      `on error`,
      `set existed to false`,
      `end try`,
      ensureFolder(folder, account),
      `return (existed as text)`,
      `end tell`,
    ].join("\n");
    const existed = /^true$/i.test((await runAppleScript(body, { timeoutSec: 60 })).trim());
    if (!existed) created.push(folder);
  }
  return created;
}

export async function setReadStatus(messageId: string, read: boolean, account = primaryAccount()): Promise<void> {
  const body = [prolog(account), findMessage(messageId), `set read status of theMsg to ${read}`, `end tell`].join("\n");
  await runAppleScript(body, { timeoutSec: 60 });
}

export async function setFlagged(messageId: string, flagged: boolean, account = primaryAccount()): Promise<void> {
  const body = [prolog(account), findMessage(messageId), `set flagged status of theMsg to ${flagged}`, `end tell`].join("\n");
  await runAppleScript(body, { timeoutSec: 60 });
}

/** Save a message's attachments into `dir`; returns saved file paths. */
export async function saveAttachments(messageId: string, dir: string, account = primaryAccount()): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    prolog(account),
    findMessage(messageId),
    `set outText to ""`,
    `repeat with a in mail attachments of theMsg`,
    `set fname to name of a`,
    `set p to ${asQuote(dir.replace(/\/$/, ""))} & "/" & fname`,
    `try`,
    `save a in POSIX file p`,
    `set outText to outText & p & rs`,
    `end try`,
    `end repeat`,
    `return outText`,
    `end tell`,
  ].join("\n");
  const raw = await runAppleScript(body, { timeoutSec: 90 });
  return raw.split(RS).map((s) => s.trim()).filter(Boolean);
}

/**
 * The folders this driver searches when the caller names none: the Inbox, everywhere
 * triage FILES mail (the taxonomy), and Sent. Deliberately NOT "every mailbox on the
 * account" — see searchInbox's perf note. Sent is in because "what did I tell them" is
 * half of what a search is for.
 */
export function defaultSearchFolders(): string[] {
  return [INBOX_FOLDER, ...TAXONOMY_FOLDERS, ...SENT_FOLDER_NAMES];
}

/**
 * Full-content search across an account's folders. There's no server API here, so this
 * walks each mailbox newest-first (same direction-sniff as listInboxHeads) and tests each
 * message's subject + sender + body against the query terms (contains, case-insensitive,
 * ANDed across space-separated terms). Every hit carries the folder it was found in.
 *
 * WHY IT SPANS FOLDERS: triage moves mail OUT of the Inbox into its label's folder within
 * minutes of arrival, so an Inbox-only search answers "that email doesn't exist" for any
 * message more than a triage tick old — the search says "that email doesn't exist" about a
 * message `get` can pull in full by id.
 *
 * PERF (why this is shaped the way it is): reading a message's `content` over AppleScript
 * is the slow part — each pull is an AppleEvent that, on a synced Exchange mailbox, can take
 * a meaningful fraction of a second. The naive version pulled `content` for EVERY message
 * whose subject+sender didn't already cover every term, so a query for a name/topic that
 * doesn't appear in headers content-reads nearly all ~300 messages and blows the 90s
 * AppleScript timeout → osascript gets hard-killed at 100s → the whole email specialist
 * aborts with "(no answer)".
 *
 * So the cost stays in bounded budgets, and folder coverage is bought by SHRINKING them
 * rather than by multiplying the old ones by ten:
 *   - SUBJECT/SENDER scan reaches the newest `INBOX_SCAN_CAP` in the Inbox and the newest
 *     `FOLDER_SCAN_CAP` in each other folder — filed mail is filed BY date, so the recent
 *     window is where a searched-for message actually is.
 *   - CONTENT reads (the expensive part) share ONE `CONTENT_CAP` budget across every
 *     folder, spent in folder order, newest-first. Past it, messages match on
 *     subject+sender only.
 * The tradeoff is explicit: this is a recency-bounded search, not an index. A body-only
 * match on old mail in a rarely-touched folder can be missed here, where the IMAP driver
 * (server-side SEARCH, no scan budget at all) would find it.
 *
 * `folders` narrows the walk; omit it for defaultSearchFolders(). A folder that doesn't
 * exist on this account is skipped, not an error.
 */
export async function searchInbox(
  query: string,
  limit = 25,
  account = primaryAccount(),
  folders?: string[],
): Promise<MailHead[]> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const body = searchScript(terms, limit, account, folders);
  // Each folder collects up to `limit` on its own, so the merge (not the script) decides
  // what "newest" means across them — stopping the walk at `limit` overall would report
  // old Inbox hits and never reach a newer one sitting in Receipts.
  //
  // The window stays 90s despite the extra folders: the EXPENSIVE half (content reads) is
  // capped globally and unchanged, so only the cheap header scan grew. Growing it instead
  // would push a live search past the turn's own patience — and a search that times out
  // costs the whole answer rather than a few folders of it.
  return mergeSearchHits(parseHeads(await runAppleScript(body, { timeoutSec: 90 })), limit);
}

/**
 * The search script itself, separated from running it so the folder walk and its budgets
 * can be asserted without an osascript (and without a Mac with the owner's mail on it).
 */
export function searchScript(terms: string[], limit: number, account: MailAccount, folders?: string[]): string {
  const termList = `{${terms.map(asQuote).join(", ")}}`;
  const wanted = folders?.length ? folders : defaultSearchFolders();
  const INBOX_SCAN_CAP = 300; // cheap subject/sender scan reaches this many newest inbox messages
  const FOLDER_SCAN_CAP = 80; // …and this many in each filed-mail folder
  const CONTENT_CAP = 40; // hard ceiling on expensive body reads, SHARED across folders
  // theInbox is already resolved (and name-sniffed) by the prolog; the rest are resolved by
  // name inside a `try` so a folder this account never created just doesn't get walked.
  const boxSetup = wanted.map((f) =>
    f.toUpperCase() === INBOX_FOLDER
      ? `set end of boxList to {theInbox, "${INBOX_FOLDER}"}`
      : [`try`, `set end of boxList to {mailbox ${asQuote(f)} of theAcct, ${asQuote(f)}}`, `end try`].join("\n"),
  );
  return [
    prolog(account),
    `set termList to ${termList}`,
    `set boxList to {}`,
    ...boxSetup,
    `set outText to ""`,
    `set contentUsed to 0`,
    `repeat with bx in boxList`,
    `set mbox to item 1 of (contents of bx)`,
    `set boxName to item 2 of (contents of bx)`,
    `set total to count of messages of mbox`,
    `if total > 0 then`,
    `set scanCap to ${FOLDER_SCAN_CAP}`,
    `if boxName is "${INBOX_FOLDER}" then set scanCap to ${INBOX_SCAN_CAP}`,
    `set newestFirst to true`,
    `if total > 1 then`,
    `if (date received of message total of mbox) > (date received of message 1 of mbox) then set newestFirst to false`,
    `end if`,
    `set found to 0`,
    `set k to 1`,
    `repeat while k ≤ total and k ≤ scanCap and found < ${limit}`,
    `if newestFirst then`,
    `set idx to k`,
    `else`,
    `set idx to total - k + 1`,
    `end if`,
    `set m to message idx of mbox`,
    `set hay to (subject of m) & " " & (sender of m)`,
    // Only pay for `content` (the slow part) when subject+sender don't already cover
    // every term AND the shared budget still has room. Past the budget, this message
    // is matched on subject+sender only — the bound that keeps us under the timeout.
    `set needContent to false`,
    `ignoring case`,
    `repeat with t in termList`,
    `if hay does not contain (contents of t) then set needContent to true`,
    `end repeat`,
    `end ignoring`,
    `if needContent and contentUsed < ${CONTENT_CAP} then`,
    `set contentUsed to contentUsed + 1`,
    `try`,
    `set hay to hay & " " & (content of m)`,
    `end try`,
    `end if`,
    `set matchAll to true`,
    `ignoring case`,
    `repeat with t in termList`,
    `if hay does not contain (contents of t) then set matchAll to false`,
    `end repeat`,
    `end ignoring`,
    `if matchAll then`,
    `set ep to nowEpoch + ((date received of m) - nowAS)`,
    emitRecord("m", "boxName"),
    `set found to found + 1`,
    `end if`,
    `set k to k + 1`,
    `end repeat`,
    `end if`,
    `end repeat`,
    `return outText`,
    `end tell`,
  ].join("\n");
}

/**
 * Create a DRAFT in Mail.app on the given account and SAVE it to Drafts — this NEVER
 * sends. That's a design decision, not a limitation: outbound mail from the owner's own
 * accounts is theirs to press send on, so every account here is draft-only.
 *
 * Threading caveat: Mail's AppleScript surface can't set arbitrary In-Reply-To /
 * References headers, so proper threading only happens via the `reply` command path.
 * When `replyToId` is given we `reply` to the original (Mail sets the threading headers
 * and Re: subject itself) and overwrite the reply's content with our body. If `reply`
 * comes back unusable headless (returns missing value), we fall back to a fresh
 * `Re: <subject>` outgoing message to the original sender — which drafts fine but won't
 * thread. A from-scratch draft (no replyToId) never threads.
 */
export async function createDraft(
  opts: {
    to: string;
    subject: string;
    body: string;
    replyToId?: string;
    cc?: string;
  },
  account = primaryAccount(),
): Promise<{ ok: true; note: string }> {
  let script: string;
  if (opts.replyToId) {
    script = [
      prolog(account),
      findMessage(opts.replyToId),
      `set origSubject to subject of theMsg`,
      `set origSender to sender of theMsg`,
      `set acctAddr to ""`,
      `try`,
      `set acctAddr to item 1 of (email addresses of theAcct)`,
      `end try`,
      `set theReply to missing value`,
      `try`,
      `set theReply to reply theMsg opening window false`,
      `end try`,
      `if theReply is not missing value then`,
      `set content of theReply to ${asQuote(opts.body)}`,
      `try`,
      `set visible of theReply to false`,
      `end try`,
      `save theReply`,
      `return "reply"`,
      `else`,
      // Fallback: fresh Re: to the original sender. Drafts, but won't thread.
      `set newMsg to make new outgoing message with properties {subject:("Re: " & origSubject), content:${asQuote(opts.body)}, visible:false}`,
      `tell newMsg`,
      `make new to recipient at end of to recipients with properties {address:origSender}`,
      `end tell`,
      `if acctAddr is not "" then set sender of newMsg to acctAddr`,
      `save newMsg`,
      `return "fallback"`,
      `end if`,
      `end tell`,
    ].join("\n");
  } else {
    const ccLines = opts.cc
      ? [`make new cc recipient at end of cc recipients with properties {address:${asQuote(opts.cc)}}`]
      : [];
    script = [
      prolog(account),
      `set acctAddr to ""`,
      `try`,
      `set acctAddr to item 1 of (email addresses of theAcct)`,
      `end try`,
      `set newMsg to make new outgoing message with properties {subject:${asQuote(opts.subject)}, content:${asQuote(opts.body)}, visible:false}`,
      `tell newMsg`,
      `make new to recipient at end of to recipients with properties {address:${asQuote(opts.to)}}`,
      ...ccLines,
      `end tell`,
      // Send from THIS account (matches sender by address), then save to Drafts.
      `if acctAddr is not "" then set sender of newMsg to acctAddr`,
      `save newMsg`,
      `return "new"`,
      `end tell`,
    ].join("\n");
  }
  const mode = (await runAppleScript(script, { timeoutSec: 60 })).trim();
  const threadNote =
    mode === "fallback"
      ? " (couldn't thread the reply headless, so it drafted as a fresh Re: — may start a new thread)"
      : "";
  return {
    ok: true,
    note: `Draft saved to Apple Mail Drafts (${account.label}).${threadNote} The owner opens Mail.app → Drafts to review and send.`,
  };
}

/**
 * Mail.app deep link that opens this exact message on the Mac. Account-independent
 * on purpose: the RFC message id is globally unique, so Mail finds it wherever it is.
 */
export function messageLink(messageId: string): string {
  return `message://%3C${encodeURIComponent(messageId)}%3E`;
}
