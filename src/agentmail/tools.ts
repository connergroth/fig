import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { config } from "../core/config";
import { text } from "../core/toolResult";
import { defineServer, toSdkServer } from "../tools/define";
import {
  agentmailConfigured,
  createInbox,
  getMessage,
  listInboxes,
  listMessages,
  renderMessage,
  sendMessage,
  summarizeMessage,
  waitForMessage,
} from "./client";

const NOT_CONFIGURED =
  "fig's own email (AgentMail) isn't set up. Tell the owner to set AGENTMAIL_API_KEY (get a key at agentmail.to).";
const NO_ADDRESS =
  "No inbox given and fig has no persistent address set (AGENTMAIL_ADDRESS). Pass an address explicitly — enumerating inboxes is the browse specialist's job (list_inboxes lives there, not in main context).";

/** The address to act on: the one passed, else fig's persistent primary (config). */
const resolveAddress = (passed?: string) => passed?.trim() || config.agentmailAddress;

/**
 * fig's own email — AgentMail. fig's address(es), NOT the owner's Gmail (that's the email
 * specialist). The full toolset lives in the BROWSER specialist, where the real work
 * happens: spin up a burner, drop the address into a signup form, then wait for and read
 * the verification code/magic link back. The orchestrator gets only the read-only inbox
 * tools below (agentmailInboxServer), so fig can glance at what arrived without the heavy
 * agentic tools loading into the main context every turn.
 *
 * Creating inboxes and reading mail are free (so signups don't pester the owner); sending an
 * email outward routes a 🔐 confirmation to them (see permissions.ts).
 */

// --- Read-only inbox tools (shared with the orchestrator) ---

