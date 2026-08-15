import { log, warn } from "../core/log";
import { carriesCredentialPayload, deliverProactive, voiceProactive, PROACTIVE_SKIP } from "../scheduling/proactive";
import type { Transport } from "../transport";
import { getAccounts, type MailAccount } from "./accounts";
import { isTransientMailError, listInboxHeads, transportLabel, type MailHead } from "./driver";
import { loadPollState, savePollState, type PollState } from "./pollState";
import { triageMailMessage } from "./triage";
import { decideTriageFollowup, MAX_TRIAGE_ATTEMPTS, TriageAttempts } from "./triageRetry";

/**
 * Poll-based email triage for every non-Gmail account (see ./accounts.ts), whichever
 * transport it uses. Neither transport has a push/webhook surface — Apple Mail is a
 * client, not a service, and we don't hold an IMAP IDLE session — so unlike gmail's
 * Pub/Sub watch this runs on a check-cadence: every ~90s, diff each inbox against its
 * OWN durable watermark + seen-set, and route anything new through the SAME two-stage
 * triage the gmail path uses (email-triage skill classifier → voiceProactive context
 * gate → deliverProactive).
 *
 * One independent loop per account, each with its own state file and its own backoff:
 * a wedged or still-syncing account backs itself off without stalling the others, and
 * neither can advance past the other's unread mail. Every log line names its account.
 *
 * Non-lossy by construction, same catch-up philosophy as src/google/watch.ts:
 * polling re-scans from the last committed point every tick, `seen` is persisted
 * per-message BEFORE triage (a crash mid-batch can't re-notify a done one), and the
 * watermark only advances after a batch completes — so a restart landing on top of
 * an incoming email just re-sweeps it on the next tick.
 *
 * DARK BY DEFAULT: does nothing unless OUTLOOK_POLL=1. Transport hiccups (an Apple Mail
 * account's initial sync throwing AppleEvent -1712, or a dropped IMAP socket) are treated
 * as busyness and backed off rather than failing.
 */

const ENABLED = (process.env.OUTLOOK_POLL || "").trim() === "1";
const INTERVAL_MS = Number(process.env.OUTLOOK_POLL_INTERVAL_MS || 90_000);
/** Heads fetched per AppleScript page. */
const PAGE = Math.max(5, Number(process.env.OUTLOOK_POLL_SCAN || 25));
/** Hard cap on heads examined per tick (and on the first-run baseline seed). */
const SCAN_MAX = Math.max(PAGE, Number(process.env.OUTLOOK_POLL_SCAN_MAX || 200));
/** Watermark slack: catches messages whose server date lands slightly behind the watermark. */
const SLACK_SEC = 3600;
const MAX_BACKOFF_MS = 15 * 60_000;
/** Gap between one account's loop starting and the next one's (see startAppleMailPolls). */
const STAGGER_MS = 20_000;

/**
 * Fetch inbox heads newest-first, paging deeper only while a whole page is still
 * unseen/new — so a quiet tick costs one small fetch, but a burst bigger than one
 * page still gets swept (up to SCAN_MAX, logged if truncated).
 */
async function scanNewHeads(account: MailAccount, state: PollState, seen: Set<string>): Promise<MailHead[]> {
  const isNew = (h: MailHead) => !seen.has(h.messageId) && h.dateEpoch > state.watermark - SLACK_SEC;
  const fresh: MailHead[] = [];
  let offset = 0;
  for (;;) {
    const page = await listInboxHeads(PAGE, offset, account);
    if (!page.length) break;
    fresh.push(...page.filter(isNew));
    const wholePageNew = page.every(isNew);
    if (page.length < PAGE || !wholePageNew) break; // hit known territory or the end
    offset += page.length;
    if (offset >= SCAN_MAX) {
      warn(`mail poll [${account.key}]: >${SCAN_MAX} new messages in one sweep — truncating; the rest ride later ticks as the watermark advances`);
      break;
    }
  }
  // Oldest first, so triage + watermark advance in arrival order.
  return fresh.sort((a, b) => a.dateEpoch - b.dateEpoch);
}

/** Start every configured account's poll loop. Each one is independent — see the header. */
export function startMailPolls(transport: Transport, owner: string): void {
  if (!ENABLED) {
    log("mail poll off (OUTLOOK_POLL unset)");
    return;
  }
  // Staggered, not simultaneous: Mail.app answers AppleEvents one at a time, so two
  // Apple Mail loops ticking together just queue behind each other and make the -1712
  // timeouts more likely. Spreading the starts keeps each account's scan in its own
  // window. (An imap account has its own connection and doesn't contend, but the
  // stagger costs it nothing.)
  getAccounts().forEach((account, i) => startAccountPoll(transport, owner, account, i * STAGGER_MS));
}

