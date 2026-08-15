import { log, warn } from "../core/log";

/**
 * Verdict parsing for BOTH triage lanes (gmail: src/google/triage.ts, outlook:
 * src/mail/triage.ts). It lives here, provider-neutral and IO-free, because the two
 * lanes had a byte-identical copy of this logic and the same bug in both copies.
 *
 * THE BUG THIS FILE EXISTS TO KILL (2026-07-29): an Amazon "Delivered" email came back
 * from the classifier with output we couldn't parse. The old code collapsed three very
 * different outcomes into one silent `return null`:
 *   - NO_NOTIFY  — a DECISION: pure noise. Silence is correct.
 *   - GLANCE     — a DECISION: rides the morning rollup. Silence is correct.
 *   - unparseable — NOT a decision. We do not know what triage concluded.
 * Filing the third one silently is failing CLOSED on an unknown, and it ate a
 * notify-tier email (`System/Policies/notify-rules.md`: a delivered package is fine to ping on)
 * with nothing but one `log()` line to show for it.
 *
 * The tradeoff encoded here, deliberately: an unrecognized result gets ONE retry, and if
 * that also comes back unrecognized we SURFACE it — a loud `warn()` plus a minimal,
 * honest NOTIFY brief saying triage failed — instead of dropping it. A rare false ping
 * is cheap and self-correcting (the owner reads it and moves on); a silently eaten notify
 * is invisible and unbounded. Prefer the false ping. Every time.
 */

/** What the classifier's raw text actually said. */
export type TriageVerdict =
  | { kind: "notify"; brief: string }
  /** An explicit, deliberate "don't ping" decision. Filing it silently is correct. */
  | { kind: "silent"; verdict: "NO_NOTIFY" | "GLANCE" }
  /** Empty, truncated, or malformed output — we do NOT know what triage decided. */
  | { kind: "unrecognized" };

/**
 * The result a triage lane hands back to its poller.
 *
 * `recognized` is the flag the seen-set must key on. A message may only be marked
 * permanently handled once triage produced an outcome we UNDERSTOOD; anything else
 * (run failure, throw, unrecognized-after-retry) has to stay retryable, or a broken run
 * is indistinguishable from a finished one forever after. See src/mail/triageRetry.ts.
 */
export interface TriageOutcome {
  /** The structured brief to voice + ping, or null to stay silent. */
  brief: string | null;
  /** True only when triage's verdict was understood (notify / NO_NOTIFY / GLANCE). */
  recognized: boolean;
}

/** One raw classifier run: whether the runtime produced anything, and its text. */
export interface TriageRun {
  ok: boolean;
  text: string;
}

/** Identifying facts for the fallback brief, all best-effort. */
export interface MessageDescriptor {
  subject?: string;
  from?: string;
  /** The open-this-message link (gmail web url / Apple Mail `message://` link). */
  link?: string;
}

/**
 * Classify one raw triage output.
 *
 * Only a well-formed NOTIFY brief — one carrying an actual `what:` line with real
 * content (the shape ONLY a NOTIFY brief has, per the email-triage skill) — becomes a
 * live ping. That keying is what makes a wrapped/punctuated verdict token (`**GLANCE**`,
 * "GLANCE.", inline-code) file silently instead of falling through to the notify path
 * with no facts in it. Unchanged from the original check; what changed is that "neither
 * a brief nor a recognizable token" is now its own outcome instead of a silent decision.
 */
export function classifyTriageOutput(text: string): TriageVerdict {
  // `[ \t]*` (not `\s*`) after the colon on purpose: `\s*` swallowed the newline, so a
  // brief with an EMPTY what: line captured the literal "links:" marker as its content
  // and passed as a notify — a ping carrying no facts at all. Now it reads as
  // unrecognized, which retries and then surfaces honestly instead of pinging garbage.
  const what = text.match(/what[ \t]*:[ \t]*([\s\S]*?)(?:\n[ \t]*links[ \t]*:|$)/i);
  if (what && what[1].trim()) return { kind: "notify", brief: text };
  if (/\bNO_NOTIFY\b/i.test(text)) return { kind: "silent", verdict: "NO_NOTIFY" };
  if (/\bGLANCE\b/i.test(text)) return { kind: "silent", verdict: "GLANCE" };
  return { kind: "unrecognized" };
}

/**
 * The brief we emit when triage never produced a verdict we could read. Shaped exactly
 * like a real NOTIFY brief (`what:` + `links:`) so voiceProactive() handles it on the
 * normal path — but honest about what happened, because the one thing worse than a
 * false ping is a ping that pretends to know something it doesn't.
 */
export function unrecognizedBrief(messageId: string, d: MessageDescriptor = {}): string {
  const who = d.from?.trim();
  const subject = d.subject?.trim();
  const bits = [
    "triage couldn't classify this email — surfacing it rather than dropping it, so it may be nothing.",
    subject ? `Subject: ${subject}.` : "",
    who ? `From: ${who}.` : "",
    !subject && !who ? `Message id ${messageId}.` : "",
    "The classifier returned no readable verdict, so it was NOT labeled, filed, or logged to the briefing queue — worth a quick look in the inbox.",
  ].filter(Boolean);
  const lines = ["NOTIFY", `what: ${bits.join(" ")}`];
  if (d.link) lines.push("links:", `📧 ${d.link}`);
  return lines.join("\n");
}

/**
 * Run one triage lane's classifier and turn it into a `TriageOutcome`, retrying once
 * when the output is unrecognized.
 *
 * `run` is the provider's actual classifier call (attempt number passed in for logging);
 * `describe` is a best-effort lookup of subject/sender/link used ONLY to build the
 * fallback brief, so a healthy triage never pays for it.
 */
export async function resolveTriageOutcome(args: {
  /** Log prefix, e.g. "gmail triage" / "outlook triage". */
  lane: string;
  messageId: string;
  run: (attempt: number) => Promise<TriageRun>;
  describe?: () => Promise<MessageDescriptor>;
}): Promise<TriageOutcome> {
  const { lane, messageId, run, describe } = args;
  const ATTEMPTS = 2; // the initial run + exactly one retry

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await run(attempt);
    // A run that produced nothing at all is an infrastructure failure, not a verdict.
    // Unlike the unrecognized case it gets no fabricated ping (a dead classifier would
    // otherwise ping once per inbound email) — but it is NOT recognized either, so the
    // poller keeps it retryable instead of burning it. See triageRetry.ts for the cap.
    if (!res.ok) {
      warn(`${lane} produced no result for ${messageId} (run failed) — NOT triaged, left unseen for retry`);
      return { brief: null, recognized: false };
    }
    const verdict = classifyTriageOutput(res.text);
    if (verdict.kind === "notify") return { brief: verdict.brief, recognized: true };
    if (verdict.kind === "silent") {
      // Unchanged behavior, unchanged log line: these are real decisions.
      log(`${lane}: ${verdict.verdict} [${messageId}] — filed silently`);
      return { brief: null, recognized: true };
    }
    if (attempt < ATTEMPTS) {
      warn(`${lane}: no verdict token [${messageId}] — unreadable result, retrying once`);
    }
  }

  // Unrecognized twice. Do NOT file it silently — that's the exact defect. Surface it.
  const d = describe ? await describe().catch(() => ({}) as MessageDescriptor) : {};
  warn(
    `${lane}: NO VERDICT after ${ATTEMPTS} attempts [${messageId}] — triage output unreadable both times; ` +
      `NOT filed silently, surfacing it as a notify instead (better a false ping than a swallowed one)`,
  );
  return { brief: unrecognizedBrief(messageId, d), recognized: false };
}