const listInboxesTool = tool(
  "list_inboxes",
  "List fig's existing email addresses (inboxes).",
  {},
  async () => {
    if (!agentmailConfigured()) return text(NOT_CONFIGURED);
    try {
      const res = await listInboxes();
      const inboxes = res.inboxes ?? [];
      if (!inboxes.length) return text("fig has no inboxes yet.");
      return text(inboxes.map((i: any) => `- ${i.inbox_id}${i.display_name ? ` (${i.display_name})` : ""}`).join("\n"));
    } catch (e) {
      return text(`list_inboxes failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

/**
 * Slim, read-only inbox access for the main orchestrator: see what's there, read a message.
 * No create/wait/send — those are the browser specialist's job, so they don't bloat the main
 * context. Same MCP name as the full server (the two never live in the same query), so tool
 * ids stay consistent.
 *
 * `list_inboxes` is deliberately absent. Enumerating fig's addresses is
 * a burner-MANAGEMENT operation and belongs to the browse specialist — the thing that actually
 * mints and juggles throwaway inboxes mid-signup. In main context it's dead weight that invites
 * "let me see what inboxes I have" wandering, and every read below already defaults to fig's one
 * persistent address (config.agentmailAddress) with no lookup needed.
 *
 * Scoping it to that ONE tool is the whole restriction. Dropping the entire agentmail server
 * from unattended passes looks equivalent and isn't: it also kills the standing watch that
 * polls fig's own inbox on a cycle, which is exactly the loop that catches a forwarded email
 * before it sits unread for days. An exclusion aimed at one tool should cost exactly that tool.
 */
export const agentmailInboxServerDef = defineServer({
  key: "agentmail",
  kind: "direct",
  purpose: "read-only glance at fig's OWN email (AgentMail) — not the owner's mail, which is mcp__gmail__* / mcp__outlook__*",
  exposure: "both",
  capabilities: [
    {
      name: "check_inbox",
      purpose: "list recent messages in one of fig's own inboxes",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "read-only inbox listing; was fallback-published as fig_tools.agentmail_check_inbox",
      description:
        "List the most recent messages in one of fig's inboxes (sender, subject, preview, time, and a message_id). Use it to see what's arrived in fig's own email; then read_message to open one. Defaults to fig's own persistent address when none is given.",
      input: {
        address: z
          .string()
          .optional()
          .describe("The inbox address (inbox_id) to check. Omit to use fig's own persistent address."),
        limit: z.number().int().min(1).max(50).optional().describe("How many recent messages to list. Default 10."),
      },
      handler: async (args) => {
        if (!agentmailConfigured()) return NOT_CONFIGURED;
        const address = resolveAddress(args.address);
        if (!address) return NO_ADDRESS;
        try {
          const res = await listMessages(address, args.limit ?? 10);
          const msgs = res.messages ?? [];
          if (!msgs.length) return `${address} is empty.`;
          return msgs.map(summarizeMessage).join("\n");
        } catch (e) {
          return `check_inbox failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "read_message",
      purpose: "open one message in fig's inbox, codes and links surfaced",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "read-only message fetch; was fallback-published as fig_tools.agentmail_read_message",
      description:
        "Open one full message in an inbox — the cleaned body plus any verification codes and links surfaced from it. Use after check_inbox. Defaults to fig's own persistent address when none is given.",
      input: {
        address: z
          .string()
          .optional()
          .describe("The inbox address (inbox_id) the message is in. Omit to use fig's own persistent address."),
        message_id: z.string().describe("The message_id from check_inbox."),
      },
      handler: async (args) => {
        if (!agentmailConfigured()) return NOT_CONFIGURED;
        const address = resolveAddress(args.address);
        if (!address) return NO_ADDRESS;
        try {
          return renderMessage(await getMessage(address, args.message_id));
        } catch (e) {
          return `read_message failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const agentmailInboxServer = toSdkServer(agentmailInboxServerDef);

/**
 * The two read-only inbox tools as plain SDK tools, for the specialist server below. Derived
 * from the definitions above rather than authored twice — the specialist reuses the same two
 * handlers it always did, and there is still exactly one place where check_inbox is written.
 */
const sharedInboxTools = agentmailInboxServerDef.capabilities.map((c) =>
  tool(c.name, c.description, c.input, async (args) => text(await c.handler((args ?? {}) as Record<string, any>))),
);

// --- Full toolset (browser specialist only) ---

const createInboxTool = tool(
  "create_inbox",
  "Create one of fig's OWN email inboxes and get its address. Use this to get a fresh burner email before signing up for a site, or a stable one fig can keep. Returns the address (the inbox_id) to type into the form. Leave username blank for a random burner address; set it for a memorable one.",
  {
    username: z
      .string()
      .optional()
      .describe("Local part of the address (before the @). Omit for a random burner address."),
    label: z.string().optional().describe("Display name on outbound mail, e.g. 'Fig'."),
    client_id: z
      .string()
      .optional()
      .describe("Idempotency key — reuse the same value to avoid creating duplicate inboxes on retry."),
  },
  async (args) => {
    if (!agentmailConfigured()) return text(NOT_CONFIGURED);
    try {
      const inbox = await createInbox({
        username: args.username,
        displayName: args.label,
        clientId: args.client_id,
      });
      return text(`Created inbox: ${inbox.inbox_id}`);
    } catch (e) {
      return text(`create_inbox failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

const waitForMessageTool = tool(
  "wait_for_message",
  "Block until a NEW email arrives in an inbox, then return it fully read (body + codes + links). The verification-email workhorse: after submitting a signup with fig's address, call this to grab the confirmation code or magic link. Optionally filter by sender/subject. Returns once one arrives or after the timeout.",
  {
    address: z
      .string()
      .optional()
      .describe("The inbox address (inbox_id) to watch. Omit to use fig's own persistent address."),
    from_contains: z
      .string()
      .optional()
      .describe("Only match if the sender contains this (e.g. the site's domain). Optional."),
    subject_contains: z
      .string()
      .optional()
      .describe("Only match if the subject contains this (e.g. 'verify', 'code'). Optional."),
    timeout_seconds: z
      .number()
      .int()
      .min(10)
      .max(300)
      .optional()
      .describe("How long to wait before giving up. Default 90."),
  },
  async (args) => {
    if (!agentmailConfigured()) return text(NOT_CONFIGURED);
    const address = resolveAddress(args.address);
    if (!address) return text(NO_ADDRESS);
    try {
      const msg = await waitForMessage(address, {
        fromContains: args.from_contains,
        subjectContains: args.subject_contains,
        timeoutMs: (args.timeout_seconds ?? 90) * 1000,
      });
      if (!msg) {
        return text(
          `No new message in ${address} within ${args.timeout_seconds ?? 90}s. It may be slow or filtered — try check_inbox, or wait again.`,
        );
      }
      return text(renderMessage(msg));
    } catch (e) {
      return text(`wait_for_message failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

const sendEmailTool = tool(
  "send_email",
  "Send an email FROM one of fig's inboxes (e.g. to reply to a confirmation, or contact someone from fig's own address). The owner is asked to confirm before it sends. Not for the owner's own mail — use mcp__gmail__* / mcp__outlook__* for that.",
  {
    from: z.string().describe("Which of fig's inbox addresses to send from (inbox_id)."),
    to: z.string().describe("Recipient address."),
    subject: z.string().optional().describe("Subject line."),
    text: z.string().describe("Plain-text body."),
  },
  async (args) => {
    if (!agentmailConfigured()) return text(NOT_CONFIGURED);
    try {
      await sendMessage(args.from, { to: args.to, subject: args.subject, text: args.text });
      return text(`Sent from ${args.from} to ${args.to}.`);
    } catch (e) {
      return text(`send_email failed: ${e instanceof Error ? e.message : e}`);
    }
  },
);

/**
 * The full email toolset — given only to the browser specialist's sub-query, where signups
 * happen. Read-only inbox tools plus create_inbox / wait_for_message / send_email so it can
 * run the whole signup→verify loop itself without bouncing back to the orchestrator.
 */
export const agentmailServer = createSdkMcpServer({
  name: "agentmail",
  version: "1.0.0",
  tools: [createInboxTool, listInboxesTool, ...sharedInboxTools, waitForMessageTool, sendEmailTool],
});
