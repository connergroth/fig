import path from "node:path";

import { z } from "zod";

import { config } from "../core/config";
import { defineServer, toSdkServer } from "../tools/define";
import * as gmail from "./gmail";

/**
 * Gmail, as mcp__gmail__*. `send`, `send_draft` and `trash` route a 🔐 to the owner in
 * permissions.ts — by TOOL NAME, so the gate holds in every lane and in the triage
 * sub-queries that mount this server directly (google/triage.ts).
 *
 * fig calls these HERSELF. They used to sit behind the `mcp__email__ask` specialist, which
 * handed back PROSE — the failure that made it worth deleting: a subagent reported "no CTC
 * message has ever arrived" when the truth was "25 hits, none matching" from an INBOX-only
 * search, and fig relayed the false negative. Raw tool output can be re-read; a summary can't.
 */
export const gmailServerDef = defineServer({
  key: "gmail",
  kind: "direct",
  purpose: "the owner's connected Gmail accounts: read, search, label, archive, draft, send",
  exposure: "both",
  capabilities: [
    {
      name: "accounts",
      purpose: "list the connected Google accounts and their addresses",
      mutates: "read",
      description:
        "List the connected Gmail accounts (their labels + addresses). Search and triage already cover ALL of them automatically — you only need this if you want to name an account, or to send/compose from a specific one.",
      input: {},
      handler: async () => {
        const accounts = gmail.googleAccounts();
        if (!accounts.length) return "No Gmail accounts configured.";
        const lines = await Promise.all(
          accounts.map(async (a) => {
            const email = await gmail.accountEmail(a.label).catch(() => "?");
            return `${a.label} — ${email}${a.label === gmail.primaryLabel() ? " (primary)" : ""}`;
          }),
        );
        return lines.join("\n");
      },
    },
    {
      name: "list",
      purpose: "list/search gmail across every connected account",
      mutates: "read",
      description:
        "List or search recent emails across ALL connected GMAIL accounts by default (you don't need to know which gmail inbox a message is in — this finds it). Pass a Gmail search query to filter (e.g. 'is:unread in:inbox', 'from:foo@bar.com', 'newer_than:2d'). For a time window use newer_than:/older_than: (2d, 3w, 1m) — after:/before: with an epoch or an ambiguous date silently returns the WRONG YEAR's mail, which reads as a real result. Returns one line per message: [account] id | read-state | from | subject | snippet. Use that [account] when the owner asks about a specific one; otherwise leave it off. This is GMAIL ONLY: to find a message that might be on the school or personal-domain account, use mcp__mailsearch__find, which covers gmail AND those accounts AND their folders in one call.",
      input: {
        query: z.string().optional().describe("Gmail search query"),
        max: z.number().optional().describe("Max results, default 15"),
        account: z.string().optional().describe("restrict to one account label; omit to search ALL accounts (the default)"),
      },
      handler: async (args) => {
        const msgs = args.account
          ? await gmail.listMessages({ query: args.query, max: args.max, account: args.account })
          : await gmail.listMessagesAll({ query: args.query, max: args.max });
        if (!msgs.length) return "No messages.";
        return msgs
          .map((m) => `[${m.account}] ${m.id} | ${m.unread ? "UNREAD" : "read"} | ${m.from} | ${m.subject} | ${m.snippet}`)
          .join("\n");
      },
    },
    {
      name: "get",
      purpose: "full headers + body of one message by id",
      mutates: "read",
      description:
        "Get the full, untruncated headers and body of one email by id, plus its attachment list and a Gmail link. The id's account is resolved automatically; the output shows which account it's in.",
      input: { id: z.string() },
      handler: async (args) => {
        const m = await gmail.getMessage(args.id);
        const atts = m.attachments.length
          ? m.attachments.map((a) => `${a.filename} (${a.mimeType}, ${a.size}b)`).join("; ")
          : "none";
        return (
          `Account: ${m.account}\nFrom: ${m.from}\nTo: ${m.to}\nCc: ${m.cc}\nDate: ${m.date}\nSubject: ${m.subject}\n` +
          `Labels: ${m.labels.join(", ")}\nThreadId: ${m.threadId}\nGmailLink: ${m.webUrl}\n` +
          `Attachments: ${atts}\n\n${m.body}`
        );
      },
    },
    {
      name: "save_attachments",
      purpose: "download a message's attachments so they can be Read",
      mutates: "write",
      description:
        "Download an email's attachments to disk and return their file paths. Then use Read on each path to actually read them (Read handles PDFs and images). Use this whenever an email has attachments you need to understand.",
      input: { id: z.string() },
      handler: async (args) => {
        const dir = path.join(config.stateDir, "attachments", args.id);
        const saved = await gmail.saveAttachments(args.id, dir);
        if (!saved.length) return "No attachments.";
        return saved.map((s) => `${s.filename} (${s.mimeType}) -> ${s.path}`).join("\n");
      },
    },
    {
      name: "labels",
      purpose: "list an account's labels",
      mutates: "read",
      description: "List all Gmail labels for an account (omit account for the primary).",
      input: { account: z.string().optional() },
      handler: async (args) => {
        const labels = await gmail.listLabels(args.account);
        return labels.map((l) => l.name).join("\n");
      },
    },
    {
      name: "label",
      purpose: "add/remove labels on a message",
      mutates: "write",
      description:
        "Add and/or remove labels on an email. Label names are created if they don't exist. Use system names like INBOX, STARRED, IMPORTANT, or CATEGORY_SOCIAL/CATEGORY_PROMOTIONS to move between tabs.",
      input: {
        id: z.string(),
        add: z.array(z.string()).optional().describe("Label names to add"),
        remove: z.array(z.string()).optional().describe("Label names to remove"),
      },
      handler: async (args) => {
        await gmail.modifyLabels(args.id, args.add ?? [], args.remove ?? []);
        return `Updated labels on ${args.id}.`;
      },
    },
    {
      name: "archive",
      purpose: "take a message out of the inbox",
      mutates: "write",
      description: "Archive an email (remove it from the inbox).",
      input: { id: z.string() },
      handler: async (args) => {
        await gmail.modifyLabels(args.id, [], ["INBOX"]);
        return `Archived ${args.id}.`;
      },
    },
    {
      name: "mark_read",
      purpose: "flip a message's read state",
      mutates: "write",
      description: "Mark an email read or unread.",
      input: { id: z.string(), read: z.boolean() },
      handler: async (args) => {
        await gmail.modifyLabels(args.id, args.read ? [] : ["UNREAD"], args.read ? ["UNREAD"] : []);
        return `Marked ${args.id} ${args.read ? "read" : "unread"}.`;
      },
    },
    {
      name: "create_label",
      purpose: "add a label to the taxonomy",
      mutates: "write",
      description:
        "Create a new label (idempotent). Only do this when adding to the canonical taxonomy in email-labels.md. Defaults to the primary account; pass account to create it in another.",
      input: { name: z.string(), account: z.string().optional() },
      handler: async (args) => {
        await gmail.createLabel(args.name, args.account);
        return `Label "${args.name}" exists.`;
      },
    },
    {
      name: "rename_label",
      purpose: "rename a label",
      mutates: "write",
      description: "Rename an existing label. Keep email-labels.md in sync.",
      input: { from: z.string(), to: z.string(), account: z.string().optional() },
      handler: async (args) => {
        await gmail.renameLabel(args.from, args.to, args.account);
        return `Renamed "${args.from}" to "${args.to}".`;
      },
    },
    {
      name: "delete_label",
      purpose: "remove a label from the taxonomy",
      mutates: "write",
      description: "Delete a label (the messages stay, they just lose the label). Use when cleaning up the taxonomy.",
      input: { name: z.string(), account: z.string().optional() },
      handler: async (args) => {
        await gmail.deleteLabel(args.name, args.account);
        return `Deleted label "${args.name}".`;
      },
    },
    {
      name: "trash",
      purpose: "move a message to Trash",
      mutates: "write",
      description: "Move an email to Trash (recoverable 30 days). Destructive, so the owner is asked to approve.",
      input: { id: z.string() },
      handler: async (args) => {
        await gmail.trashMessage(args.id);
        return `Trashed ${args.id}.`;
      },
    },
    {
      name: "draft",
      purpose: "save a draft (never sends)",
      mutates: "write",
      description:
        "Create a draft email. Does NOT send. Pass thread_id to draft a reply within an existing thread. When replying, set account to the SAME account the original is in (shown by get/list); for a brand-new email it defaults to the primary.",
      input: {
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        thread_id: z.string().optional(),
        cc: z.string().optional(),
        account: z.string().optional().describe("which account to compose from (default primary; for a reply, match the original's account)"),
      },
      handler: async (args) => {
        const id = await gmail.createDraft({
          to: args.to,
          subject: args.subject,
          body: args.body,
          threadId: args.thread_id,
          cc: args.cc,
          account: args.account,
        });
        return `Draft created (${id}) in ${args.account ?? gmail.primaryLabel()}.`;
      },
    },
    {
      name: "update_draft",
      purpose: "overwrite an existing draft in place",
      mutates: "write",
      description:
        "Overwrite an existing draft in place (same draft id) with revised content. Use this for the refine loop instead of creating a new draft, so edits don't pile up and the draft id the owner is previewing stays stable. Pass the SAME account the draft is in.",
      input: {
        draft_id: z.string().describe("id of the draft to overwrite (from the draft tool's result)"),
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        thread_id: z.string().optional(),
        cc: z.string().optional(),
        account: z.string().optional().describe("the account the draft is in (must match the original draft)"),
      },
      handler: async (args) => {
        const id = await gmail.updateDraft(args.draft_id, {
          to: args.to,
          subject: args.subject,
          body: args.body,
          threadId: args.thread_id,
          cc: args.cc,
          account: args.account,
        });
        return `Draft updated (${id}) in ${args.account ?? gmail.primaryLabel()}.`;
      },
    },
    {
      name: "send_draft",
      purpose: "send a saved draft by id",
      mutates: "write",
      description:
        "Send an already-saved draft by its id — dispatches exactly what's stored, so it sends precisely what the owner approved. Outward-facing, so the owner is asked to approve first. Prefer this over `send` once a draft exists. Pass the SAME account the draft is in.",
      input: {
        draft_id: z.string().describe("id of the draft to send (from the draft/update_draft result)"),
        account: z.string().optional().describe("the account the draft is in (must match the draft)"),
      },
      handler: async (args) => {
        const id = await gmail.sendDraft(args.draft_id, args.account ?? gmail.primaryLabel());
        return `Sent (${id}) from ${args.account ?? gmail.primaryLabel()}.`;
      },
    },
    {
      name: "send",
      purpose: "send an email immediately",
      mutates: "write",
      description:
        "Send an email immediately. Outward-facing, so the owner is asked to approve before it goes out. Prefer draft unless told to send. When replying, set account to the SAME account the original is in; for a brand-new email it defaults to the primary.",
      input: {
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        thread_id: z.string().optional(),
        cc: z.string().optional(),
        account: z.string().optional().describe("which account to send from (default primary; for a reply, match the original's account)"),
      },
      handler: async (args) => {
        const id = await gmail.sendMessage({
          to: args.to,
          subject: args.subject,
          body: args.body,
          threadId: args.thread_id,
          cc: args.cc,
          account: args.account,
        });
        return `Sent (${id}) from ${args.account ?? gmail.primaryLabel()}.`;
      },
    },
  ],
});

export const gmailServer = toSdkServer(gmailServerDef);
