/**
 * AgentMail client — fig's OWN email, separate from the owner's Gmail (which the email
 * specialist drives over the owner's accounts). fig uses this to spin up burner inboxes
 * for signing up to sites while browsing, read the verification codes/magic links that
 * land in them, and own an address for anything else it needs one for.
 *
 * Each inbox IS a real email address; its `inbox_id` is the address itself (e.g.
 * "yourbot@agentmail.to"). Everything is a plain REST call against api.agentmail.to.
 * No SDK. One piece of config: AGENTMAIL_API_KEY (an optional AGENTMAIL_DOMAIN picks a
 * custom domain on paid plans; default is @agentmail.to).
 */

import { restJson } from "../core/restJson";

const BASE = "https://api.agentmail.to/v0";

export function agentmailConfigured(): boolean {
  return !!process.env.AGENTMAIL_API_KEY?.trim();
}

function key(): string {
  const k = process.env.AGENTMAIL_API_KEY?.trim();
  if (!k) throw new Error("AgentMail isn't configured — set AGENTMAIL_API_KEY.");
  return k;
}

async function am(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  return restJson(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    errPrefix: `AgentMail ${method} ${path}`,
  });
}

/** inbox_id IS the email address, so it can contain "@" and must be path-encoded. */
const enc = (s: string) => encodeURIComponent(s);

export interface CreateInboxInput {
  /** Local part. Omit for a system-generated random address (good for throwaway burners). */
  username?: string;
  /** Custom domain (paid plans). Defaults to AGENTMAIL_DOMAIN, else agentmail.to. */
  domain?: string;
  /** Display name shown on outbound mail. */
  displayName?: string;
  /** Idempotency key — same client_id won't create a duplicate inbox on retry. */
  clientId?: string;
}

/** Create (or idempotently reuse, via clientId) an inbox. Returns the inbox incl. inbox_id (the address). */
export async function createInbox(opts: CreateInboxInput = {}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.username) body.username = opts.username;
  const domain = opts.domain ?? process.env.AGENTMAIL_DOMAIN?.trim();
  if (domain) body.domain = domain;
  if (opts.displayName) body.display_name = opts.displayName;
  if (opts.clientId) body.client_id = opts.clientId;
  return am("POST", "/inboxes", body);
}

/** List fig's inboxes. */
export async function listInboxes(): Promise<any> {
  return am("GET", "/inboxes");
}

/** List recent messages in an inbox (newest first), metadata + preview only. */
export async function listMessages(inboxId: string, limit = 10): Promise<any> {
  return am("GET", `/inboxes/${enc(inboxId)}/messages?limit=${limit}`);
}

/** Fetch one full message, including the cleaned body (extracted_text / extracted_html). */
export async function getMessage(inboxId: string, messageId: string): Promise<any> {
  return am("GET", `/inboxes/${enc(inboxId)}/messages/${enc(messageId)}`);
}

export interface SendInput {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

/** Send a message from one of fig's inboxes. */
export async function sendMessage(inboxId: string, input: SendInput): Promise<any> {
  return am("POST", `/inboxes/${enc(inboxId)}/messages/send`, input);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an inbox until a message NEWER than the call arrives (optionally matching a
 * from/subject substring), then return it fully fetched. This is the verification-email
 * workhorse: kick off a signup in the browser, then wait_for_message to grab the code or
 * magic link. Returns null on timeout.
 */
export async function waitForMessage(
  inboxId: string,
  opts: { fromContains?: string; subjectContains?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<any | null> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 4000;
  const from = opts.fromContains?.toLowerCase();
  const subject = opts.subjectContains?.toLowerCase();

  // Snapshot what's already there so we only return a genuinely new arrival.
  let seen = new Set<string>();
  try {
    const initial = await listMessages(inboxId, 20);
    for (const m of initial.messages ?? []) seen.add(m.message_id);
  } catch {
    /* first poll below will populate it */
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let list: any;
    try {
      list = await listMessages(inboxId, 20);
    } catch {
      continue;
    }
    for (const m of list.messages ?? []) {
      if (seen.has(m.message_id)) continue;
      const fromOk = !from || String(m.from ?? "").toLowerCase().includes(from);
      const subjOk = !subject || String(m.subject ?? "").toLowerCase().includes(subject);
      if (fromOk && subjOk) return getMessage(inboxId, m.message_id);
      seen.add(m.message_id); // a new-but-non-matching message; don't return it again
    }
  }
  return null;
}

/** A one-line digest of a message in a list view. */
export function summarizeMessage(m: any): string {
  const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : "";
  const preview = (m.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return `[${m.message_id}] from ${m.from} — "${m.subject ?? "(no subject)"}"${when ? ` · ${when}` : ""}${preview ? `\n    ${preview}` : ""}`;
}

/**
 * Pull the bits a signup flow actually needs out of a message body: any verification
 * codes (4–8 digit / 6-char alphanumeric tokens) and clickable links. A hint on top of
 * the full body, not a replacement — fig still reads the body for context.
 */
export function highlights(body: string): { codes: string[]; links: string[] } {
  const codes = new Set<string>();
  for (const m of body.matchAll(/\b(\d{4,8})\b/g)) codes.add(m[1]);
  for (const m of body.matchAll(/\b([A-Z0-9]{6})\b/g)) codes.add(m[1]); // OTP-style tokens
  const links = new Set<string>();
  for (const m of body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) links.add(m[0]);
  return { codes: [...codes].slice(0, 8), links: [...links].slice(0, 12) };
}

/** A full message rendered for fig to read: headers, the cleaned body, and surfaced codes/links. */
export function renderMessage(m: any): string {
  const body = (m.extracted_text || m.text || m.extracted_html || m.html || "").trim();
  const { codes, links } = highlights(body);
  const lines = [
    `from: ${m.from}`,
    `to: ${Array.isArray(m.to) ? m.to.join(", ") : m.to}`,
    `subject: ${m.subject ?? "(no subject)"}`,
    m.timestamp ? `date: ${new Date(m.timestamp).toLocaleString()}` : "",
  ].filter(Boolean);
  if (codes.length) lines.push(`possible codes: ${codes.join(", ")}`);
  if (links.length) lines.push(`links:\n${links.map((l) => `  ${l}`).join("\n")}`);
  lines.push("", body || "(empty body)");
  return lines.join("\n");
}
