import path from "node:path";

import { z } from "zod";

import { config } from "../core/config";
import { defineServer, toSdkServer } from "../tools/define";
import { describeAccounts, getAccount, getAccounts, primaryAccount, type MailAccount } from "./accounts";
import * as mail from "./driver";

/**
 * In-process tools for the owner's non-Gmail accounts, as mcp__outlook__*. The
 * provider-specific write-back half of the seam: the triage BRAIN (the email-triage skill +
 * notify/label policies) is shared with gmail; only ingest (the poller) and these tools differ.
 *
 * The server is still named `outlook` even though it now drives every configured
 * account (see ./accounts.ts) — the tool NAMES are referenced by the vault's policies
 * and skills, so renaming them would silently break instructions living in a repo this
 * one can't edit. `account` is a param instead: omitted = the primary account.
 *
 * There is deliberately NO search here. It lived on this server as a second, non-Gmail-only
 * door onto the same question `mcp__mailsearch__find` answers across every backend, and the
 * narrower door is the one that gets opened by accident — its `account`/`folder` narrowing
 * moved onto `find` (see ./searchAll.ts) and this one is gone.
 *
 * Which TRANSPORT an account uses (Apple Mail over AppleScript vs direct IMAP) is
 * ./driver.ts's business, not the model's — every tool below takes the same `account`
 * key and gets the same shapes back either way.
 *
 * Neither Exchange nor IMAP has labels, so the canonical taxonomy from
 * System/Policies/email-labels.md maps to FOLDERS: `file` = label + archive in ONE move (the
 * message leaves the Inbox into its primary label's folder, created if missing, synced
 * server-side). Action + important Personal mail stays in the Inbox (never `file`
 * those) — exactly the gmail keep-in-INBOX behavior. There is deliberately no trash tool
 * at all. `send` routes a 🔐 to the owner in permissions.ts by TOOL NAME (and only works on an
 * account with SMTP); TRIAGE is denied it explicitly on top of that, so triage stays
 * read-and-organize only — see the provider's disallowedTools in ./triage.ts.
 */

/** Appended to every tool description so the model knows which keys are legal. */
const ACCOUNT_PARAM = `Optional account key — omit for ${primaryAccount().label}. Accounts: ${describeAccounts()}.`;

/**
 * Resolve the `account` param. An unknown key throws, and the throw is the right
 * answer: it names the valid keys back to the model, which then retries correctly —
 * far better than silently reading the wrong inbox and reporting "not found".
 */
const accountArg = { account: z.string().optional().describe(ACCOUNT_PARAM) };

/**
 * The accounts that actually have a send path (SMTP = imap transport), for the `send`
 * tool's description and for its refusal. Exchange over AppleScript has none, so naming
 * the ones that do is the difference between the model retrying correctly and it
 * concluding the owner can't send mail at all.
 */
function sendableAccounts(): string {
  const sendable = getAccounts().filter(mail.canSend);
  return sendable.length ? sendable.map((a) => `"${a.key}" (${a.accountName})`).join(", ") : "none of them";
}

/**
 * What `send` answers when the named account has no SMTP. Answering beats throwing: a raw
 * error reads to the model as "sending is broken" and it retries the same call, where this
 * names the account that would work. Its own function so a test can pin the wording
 * against a hand-built account, without depending on which accounts this machine has.
 */
export function cannotSendNote(account: MailAccount): string {
  return (
    `Can't send from ${account.label} — it's reached over ${mail.transportLabel(account)}, which has no ` +
    `programmatic send path. Accounts that can send: ${sendableAccounts()}. Either send from one of those ` +
    `(pass its account key) or use \`draft\` here, which saves to Drafts for the owner to send themselves. ` +
    `All accounts: ${describeAccounts()}.`
  );
}

