import { EMAIL_AGENT_TOOLS, emailSystemPrompt } from "../session/agent";
import { config } from "../core/config";
import { warn } from "../core/log";
import { makeCanUseTool } from "../runtimes/permissions";
import { runBrainTextResult } from "../runtimes/brain";
import { skillProcedureBlock } from "../scheduling/skillBody";
import type { ClaudeRuntimeOptions } from "../runtimes/claude";
import type { MailAccount } from "./accounts";
import { getMessage, linkOpensMessage, messageLink, transportLabel } from "./driver";
import { mailSearchServer } from "./searchAll";
import { outlookServer, OUTLOOK_AGENT_TOOLS } from "./tools";
import { resolveTriageOutcome, type MessageDescriptor, type TriageOutcome } from "./verdict";

/**
 * Provider-agnostic triage runner + the provider for the owner's non-Gmail accounts. Same
 * triage BRAIN as the gmail path (src/google/triage.ts): identical email-triage skill,
 * identical classifier model, identical email-agent system prompt, identical verdict
 * parsing — the parts that differ per provider (which MCP tools it drives, and a context
 * block teaching the label→folder adaptation) are data on the provider descriptor.
 *
 * The gmail path is deliberately NOT ported onto this seam yet (it stays exactly
 * as-is in src/google/); when it is, its descriptor slots in here and
 * src/google/triage.ts collapses into one triageMessage() call.
 */

/** The provider seam: what changes between gmail and non-Gmail triage. */
export interface TriageProvider {
  /** Short tag for logs — the account key ("outlook", "personal"). */
  name: string;
  /** The in-process MCP server(s) exposing this provider's read/write-back tools. */
  mcpServers: NonNullable<ClaudeRuntimeOptions["mcpServers"]>;
  /** Tool allowlist for the triage subagent. */
  allowedTools: string[];
  /** Anything the subagent must never do (send/trash equivalents). */
  disallowedTools?: string[];
  /** Provider context injected into the triage prompt: account identity + how the shared taxonomy maps onto this provider's write-back tools. */
  contextLines: (messageId: string) => string;
  /** Best-effort subject/sender/link, used ONLY to build the "triage failed" fallback brief. */
  describe: (messageId: string) => Promise<MessageDescriptor>;
}

/** Background triage never asks the owner interactively. (Same as gmail's.) */
const denyApprovals = async () => false;

/**
 * Triage one newly-arrived email via the email-triage skill, exactly like the gmail
 * path: read it fully, classify + file it, decide NOTIFY / GLANCE / NO_NOTIFY,
 * write the briefing-queue / Pending.md rows. Returns a TriageOutcome — the structured
 * NOTIFY brief (or null for silence) plus whether the verdict was recognized at all.
 * Verdict gating is now LITERALLY shared with src/google/triage.ts (src/mail/verdict.ts)
 * rather than mirrored: only a brief with a non-empty `what:` line becomes a live ping,
 * wrapped/punctuated GLANCE + NO_NOTIFY tokens file silently — and output we can't read
 * at all is retried once, then surfaced instead of swallowed.
 */
export async function triageMessage(provider: TriageProvider, messageId: string): Promise<TriageOutcome> {
  // The procedure is INLINED, not invoked. email-triage is `internal: true` and the vault
  // turns every internal skill off in skillOverrides — which blocks model invocation, so the
  // old "triage it using the email-triage skill" phrasing would have asked for something the
  // runtime refuses. Same fail-loud rule as the scheduler: a triage run that can't read its
  // own flow files the mail silently and says so, rather than improvising a classification.
  let procedure: string;
  try {
    procedure = skillProcedureBlock("email-triage");
  } catch (e) {
    warn(
      `${provider.name} triage could not load the email-triage procedure — ${messageId} NOT ` +
        `triaged, left unseen for retry. ${e instanceof Error ? e.message : e}`,
    );
    return { brief: null, recognized: false };
  }
  const prompt = [
    `A new email just arrived (message id: ${messageId}). Triage it now by following the procedure below —`,
    "it owns the full flow (read it fully, label it, track any action in Pending.md, decide whether to notify)",
    "and the exact output format.",
    provider.contextLines(messageId),
    "",
    procedure,
    "",
    "Output ONLY what the procedure specifies: the NOTIFY brief (facts + links), exactly GLANCE (logged to the briefing queue for the morning rollup, no live ping), or exactly NO_NOTIFY.",
    "Do NOT write a finished message to the owner — emit the factual brief; the orchestrator voices it.",
  ].filter(Boolean).join("\n");

  try {
    // Every no-brief outcome is logged, and says WHICH one — a silent null made a
    // crashed run and a deliberate NO_NOTIFY identical in the log. resolveTriageOutcome
    // owns that (and the retry + surface-the-unreadable rule), shared with gmail.
    return await resolveTriageOutcome({
      lane: `${provider.name} triage`,
      messageId,
      describe: () => provider.describe(messageId),
      run: (attempt) =>
        runBrainTextResult({
          label: attempt > 1 ? `${provider.name} triage (retry ${attempt - 1})` : `${provider.name} triage`,
          prompt,
          lane: "triage",
          options: {
            cwd: config.brainDir,
            mcpServers: provider.mcpServers,
            systemPrompt: emailSystemPrompt(),
            settingSources: ["project"], // gives it CLAUDE.md context for better judgment
            // No `skills:` allowlist any more — the flow is inlined above, and an allowlist
            // wouldn't have helped: skillOverrides "off" is checked AFTER the allowlist and
            // blocks the invocation regardless.
            canUseTool: makeCanUseTool(denyApprovals),
            permissionMode: "default",
            allowedTools: provider.allowedTools,
            disallowedTools: provider.disallowedTools,
          },
        }),
    });
  } catch (e) {
    // A throw tells us nothing about the email — never let it count as "handled".
    warn(`${provider.name} triage failed for ${messageId}: ${e} — left unseen for retry`);
    return { brief: null, recognized: false };
  }
}

