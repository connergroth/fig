/**
 * The 🔐 prompt's *conversation* layer — how an approval question is worded, how long it
 * stays answerable, and what the owner is told when they answer one that already died.
 *
 * None of this touches what the gate DECIDES (that's runtimes/permissions.ts). The verdicts
 * were never the hard part; the messaging around them is — a window too short to answer from
 * a pocket, a late 👍 that vanishes, and byte-identical bubbles nobody can tell apart in
 * scrollback.
 *
 * Kept as its own module (rather than inline in session.ts) purely so it's testable
 * without standing up a Conversation, a transport, and the SDK.
 */

import { resolveOwnerTz } from "../location/timezone";

/**
 * How long a 🔐 stays answerable before it fails closed to deny.
 *
 * Two minutes is a terminal's number. Over iMessage the owner has to get the notification,
 * unlock the phone, and tap — three minutes to answer is ordinary, and a window that expires
 * first turns a real 👍 into a silent no-op. Ten minutes is the iMessage-shaped number: long
 * enough that a phone in a pocket still gets there, short enough that a forgotten prompt
 * doesn't pin a job open forever.
 *
 * ⚠️ Interacts with the browse job deadline (specialists/browser.ts):
 * DEFAULT_BROWSER_JOB_TIMEOUT_MIN is 10 and MAX_BROWSER_JOB_TIMEOUT_MIN is 20, so a live
 * browse job's own clock is exactly this long. A 🔐 raised mid-job that waits the full
 * window will therefore be killed by the JOB timeout at roughly the same moment (or
 * sooner, since the job's clock started first) — the approval can't outlive its job.
 * That's not silently broken, it's just capped: the effective window mid-browse is
 * "whatever the job has left", and the fix if that bites is to raise the browse budget
 * (or pass timeoutMinutes), which is the owner's call, not this file's.
 */
export const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS || 10 * 60 * 1000);

/**
 * Hard cap on how long a DEFERRED preview image (`ApprovalPrompt.image` — the rendered approval
 * card) may hold up a 🔐 before it's sent without one.
 *
 * The picture is a nicety; the question is the safety surface. A hung logo download or a wedged
 * headless Chrome must not turn "ask them" into "sit there silently", so the build is raced against
 * this and a loss just means the plain text prompt (which still carries the store and the total).
 * Generous relative to the real cost — a logo fetch is time-boxed at 2.5s and a card render at
 * ~6.5s inside approvalCard.ts — because the only job of this number is to bound a hang.
 */
export const APPROVAL_IMAGE_BUDGET_MS = Number(process.env.APPROVAL_IMAGE_BUDGET_MS || 30_000);

/**
 * Resolve a deferred preview image for a 🔐, or null. Never throws, never exceeds the budget,
 * never keeps the process alive on its own timer.
 */
export async function resolveApprovalImage(
  build: (id: string) => Promise<string | null>,
  id: string,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      build(id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APPROVAL_IMAGE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How long an expired prompt is remembered so a late 👍 on it can still be explained. */
const EXPIRED_RECALL_MS = 60 * 60 * 1000;
/** Cap on remembered dead prompts — this is a courtesy lookup, not a log. */
const EXPIRED_MAX = 20;

/** A 🔐 that timed out, kept just long enough to answer "what happened to my 👍". */
export interface ExpiredPrompt {
  id: string;
  question: string;
  expiredAt: number;
}

let expired: ExpiredPrompt[] = [];
let counter = 0;
/** Per-process offset, so ids don't restart at the same tag after a reboot. */
const SALT = Math.floor(Math.random() * 36 ** 3);

/**
 * Short, human, per-prompt tag: three base36 characters. Stepping by 37 (coprime with
 * 36³) walks all 46,656 values before repeating, so ids are collision-free within a
 * session rather than merely unlikely — the whole point is telling two stacked prompts
 * apart, and "probably different" is not that.
 */
export function nextApprovalId(): string {
  counter += 1;
  return (((SALT + counter * 37) % 36 ** 3) + 36 ** 3).toString(36).slice(-3);
}

/**
 * `8:41pm` — the terse form, since this renders on a phone.
 *
 * Rendered in THE OWNER'S timezone, not the machine's. The mini stays put while they spend
 * whole months elsewhere, so `Date#getHours()` here prints an expiry an hour off from the
 * clock they're actually looking at — an approval that reads "expires 9:24pm" when their
 * phone says 8:24pm is worse than no time at all. `resolveOwnerTz()` is the same
 * Find-My-derived zone the rest of fig's clock runs on; it falls back to the machine only
 * if we've never had a location fix. Never hardcode either zone.
 */
export function clockTime(at: number, tz: string = resolveOwnerTz()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase().replace(/\s/g, "")}`;
}

/**
 * The prompt body.
 *
 * The id leads deliberately. An iMessage tapback quotes only the first ~80 characters of
 * the message it's reacting to, so anything at the END of the body is invisible to us when
 * their 👍 comes back. Putting `#a3f` first is what makes a late/misaimed tapback
 * *identifiable* instead of just another anonymous thumbs-up — which is the whole of bug 3.
 */
export function approvalBody(question: string, id: string, at = Date.now()): string {
  const expiresAt = at + APPROVAL_TIMEOUT_MS;
  return `🔐 #${id} · ${question}\n\n👍 this to approve, 👎 to deny · expires ${clockTime(expiresAt)}`;
}

/** The line that lands under a prompt the moment it dies, so scrollback is unambiguous. */
export function expiryNotice(question: string, id: string): string {
  return `⌛️ #${id} expired — no answer in ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} min, so it was denied and the action did NOT run: ${question}`;
}

/** The reply to a 👍/👎 that lands on a prompt which already timed out. */
export function lateDecisionNotice(p: ExpiredPrompt, approved: boolean): string {
  const verb = approved ? "👍" : "👎";
  return `that ${verb} landed on #${p.id}, which had already expired (${clockTime(p.expiredAt)}) — so it did nothing and the action did NOT run: ${p.question}. say the word and i'll re-fire it.`;
}

/** Remember a prompt that just timed out. */
export function noteExpired(p: ExpiredPrompt): void {
  expired.push(p);
  const cutoff = Date.now() - EXPIRED_RECALL_MS;
  expired = expired.filter((e) => e.expiredAt >= cutoff).slice(-EXPIRED_MAX);
}

/**
 * Pull a `#a3f` tag out of an inbound message — including the truncated quote inside a
 * tapback (`[Reacted 👍 to "🔐 #a3f · Confirm browser action: ..."]`). Returns null when
 * there's no tag, which is every ordinary message and every pre-fix prompt.
 */
export function approvalIdIn(text: string): string | null {
  const m = text.match(/#([0-9a-z]{3})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** The expired prompt this message is answering, if it names one we still remember. */
export function matchExpired(text: string): ExpiredPrompt | null {
  const id = approvalIdIn(text);
  if (!id) return null;
  const cutoff = Date.now() - EXPIRED_RECALL_MS;
  return expired.find((e) => e.id === id && e.expiredAt >= cutoff) ?? null;
}

/** Test seam — drops the remembered dead prompts. */
export function resetApprovalPromptState(): void {
  expired = [];
  counter = 0;
}