export const outlookServerDef = defineServer({
  key: "outlook",
  kind: "direct",
  purpose: "the owner's non-Gmail accounts (school Exchange via Apple Mail, a personal domain over IMAP)",
  exposure: "both",
  capabilities: [
    {
      name: "get",
      purpose: "full headers + body of one message on a non-Gmail account",
      mutates: "read",
      description: `Get the full headers and body of one email in one of the owner's non-Gmail accounts by its message id, plus its attachment list and an open-it link. If the body comes back empty, retry once — Apple Mail can lag right after arrival. ${ACCOUNT_PARAM}`,
      input: { id: z.string().describe("RFC message id (from the poller / list)"), ...accountArg },
      handler: async (args) => {
        const account = getAccount(args.account);
        const m = await mail.getMessage(args.id, account);
        const atts = m.attachments.length ? m.attachments.join("; ") : "none";
        // The link only opens the exact message on an Apple Mail account; an IMAP one
        // has no per-message URL, so say so rather than let the brief promise it.
        const link = `${mail.messageLink(m.messageId, account)}${mail.linkOpensMessage(account) ? "" : " (opens webmail, not this message)"}`;
        return (
          `Account: ${account.label} (via ${mail.transportLabel(account)})\nFrom: ${m.sender}\nDate: ${new Date(m.dateEpoch * 1000).toISOString()}\n` +
          `Subject: ${m.subject}\nRead: ${m.read}\nMailLink: ${link}\nAttachments: ${atts}\n\n${m.body}`
        );
      },
    },
    {
      name: "save_attachments",
      purpose: "download a message's attachments so they can be Read",
      mutates: "write",
      description: `Download an email's attachments to disk and return their file paths. Then use Read on each path to actually read them (Read handles PDFs and images). ${ACCOUNT_PARAM}`,
      input: { id: z.string(), ...accountArg },
      handler: async (args) => {
        const account = getAccount(args.account);
        const dir = path.join(config.stateDir, "attachments", account.key, args.id.replace(/[^\w.@-]+/g, "_"));
        const saved = await mail.saveAttachments(args.id, dir, account);
        if (!saved.length) return "No attachments.";
        return saved.join("\n");
      },
    },
    {
      name: "folders",
      purpose: "list an account's mailboxes",
      mutates: "read",
      description: `List the folders (mailboxes) under one of the owner's non-Gmail accounts. The label taxonomy maps 1:1 to folders; missing ones are created automatically by \`file\`. ${ACCOUNT_PARAM}`,
      input: { ...accountArg },
      handler: async (args) => {
        const account = getAccount(args.account);
        const names = await mail.listMailboxes(account);
        return names.length ? names.join("\n") : `No folders visible on ${account.label} (account may still be syncing).`;
      },
    },
    {
      name: "file",
      purpose: "label + archive in one move — into the folder for a message's primary label",
      mutates: "write",
      description: `File an email: move it out of the Inbox into the folder for its PRIMARY label (folder = label name, created if missing, syncs server-side). This is label+archive in one step — a message lands in exactly ONE folder. Pick the primary label per System/Policies/email-labels.md: Reading > Waiting > the Type label (Receipts/Newsletters/Promos/Travel/Finance/Personal). NEVER file Action mail or important Personal mail — those stay in the Inbox (use \`flag\` for Action instead). ${ACCOUNT_PARAM}`,
      input: {
        id: z.string(),
        folder: z.enum(mail.TAXONOMY_FOLDERS).describe("primary label's folder"),
        ...accountArg,
      },
      handler: async (args) => {
        const account = getAccount(args.account);
        await mail.moveToFolder(args.id, args.folder, account);
        return `Filed ${args.id} → ${args.folder} on ${account.label} (out of Inbox).`;
      },
    },
    {
      name: "mark_read",
      purpose: "flip a message's read state",
      mutates: "write",
      description: `Mark an email read or unread. Noise mail (NO_NOTIFY) gets filed AND marked read. ${ACCOUNT_PARAM}`,
      input: { id: z.string(), read: z.boolean(), ...accountArg },
      handler: async (args) => {
        await mail.setReadStatus(args.id, args.read, getAccount(args.account));
        return `Marked ${args.id} ${args.read ? "read" : "unread"}.`;
      },
    },
    {
      name: "flag",
      purpose: "flag/unflag — the Action marker on accounts with no labels",
      mutates: "write",
      description: `Flag or unflag an email. Use flagged=true for Action mail (it stays in the Inbox; the flag is the Action marker, since there are no labels here). ${ACCOUNT_PARAM}`,
      input: { id: z.string(), flagged: z.boolean(), ...accountArg },
      handler: async (args) => {
        await mail.setFlagged(args.id, args.flagged, getAccount(args.account));
        return `${args.flagged ? "Flagged" : "Unflagged"} ${args.id}.`;
      },
    },
    {
      name: "draft",
      purpose: "save a reply/new email to an account's Drafts (never sends)",
      mutates: "write",
      description: `Create a DRAFT reply or new email in one of the owner's non-Gmail accounts. The draft is SAVED to that account's Drafts folder and NEVER sent — sending as the owner is their call, so they review and send it themselves. For a REPLY, pass replyToId (the original message's id) so it threads; for a NEW email, pass to + subject + body. The draft goes out from the account you name, so pick the one they should be writing FROM. ${ACCOUNT_PARAM}`,
      input: {
        to: z.string().optional().describe("recipient address (new email; a reply auto-uses the original sender)"),
        subject: z.string().optional().describe("subject (new email; a reply keeps the original's Re: subject)"),
        body: z.string().describe("the email body, written as real email content"),
        replyToId: z.string().optional().describe("RFC message id of the message being replied to (enables threading)"),
        cc: z.string().optional().describe("optional cc address (new emails only)"),
        ...accountArg,
      },
      handler: async (args) => {
        const r = await mail.createDraft(
          {
            to: args.to ?? "",
            subject: args.subject ?? "",
            body: args.body,
            ...(args.replyToId ? { replyToId: args.replyToId } : {}),
            ...(args.cc ? { cc: args.cc } : {}),
          },
          getAccount(args.account),
        );
        return r.note;
      },
    },
    {
      name: "send",
      purpose: "actually send as the owner from an account that has SMTP",
      mutates: "write",
      description: `SEND an email as the owner from one of their non-Gmail accounts — it actually goes out and cannot be unsent. The owner is asked to approve every send before it happens, so nothing leaves without them. DRAFTING IS STILL THE DEFAULT: use \`draft\` unless the owner explicitly said to send this one. Only accounts with an SMTP transport can send — right now that's ${sendableAccounts()}; the school Exchange account has no send path at all (draft there and the owner sends it themselves). Same shape as \`draft\`: for a REPLY pass replyToId so it threads; for a NEW email pass to + subject + body. It goes out FROM the account you name, so pick the address they should be writing from. ${ACCOUNT_PARAM}`,
      input: {
        to: z.string().optional().describe("recipient address (new email; a reply auto-uses the original sender)"),
        subject: z.string().optional().describe("subject (new email; a reply keeps the original's Re: subject)"),
        body: z.string().describe("the email body, written as real email content"),
        replyToId: z.string().optional().describe("RFC message id of the message being replied to (enables threading)"),
        cc: z.string().optional().describe("optional cc address (new emails only)"),
        ...accountArg,
      },
      handler: async (args) => {
        const account = getAccount(args.account);
        if (!mail.canSend(account)) return cannotSendNote(account);
        const r = await mail.sendMail(
          {
            to: args.to ?? "",
            subject: args.subject ?? "",
            body: args.body,
            ...(args.replyToId ? { replyToId: args.replyToId } : {}),
            ...(args.cc ? { cc: args.cc } : {}),
            // The tool supplies `confirm` because the human gate is NOT this flag — it's the
            // permission layer: mcp__outlook__send routes a 🔐 to the owner (see
            // src/runtimes/permissions.ts) and this handler never runs unless they approved.
            // The flag stays the driver's guard against a caller reaching sendMail by accident.
            confirm: true,
          },
          account,
        );
        return (
          `Sent from ${account.accountName}${args.replyToId ? " as a threaded reply" : ""}. Message id: ${r.messageId || "(none reported)"}. ` +
          `A copy is filed in that account's Sent folder.`
        );
      },
    },
  ],
});

export const outlookServer = toSdkServer(outlookServerDef);

/**
 * Tool allowlist for the Apple Mail triage subagent (mirrors EMAIL_AGENT_TOOLS' shape).
 *
 * The search entry is `mcp__mailsearch__find`, not an outlook tool: this server has no
 * search any more (see the header). Whoever mounts this list must mount `mailSearchServer`
 * alongside `outlookServer` — src/mail/triage.ts does.
 */
export const OUTLOOK_AGENT_TOOLS = [
  "mcp__outlook__get",
  "mcp__outlook__save_attachments",
  "mcp__outlook__folders",
  "mcp__outlook__file",
  "mcp__outlook__mark_read",
  "mcp__outlook__flag",
  "mcp__mailsearch__find",
  "mcp__outlook__draft",
  "mcp__outlook__send",
  "Read",
  "Write",
  "Edit",
  "Grep",
];
