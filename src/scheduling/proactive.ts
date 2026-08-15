import { buildSystemPrompt, setSession } from "../session/agent";
import {
  isQuietSentinel,
  isValidProactiveOutput,
  OUTPUT_CONTRACT,
  proactiveCorrection,
  stripMarkdown,
  unwrapOutput,
} from "../render/chunking";
import { pacedSend } from "../render/deliver";
import { config } from "../core/config";
import { log, warn } from "../core/log";
import { proactiveOwnerTarget } from "../core/owner";
import { ownerHour } from "../location/timezone";
import { runBrainTextResult } from "../runtimes/brain";
import { logOutbound, recentTail } from "../session/transcript";
import type { Transport } from "../transport";

/**
 * Proactive (agent-initiated) notifications — email pings, calendar changes — share
 * two needs: (1) phrase the message in the orchestrator's voice so it sounds exactly
 * like normal chat, and (2) deliver it with the same quiet-hours gate + paced bubbles
 * as a reply. Both live here so email/calendar/anything-else proactive stays consistent.
 */

type Kind = "email" | "calendar";

/** Returned by voiceProactive when the context-aware pass decides NOT to ping. */
export const PROACTIVE_SKIP = "__PROACTIVE_SKIP__";

/**
 * Does this brief CARRY something the owner would otherwise have to open their inbox to
 * get — a one-time code, a password-reset link, a verification link?
 *
 * This exists because stage 2's suppression rule and this class of mail are in direct
 * conflict. Suppression asks "is this the expected result of something we just did?",
 * which is the right question for a receipt and exactly the wrong one here: the owner
 * asking for a reset is the moment the link matters MOST, not least. These emails are
 * DELIVERY, not news, so redundancy with the conversation is not a reason to drop them.
 *
 * Deterministic on purpose. A model deciding whether to suppress its own delivery is
 * what ate the 2026-08-08 SIRVA reset — stage 1 said NOTIFY and stage 2 skipped it,
 * because fig had just been helping look for that very portal. The prompt below asks
 * for the right behavior; THIS is the backstop that doesn't depend on it.
 *
 * Patterns stay tight rather than broad — a bare "code" matches promo codes, area codes
 * and discount codes, and a false positive here means bypassing quiet hours at 3am.
 */
export function carriesCredentialPayload(brief: string): boolean {
  const t = brief.toLowerCase();
  return [
    /\b(one[-\s]?time|verification|security|login|sign[-\s]?in|authentication|confirmation|access|passcode)\s+code\b/,
    /\b(otp|2fa|two[-\s]?factor|mfa)\b/,
    /\byour\s+(code|pin)\s+is\b/,
    /\b(code|pin|passcode)\s*[:=]\s*\d/,
    /\bpassword\s+reset\b/,
    /\breset\s+(your\s+)?password\b/,
    /\bmagic\s+link\b/,
    /\bverif(y|ication)\s+(your\s+)?(email|account|address|identity|link)\b/,
    /\bverification\s+link\b/,
    /\bconfirm\s+your\s+(email|account|address)\b/,
  ].some((re) => re.test(t));
}

const INTRO: Record<Kind, string> = {
  email: "An email just arrived and was triaged for the owner. Here's the factual brief:",
  calendar: "The owner's calendar just changed. Here's the factual brief:",
};

/**
 * STAGE 2 of the two-stage notify path. Stage 1 (triageEmail / the calendar poller)
 * is a cheap, stateless, per-item classifier with zero conversation context — it runs
 * on every email, so it stays dumb and over-forwards anything borderline. Everything
 * that clears its bar lands HERE, where we DO have the live thread. So this pass does
 * two jobs the blind classifier can't:
 *   1. FINAL GATE — kill the ping if it's plainly the expected result of something
 *      we were just doing (a password reset we triggered, a receipt for a purchase we
 *      made, an approval for a thing we submitted together). Emits SKIP → no ping.
 *   2. FRAME with context — voice it tied to what we're actually doing ("that waiver
 *      we submitted got approved") instead of a cold restatement of the facts.
 * Reuses buildSystemPrompt() (SOUL.md) so it sounds identical to live chat, and is fed
 * a tight tail of the recent conversation so it can recognize "we already know about
 * this." One-shot, no tools. Falls back to the raw facts (fail-open to notifying) if
 * the pass errors, so a real ping never goes out blank.
 */
