import { EMAIL_AGENT_TOOLS, emailSystemPrompt } from "../session/agent";
import { config } from "../core/config";
import { warn } from "../core/log";
import { resolveTriageOutcome, type MessageDescriptor, type TriageOutcome } from "../mail/verdict";
import { makeCanUseTool } from "../runtimes/permissions";
import { runBrainTextResult } from "../runtimes/brain";
import { skillProcedureBlock } from "../scheduling/skillBody";
import { getMessage, messageWebUrl } from "./gmail";
import { gmailServer } from "./tools";

/** Background triage never asks the owner interactively; send/trash are disallowed anyway. */
const denyApprovals = async () => false;

/** Best-effort subject/sender/link, used ONLY to build the "triage failed" fallback brief. */
async function describeMessage(messageId: string, account?: string): Promise<MessageDescriptor> {
  try {
    const m = await getMessage(messageId, account);
    return { subject: m.subject, from: m.from, link: m.webUrl };
  } catch {
    return { link: messageWebUrl(messageId) }; // the url is derivable from the id alone
  }
}

/**
 * Triage one newly-arrived email via the email-triage skill: read it fully (+
 * attachments), classify and file it, and decide whether it warrants a ping.
 *
 * Returns a TriageOutcome: the STRUCTURED BRIEF (facts + links the skill emits) or null
 * to stay silent, PLUS whether the verdict was recognized at all. The brief is NOT
 * user-facing prose — voiceProactive() turns it into the owner's-voice text, so the email
 * agent never has to carry the persona and the voice stays identical to the
 * orchestrator. send/trash are disallowed here so nothing goes out or gets destroyed
 * unattended.
 *
 * `recognized: false` means we never learned what triage decided — the caller must keep
 * the message retryable rather than marking it seen (src/mail/triageRetry.ts). See
 * src/mail/verdict.ts for why unparseable output is no longer filed silently.
 */
export async function triageEmail(messageId: string, account?: string): Promise<TriageOutcome> {
  const acctLine = account
    ? `This email is in the owner's "${account}" account. Pass account:"${account}" to EVERY gmail tool call ` +
      `(get, label, archive, etc.) so you act on the right inbox. If it's not their primary account, say which ` +
      `inbox it's in within the brief's "what:" so they know.`
    : "";
  // Inlined, not invoked — see the note in src/mail/triage.ts. email-triage is internal, so
  // skillOverrides blocks model invocation of it; the flow travels in the prompt instead.
  let procedure: string;
  try {
    procedure = skillProcedureBlock("email-triage");
  } catch (e) {
    warn(
      `gmail triage could not load the email-triage procedure — ${messageId} NOT triaged, ` +
        `left unseen for retry. ${e instanceof Error ? e.message : e}`,
    );
    return { brief: null, recognized: false };
  }
  const prompt = [
    `A new email just arrived (message id: ${messageId}). Triage it now by following the procedure below —`,
    "it owns the full flow (read it fully, label it, track any action in Pending.md, decide whether to notify)",
    "and the exact output format.",
    acctLine,
    "",
    procedure,
    "",
    "Output ONLY what the procedure specifies: the NOTIFY brief (facts + links), exactly GLANCE (logged to the briefing queue for the morning rollup, no live ping), or exactly NO_NOTIFY.",
    "Do NOT write a finished message to the owner — emit the factual brief; the orchestrator voices it.",
  ].filter(Boolean).join("\n");

  try {
    // Verdict parsing, the one retry, and the "unreadable → surface it" fallback all
    // live in src/mail/verdict.ts, shared with the outlook lane (the two copies of this
    // logic drifted into carrying the same bug).
    return await resolveTriageOutcome({
      lane: "gmail triage",
      messageId,
      describe: () => describeMessage(messageId, account),
      run: (attempt) =>
        runBrainTextResult({
          label: attempt > 1 ? `gmail triage (retry ${attempt - 1})` : "gmail triage",
          prompt,
          lane: "triage",
          options: {
            cwd: config.brainDir,
            mcpServers: { gmail: gmailServer },
            systemPrompt: emailSystemPrompt(),
            settingSources: ["project"], // gives it CLAUDE.md context for better judgment
            // No `skills:` allowlist — the flow is inlined above, and the allowlist wouldn't
            // have helped anyway (skillOverrides "off" is checked after it and wins).
            canUseTool: makeCanUseTool(denyApprovals),
            permissionMode: "default",
            allowedTools: EMAIL_AGENT_TOOLS,
            disallowedTools: ["mcp__gmail__send", "mcp__gmail__trash"],
          },
        }),
    });
  } catch (e) {
    // A throw tells us nothing about the email — never let it count as "handled".
    warn(`triage failed for ${messageId}: ${e} — left unseen for retry`);
    return { brief: null, recognized: false };
  }
}
