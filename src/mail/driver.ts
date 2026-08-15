import { primaryAccount, type MailAccount } from "./accounts";
import { isTransientOsaError } from "./applescript";
import { isTransientImapError } from "./imapClient";
import * as imap from "./imapAccount";
import * as applemail from "./outlookMail";

/**
 * One mail surface, two transports. Every caller (the poller, the MCP tools, triage)
 * goes through here and passes a MailAccount; this file picks the driver by
 * `account.transport` and nothing upstream branches on it.
 *
 * The two implementations are deliberately NOT abstracted into an interface with a
 * factory — they're plain modules with identical exported functions (./outlookMail.ts
 * over AppleScript, ./imapAccount.ts over IMAP), and this is the seam. That keeps each
 * driver readable on its own, and makes a signature drift between them a typecheck
 * failure right here rather than a runtime surprise on one account.
 */

export const TAXONOMY_FOLDERS = applemail.TAXONOMY_FOLDERS;
export type MailHead = applemail.MailHead;
export type MailFull = applemail.MailFull;

function isImap(account: MailAccount): boolean {
  return account.transport === "imap";
}

export function listInboxHeads(limit: number, offset = 0, account = primaryAccount()): Promise<MailHead[]> {
  return isImap(account) ? imap.listInboxHeads(limit, offset, account) : applemail.listInboxHeads(limit, offset, account);
}

export function getMessage(messageId: string, account = primaryAccount()): Promise<MailFull> {
  return isImap(account) ? imap.getMessage(messageId, account) : applemail.getMessage(messageId, account);
}

export function getSource(messageId: string, account = primaryAccount()): Promise<string> {
  return isImap(account) ? imap.getSource(messageId, account) : applemail.getSource(messageId, account);
}

export function listMailboxes(account = primaryAccount()): Promise<string[]> {
  return isImap(account) ? imap.listMailboxes(account) : applemail.listMailboxes(account);
}

export function moveToFolder(messageId: string, folder: string, account = primaryAccount()): Promise<void> {
  return isImap(account) ? imap.moveToFolder(messageId, folder, account) : applemail.moveToFolder(messageId, folder, account);
}

export function ensureTaxonomyFolders(account = primaryAccount()): Promise<string[]> {
  return isImap(account) ? imap.ensureTaxonomyFolders(account) : applemail.ensureTaxonomyFolders(account);
}

export function setReadStatus(messageId: string, read: boolean, account = primaryAccount()): Promise<void> {
  return isImap(account) ? imap.setReadStatus(messageId, read, account) : applemail.setReadStatus(messageId, read, account);
}

export function setFlagged(messageId: string, flagged: boolean, account = primaryAccount()): Promise<void> {
  return isImap(account) ? imap.setFlagged(messageId, flagged, account) : applemail.setFlagged(messageId, flagged, account);
}

export function saveAttachments(messageId: string, dir: string, account = primaryAccount()): Promise<string[]> {
  return isImap(account) ? imap.saveAttachments(messageId, dir, account) : applemail.saveAttachments(messageId, dir, account);
}

/**
 * Keyword search across the account's FOLDERS, not just its Inbox — omit `folders` for
 * each driver's default breadth (imap: every selectable mailbox bar Trash/Junk; Apple
 * Mail: Inbox + the taxonomy + Sent, because there the scan is ours to pay for). Every
 * hit carries the folder it was found in.
 *
 * Inbox-only was a silent lie: triage files mail out of the Inbox within minutes, so the
 * search could not see the mail the caller was asking about, and answered "no such
 * message" for one `get` could read in full by id.
 */
export function searchInbox(query: string, limit = 25, account = primaryAccount(), folders?: string[]): Promise<MailHead[]> {
  return isImap(account) ? imap.searchInbox(query, limit, account, folders) : applemail.searchInbox(query, limit, account, folders);
}

export function createDraft(
  opts: { to: string; subject: string; body: string; replyToId?: string; cc?: string },
  account = primaryAccount(),
): Promise<{ ok: true; note: string }> {
  return isImap(account) ? imap.createDraft(opts, account) : applemail.createDraft(opts, account);
}

/**
 * SEND as this account, over SMTP. Only an `imap`-transport account has a send path:
 * Exchange is reached by driving Mail.app over AppleScript, which has no programmatic
 * send — so that branch throws by name instead of half-working.
 *
 * This is the one deliberate hole in the "identical exported functions on both modules"
 * invariant above: ./outlookMail.ts has no `sendMail` at all, and a throwing stub over
 * there would read like a driver that might one day work. The refusal lives HERE, where
 * the transport is already the thing being decided.
 */
export function sendMail(opts: imap.SendOptions, account = primaryAccount()): Promise<{ ok: true; messageId: string }> {
  if (!isImap(account)) {
    throw new Error(
      `mail account "${account.key}" (${account.label}) cannot send: it is reached over Apple Mail/AppleScript, ` +
        `which has no programmatic send path — only imap-transport accounts have SMTP. Create a draft instead.`,
    );
  }
  return imap.sendMail(opts, account);
}

/** True when this account can actually send — so callers can ask instead of catching. */
export function canSend(account: MailAccount): boolean {
  return isImap(account);
}

/**
 * The "open this message" link. Apple Mail accounts get the `message://` deep link that
 * opens the exact message on the Mac; an imap account isn't in Mail.app at all, so it
 * gets its webmail root instead. Callers must not promise it opens the message.
 */
export function messageLink(messageId: string, account = primaryAccount()): string {
  return isImap(account) ? imap.messageLink(messageId, account) : applemail.messageLink(messageId);
}

/** True when a link opens the message itself rather than just the mailbox. */
export function linkOpensMessage(account: MailAccount): boolean {
  return !isImap(account);
}

/**
 * "The transport hiccuped" for either driver — Mail.app mid-sync, or a dropped socket.
 * The poll loop backs off quietly on these instead of reporting a failure.
 */
export function isTransientMailError(account: MailAccount, message: string): boolean {
  return isImap(account) ? isTransientImapError(message) : isTransientOsaError(message);
}

/** How to describe this account's plumbing in a log line or a prompt. */
export function transportLabel(account: MailAccount): string {
  return isImap(account) ? `IMAP (${account.imap?.host})` : "Apple Mail";
}