function startAccountPoll(transport: Transport, owner: string, account: MailAccount, startDelayMs: number): void {
  const tag = account.key;
  let state = loadPollState(tag);
  const seen = new Set<string>(state?.seen ?? []);
  const attempts = new TriageAttempts({
    state: state?.attempts ?? {},
    persist: (s) => {
      if (state) savePollState(tag, { ...state, seen: [...seen], attempts: s });
    },
  });
  let failures = 0;

  /** Message handled for good: never triage it again, stop tracking retries. */
  function commitSeen(messageId: string): void {
    seen.add(messageId);
    attempts.clear(messageId);
    if (state) savePollState(tag, { ...state, seen: [...seen], attempts: attempts.snapshot() });
  }

  async function deliver(messageId: string, brief: string): Promise<void> {
    // A code / reset link expires before quiet hours do, so it rides through them.
    const urgent = carriesCredentialPayload(brief);
    const note = await voiceProactive(brief, "email");
    if (note === PROACTIVE_SKIP) {
      log(`email: suppressed by context [${tag}] ${messageId}`);
    } else {
      await deliverProactive(transport, owner, note, { urgent });
      log(`email: notified [${tag}] ${messageId}${urgent ? " (time-critical)" : ""}`);
    }
  }

  /**
   * Triage one message and decide whether it's DONE. Same contract as the gmail watch
   * (src/google/watch.ts): `seen` is committed AFTER triage and ONLY for an outcome we
   * understood, the attempt counter is bumped before the run so a crash still counts,
   * and an unreadable verdict is surfaced rather than filed silently.
   */
  async function handleMessage(messageId: string): Promise<void> {
    if (seen.has(messageId)) return;
    try {
      const attempt = attempts.begin(messageId);
      const outcome = await triageMailMessage(account, messageId);
      const next = decideTriageFollowup(outcome, attempt, attempts.recall(messageId));
      if (next.disposition === "retry") {
        // Silent on purpose — the next tick tries again; pinging per attempt would
        // fire the same "couldn't classify" ping up to MAX_TRIAGE_ATTEMPTS times.
        if (next.remember) attempts.remember(messageId, next.remember);
        warn(
          `email: triage outcome not understood [${tag}] ${messageId} — attempt ${attempt}/${MAX_TRIAGE_ATTEMPTS}, ` +
            `NOT marked seen, retrying on the next tick`,
        );
        return;
      }
      if (next.disposition === "giveup") {
        warn(
          `email: GIVING UP on triage [${tag}] ${messageId} after ${attempt} attempts — marking it seen so it ` +
            `can't loop forever. ${next.deliver ? "Surfacing it as a notify anyway." : "The runtime produced NO output at all, so there is nothing to surface — check this message by hand."}`,
        );
      }
      commitSeen(messageId);
      if (next.deliver) await deliver(messageId, next.deliver);
    } catch (e) {
      // Leave it unseen: a throw says nothing about whether the email was handled.
      warn(`email triage/deliver failed [${tag}] ${messageId}: ${e}`);
    }
  }

  /**
   * Re-run messages whose triage outcome we never understood, oldest first. Returns the
   * ids touched, so the same tick's fresh-mail sweep doesn't attempt them a second time
   * (an unseen message inside the watermark's slack window still scans as "new").
   */
  async function drainRetries(): Promise<Set<string>> {
    for (const dropped of attempts.prune()) {
      warn(`mail poll [${tag}]: retry ledger dropped ${dropped} (aged out) — that message was never successfully triaged`);
    }
    const drained = new Set(attempts.pending());
    for (const messageId of drained) await handleMessage(messageId);
    return drained;
  }

  async function tick(): Promise<void> {
    // First run ever: baseline, don't triage the historical inbox. Seed the seen-set
    // with the current top of the inbox and set the watermark to its newest message —
    // triage starts with the NEXT arrival (mirrors gmail's baseline-once historyId).
    if (!state) {
      const heads = await listInboxHeads(SCAN_MAX, 0, account);
      const newest = heads.reduce((m, h) => Math.max(m, h.dateEpoch), Math.floor(Date.now() / 1000));
      for (const h of heads) seen.add(h.messageId);
      state = { watermark: newest, seen: [] };
      savePollState(tag, { ...state, seen: [...seen] });
      log(`mail poll [${tag}]: baselined "${account.accountName}" — ${heads.length} existing messages marked seen, triage starts with the next arrival`);
      return;
    }

    // Finish old work first: anything triage couldn't classify is still unseen, and the
    // watermark has already moved past it — the ledger is what brings it back.
    const retried = await drainRetries();

    const fresh = await scanNewHeads(account, state, seen);
    if (!fresh.length) return;
    log(`mail poll [${tag}]: ${fresh.length} new message(s)`);

    for (const h of fresh) {
      if (retried.has(h.messageId)) continue; // already attempted in this tick
      await handleMessage(h.messageId);
    }
    // Advance the watermark only after the whole batch is handled (gmail's philosophy):
    // a crash mid-batch leaves it put, and the next tick re-sweeps from the same point
    // with `seen` deduping whatever already finished.
    state.watermark = Math.max(state.watermark, fresh[fresh.length - 1].dateEpoch);
    savePollState(tag, { ...state, seen: [...seen] });
  }

  void (async function loop() {
    if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs));
    for (;;) {
      try {
        await tick();
        if (failures) log(`mail poll [${tag}]: recovered`);
        failures = 0;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        failures++;
        if (isTransientMailError(account, msg)) {
          // Mail.app busy / still syncing, or a dropped socket — expected, back off quietly.
          if (failures === 1 || failures % 5 === 0) {
            warn(`mail poll [${tag}]: ${transportLabel(account)} unavailable (likely transient) — backing off (${msg.slice(0, 100)})`);
          }
        } else {
          warn(`mail poll [${tag}] tick: ${msg}`);
        }
      }
      const delay = failures ? Math.min(INTERVAL_MS * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS) : INTERVAL_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  })();

  log(`mail poll [${tag}] started — "${account.accountName}" every ${Math.round(INTERVAL_MS / 1000)}s via ${transportLabel(account)}`);
}