export async function voiceProactive(facts: string, kind: Kind): Promise<string> {
  const body = facts.replace(/^\s*(?:NOTIFY|NO_NOTIFY)\s*/i, "").trim();
  const convo = recentTail();
  // Codes and reset links are delivery, not news — they are never suppressible. See
  // carriesCredentialPayload(). The prompt is told, and the result is enforced below.
  const mustDeliver = carriesCredentialPayload(body);
  const gate = mustDeliver
    ? [
        "This email CARRIES a one-time code or a reset/verification link — something the owner would",
        "otherwise have to go open their inbox to get. Relay it NOW. Do NOT skip it, and specifically do not",
        "skip it because you two triggered it a minute ago; that is the reason they need it, not a reason to",
        "hold it. Put the actual CODE in the text so they can fill it without opening anything, and pass any",
        "reset/verification link through exactly as written. Never output SKIP for this one.",
      ]
    : [
        "FIRST decide whether this is even worth pinging them about, using that context. If this email is",
        "plainly the expected result of something you two were just doing — a receipt/confirmation for",
        "something you just bought or submitted, an approval for a thing you were working through together,",
        "a reply in a thread they already know about — then they don't need a ping; it's noise given what you",
        "both already know. In that case output EXACTLY <output>SKIP</output> and nothing else.",
        "But NEVER skip something that carries a payload they'd have to open their inbox for — a login code,",
        "a password-reset or verification link. Redundancy is about news; those are delivery.",
      ];
  const prompt = [
    INTRO[kind],
    "",
    body,
    "",
    convo ? "Here's the recent conversation with the owner, for context on what you two are actively doing:" : "",
    convo ? "<recent_conversation>" : "",
    convo,
    convo ? "</recent_conversation>" : "",
    convo ? "" : "",
    ...gate,
    "",
    "Otherwise, text the owner about it now, in your normal voice — a sentence or two, just the gist and any",
    "action they need to take, the way you'd text a friend. Use the context to FRAME it: tie it to what you're",
    "doing (\"that waiver we submitted got approved\") instead of restating it cold. Don't print fields as",
    "labels (no \"subject:\", \"from:\"); mention who/what naturally only if it matters.",
    "If the brief lists any links, include each one EXACTLY as written, on its own line (never alter a url).",
    "Wrap the EXACT message the owner should receive in <output></output> tags — only what's inside the tags is sent, so any thinking outside them is dropped. No preamble, no quotes inside.",
  ].join("\n");

  try {
    const { text } = await runBrainTextResult({
      label: "voiceProactive",
      prompt,
      options: {
        cwd: config.brainDir,
        systemPrompt: buildSystemPrompt(), // same voice as the live chat orchestrator
        tools: [], // pure voicing — no tool access
        permissionMode: "bypassPermissions",
        maxTurns: 2,
      },
      // Enforce the <output> wrapper: a malformed voicing is re-prompted, then suppressed.
      // On suppression `text` is "" and we fall back to `body` — the FACTUAL brief, which is
      // system-generated (not model scratchpad), so the fallback can't leak narration.
      validateOutput: {
        isValid: (t: string) => isValidProactiveOutput(t, OUTPUT_CONTRACT.wrapped),
        correction: proactiveCorrection(OUTPUT_CONTRACT.wrapped),
      },
    });
    // Context-aware suppression: if the pass judged this a non-event given what we're
    // already doing, it emits <output>SKIP</output>. Signal the caller to drop the ping.
    if (/^\s*SKIP\s*$/i.test(unwrapOutput(text))) {
      // ...unless it's carrying a code or a reset link, which is never suppressible.
      // Falling back to the factual brief beats dropping the payload on the floor.
      if (mustDeliver) {
        warn("voiceProactive: SKIP overridden — this brief carries a code/reset link");
        return body;
      }
      return PROACTIVE_SKIP;
    }
    return text.trim() || body;
  } catch (e) {
    warn(`voiceProactive failed: ${e}`);
    return body;
  }
}

/**
 * No proactive pings during quiet hours — they wait for the morning briefing.
 *
 * Measured on THEIR clock (`ownerHour`), not the mini's. On the machine's timezone the whole
 * window slides by however far the owner has travelled, which unmutes pings at 5am where
 * they're actually sleeping — quiet hours that aren't quiet where they are are worse than none.
 */
export function inQuietHours(): boolean {
  const h = ownerHour();
  const { start, end } = config.quietHours;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

/**
 * Deliver a proactive message: held entirely during quiet hours, otherwise stripped,
 * split into paced bubbles, and sent. Mirrors the reactive deliver() so proactive and
 * reactive pings feel the same.
 *
 * `urgent` is the one bypass, and it exists for exactly one shape: a message whose value
 * expires before quiet hours do. A login code held from 11:30pm to 8am is not a delayed
 * ping, it's a dead one — and the owner asking for it at 11:30pm is proof they're awake
 * and mid-login. Everything else waits; quiet hours are worth defending.
 */
export async function deliverProactive(
  transport: Transport,
  owner: string,
  text: string,
  opts: { urgent?: boolean } = {},
): Promise<void> {
  if (inQuietHours() && !opts.urgent) {
    log("proactive: held (quiet hours)");
    return;
  }
  if (inQuietHours()) log("proactive: quiet hours bypassed (time-critical payload)");
  // Extract the wrapped payload (if voiceProactive emitted an <output>…</output> block)
  // before stripping/sending, so any narration around it stays out of the thread.
  const clean = stripMarkdown(unwrapOutput(text)).trim();
  // Backstop: voiceProactive's contract disallows a bare/wrapped NOTHING (email/calendar
  // pings use SKIP for that), but a model wrapping the sentinel anyway
  // (`<output>NOTHING</output>`) would otherwise unwrap clean and ship verbatim — see
  // isQuietOutput's doc comment in render/chunking.ts for the exact failure mode.
  if (!clean || isQuietSentinel(clean)) return;
  logOutbound(clean);
  const target = proactiveOwnerTarget() || owner;
  await pacedSend(transport, target, clean, {
    onError: (e) => warn(`proactive send failed: ${e}`),
  });
  // This proactive ping just entered the thread out of band — reset the long-lived
  // interactive session so the next interactive turn rebuilds from the transcript
  // (now including this ping) and sees what fig just told them.
  setSession(undefined);
}