/**
 * The provider for ONE non-Gmail account. The context block is what adapts the
 * (gmail-worded) email-triage skill + email-agent prompt to this account without forking
 * either: it teaches which tools exist here, how labels become folders, and — since
 * there's more than one such account now — WHICH account this message is in.
 * That last part is load-bearing: the mcp__outlook__* tools default to the primary
 * account, so a message on any other account has to carry `account: "<key>"` on every
 * call or the tool looks in the wrong inbox and reports the message missing.
 *
 * The TRANSPORT (Apple Mail vs direct IMAP) barely shows up here on purpose — the tools
 * behave identically — except in the link line, which is a real per-message deep link
 * only on an Apple Mail account.
 *
 * Guardrail note: the gmail-only tools in EMAIL_AGENT_TOOLS aren't reachable anyway
 * (no gmail server is mounted for this run), but we exclude them from the allowlist too.
 */
export function mailProvider(account: MailAccount): TriageProvider {
  return {
    name: account.key,
    // mailsearch rides along because OUTLOOK_AGENT_TOOLS' search entry is
    // `mcp__mailsearch__find` — the outlook server has no search of its own any more, and an
    // allowlist naming a tool no server publishes is just a triage run that can't search.
    mcpServers: { outlook: outlookServer, mailsearch: mailSearchServer },
    allowedTools: [
      ...OUTLOOK_AGENT_TOOLS,
      // keep the vault-side tools identical to the gmail triage run
      ...EMAIL_AGENT_TOOLS.filter((t) => !t.startsWith("mcp__gmail__")),
    ].filter((t, i, a) => a.indexOf(t) === i),
    // Triage never speaks outward — same denial as gmail's (src/google/triage.ts).
    // Background triage answers its own approvals with "no", so an attempted send would
    // fail anyway; denying it by name means it's never even offered.
    disallowedTools: ["mcp__outlook__send"],
    contextLines: (messageId: string) => [
      `PROVIDER CONTEXT — this email is in the owner's ${account.label.toUpperCase()} account, read via ${transportLabel(account)},`,
      `NOT gmail. Your gmail tools are unavailable for it; use the mcp__outlook__* tools instead, and pass`,
      `account: "${account.key}" on EVERY one of those calls (they default to a different account otherwise`,
      `and will tell you the message doesn't exist):`,
      `- \`get\` — full message by id (that's ${messageId}); retry once if the body is empty.`,
      `- \`save_attachments\` — download attachments, then Read each file.`,
      `- This account has no labels: the taxonomy in System/Policies/email-labels.md maps to FOLDERS (same names).`,
      `  \`file\` = label + archive in ONE step: it moves the message out of the Inbox into its PRIMARY`,
      `  label's folder (exactly one folder per message; pick Reading > Waiting > the Type label).`,
      `- Action mail and important Personal mail stay in the INBOX — do NOT \`file\` them; mark Action`,
      `  mail with \`flag\` (flagged = the Action label here).`,
      `- Pure noise (NO_NOTIFY): \`file\` it to its Type folder AND \`mark_read\` it — same as gmail's`,
      `  label+archive of noise.`,
      `- Triage never sends: the send tool is denied for this run (drafts only), there is no trash, and no CATEGORY_* tabs — skip those steps.`,
      `Everything else is UNCHANGED and shared with gmail: the email-triage skill's flow, the taxonomy in`,
      `System/Policies/email-labels.md, the notify bar in System/Policies/notify-rules.md, the briefing-queue row, and`,
      `Pending.md / Deliveries.md / Memory-inbox tracking. In the brief's \`what:\`, say it came to their`,
      `${account.label} so they know which account. For the brief's final link line use the link from \`get\``,
      linkOpensMessage(account)
        ? `(it opens the message on their Mac): 📧 ${messageLink(messageId, account)}`
        : `(this account has NO per-message link — it opens webmail, so name the sender and subject in the brief): 📧 ${messageLink(messageId, account)}`,
    ].join("\n"),
    describe: async (messageId: string) => {
      try {
        const m = await getMessage(messageId, account);
        return { subject: m.subject, from: m.sender, link: messageLink(messageId, account) };
      } catch {
        return { link: messageLink(messageId, account) }; // derivable without reading the message
      }
    },
  };
}

/** Triage one message, on the account it actually arrived in. */
export function triageMailMessage(account: MailAccount, messageId: string): Promise<TriageOutcome> {
  return triageMessage(mailProvider(account), messageId);
}
