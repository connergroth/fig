import fs from "node:fs";
import path from "node:path";

import { google } from "googleapis";

import { config } from "../core/config";
import { log, warn } from "../core/log";
import {
  decideTriageFollowup,
  MAX_TRIAGE_ATTEMPTS,
  TriageAttempts,
  type AttemptState,
} from "../mail/triageRetry";
import { carriesCredentialPayload, deliverProactive, voiceProactive, PROACTIVE_SKIP } from "../scheduling/proactive";
import type { Transport } from "../transport";
import { googleAccounts, oauth2For } from "./accounts";
import { accountEmail, gmailClient, messageLabelIds } from "./gmail";
import { triageEmail } from "./triage";

/**
 * Event-driven email triage via Gmail push (Pub/Sub PULL), multi-account. Each
 * configured account arms its own Gmail watch on INBOX → the shared `gmail-push`
 * topic; we pull notifications from our one subscription and route each by its
 * `emailAddress` to the right account, then history.list to find what arrived.
 *
 * Pull (not push) means no public endpoint. Accounts share the topic; Pub/Sub fans
 * a copy to our subscription, and the message payload tells us which inbox it's for.
 *
 * Auth note: pulling needs the `pubsub` scope on each account's OAuth token. Missing
 * it → re-mint with `npm run auth:google <label>`.
 */

const PROJECT_ID = process.env.GCP_PROJECT_ID?.trim() || "bubbly-tractor-458000-h6";
const TOPIC = process.env.GMAIL_PUBSUB_TOPIC?.trim() || `projects/${PROJECT_ID}/topics/gmail-push`;
const SUBSCRIPTION =
  process.env.GMAIL_PUBSUB_SUBSCRIPTION?.trim() ||
  `projects/${PROJECT_ID}/subscriptions/bot-gmail-pull`;
const PULL_INTERVAL_MS = Number(process.env.GMAIL_PULL_INTERVAL_MS || 5000);
const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

const WATCH_STATE = path.join(config.stateDir, "gmail-watch.json");
const SEEN_PATH = path.join(config.stateDir, "gmail-seen.json");
/** Messages triaged but NOT understood yet — the retry ledger (see src/mail/triageRetry.ts). */
const ATTEMPTS_PATH = path.join(config.stateDir, "gmail-triage-attempts.json");

interface AccountWatch {
  historyId?: string; // baseline; triage messages added after this
  expiration?: number; // epoch ms the watch lapses
  email?: string; // address, for routing pull notifications
}
type WatchState = Record<string, AccountWatch>; // keyed by account label

function loadWatchState(): WatchState {
  try {
    return JSON.parse(fs.readFileSync(WATCH_STATE, "utf8"));
  } catch {
    return {};
  }
}
function saveWatchState(s: WatchState): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(WATCH_STATE, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}
function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")));
  } catch {
    return new Set();
  }
}
function saveSeen(seen: Set<string>): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-3000)));
  } catch {
    /* best-effort */
  }
}
function loadAttempts(): AttemptState {
  try {
    const raw = JSON.parse(fs.readFileSync(ATTEMPTS_PATH, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as AttemptState) : {};
  } catch {
    return {};
  }
}
function saveAttempts(state: AttemptState): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(ATTEMPTS_PATH, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

function pubsubClient() {
  // Any account's token works for pulling (all are project owner); use the first.
  return google.pubsub({ version: "v1", auth: oauth2For() });
}

/** Arm (or refresh) the Gmail watch for one account on INBOX → the topic. */
async function ensureWatch(label: string, state: WatchState): Promise<void> {
  const now = Date.now();
  const w = (state[label] ??= {});
  if (!w.email) w.email = await accountEmail(label).catch(() => undefined);
  if (w.expiration && now < w.expiration - WATCH_RENEW_BEFORE_MS) return; // still fresh
  const res = await gmailClient(label).users.watch({
    userId: "me",
    requestBody: { topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
  });
  w.expiration = res.data.expiration ? Number(res.data.expiration) : now + 7 * 24 * 60 * 60 * 1000;
  if (!w.historyId && res.data.historyId) w.historyId = String(res.data.historyId); // baseline once
  saveWatchState(state);
  log(`gmail watch armed [${label}] → ${TOPIC} (expires ${new Date(w.expiration).toISOString()})`);
}

/** Inbox message ids added in `label`'s account since its baseline. */
async function newInboxIds(label: string, startHistoryId: string): Promise<{ ids: string[]; historyId: string }> {
  const g = gmailClient(label);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latest = startHistoryId;
  do {
    const res = await g.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        const m = added.message;
        const labels = m?.labelIds ?? [];
        if (!m?.id) continue;
        if (!labels.includes("INBOX")) continue;
        if (labels.includes("SENT") || labels.includes("DRAFT")) continue;
        // Spam/trash at add-time: Gmail flagged it before it ever reached us — never triage it.
        if (labels.includes("SPAM") || labels.includes("TRASH")) continue;
        ids.add(m.id);
      }
    }
    if (res.data.historyId) latest = String(res.data.historyId);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return { ids: [...ids], historyId: latest };
}

export function startGmailWatch(transport: Transport, owner: string): void {
  const accounts = googleAccounts();
  if (!accounts.length) {
    log("gmail watch off (no accounts)");
    return;
  }
  const state = loadWatchState();
  const seen = loadSeen();
  const attempts = new TriageAttempts({ state: loadAttempts(), persist: saveAttempts });
  const pubsub = pubsubClient();

  // email → label, rebuilt as watches arm (used to route pull notifications).
  function emailToLabel(email: string): string | undefined {
    const e = email.toLowerCase();
    for (const [label, w] of Object.entries(state)) if (w.email?.toLowerCase() === e) return label;
    return undefined;
  }

  /** Message handled for good: never triage it again, stop tracking retries. */
  function commitSeen(key: string): void {
    seen.add(key);
    saveSeen(seen);
    attempts.clear(key);
  }

  async function deliver(label: string, id: string, brief: string): Promise<void> {
    // A code / reset link expires before quiet hours do, so it rides through them.
    const urgent = carriesCredentialPayload(brief);
    const note = await voiceProactive(brief, "email");
    if (note === PROACTIVE_SKIP) {
      log(`email: suppressed by context [${label}] ${id}`);
    } else {
      await deliverProactive(transport, owner, note, { urgent });
      log(`email: notified [${label}] ${id}${urgent ? " (time-critical)" : ""}`);
    }
  }

  /**
   * Triage one message and decide whether it's DONE.
   *
   * `seen` is committed AFTER triage now, and only for an outcome we understood — the
   * old code added the id up front, so a crashed/truncated/unclassifiable run was
   * indistinguishable from a finished one and never got another chance (that's how a
   * delivered-package notify got eaten on 2026-07-29). The attempt counter is what
   * keeps that safe: it's bumped BEFORE the run, so even a crash that takes the process
   * down burns an attempt and the retry loop still terminates.
   */
  async function handleMessage(label: string, id: string): Promise<void> {
    const key = `${label}:${id}`;
    if (seen.has(key)) return;
    try {
      // Re-check live labels right before triage. The push fires on the messageAdded
      // event, but Gmail's spam classifier commonly moves a message to SPAM a beat
      // later — so a message that was INBOX at add-time can be spam by now. Skip it:
      // no triage, no blank ping. This is the fix for spam-flagged mail still pinging.
      const live = await messageLabelIds(id, label).catch(() => [] as string[]);
      if (live.includes("SPAM") || live.includes("TRASH")) {
        log(`email: skipped spam/trash [${label}] ${id}`);
        commitSeen(key); // a real decision — done with it
        return;
      }
      const attempt = attempts.begin(key);
      const outcome = await triageEmail(id, label);
      const next = decideTriageFollowup(outcome, attempt, attempts.recall(key));
      if (next.disposition === "retry") {
        // Silent on purpose: retries run seconds apart, so pinging on each one would
        // fire the same "couldn't classify" ping three times. Hold the brief and let
        // the give-up path surface it once if the outcome never becomes readable.
        if (next.remember) attempts.remember(key, next.remember);
        warn(
          `email: triage outcome not understood [${label}] ${id} — attempt ${attempt}/${MAX_TRIAGE_ATTEMPTS}, ` +
            `NOT marked seen, retrying on the next poll`,
        );
        return;
      }
      if (next.disposition === "giveup") {
        warn(
          `email: GIVING UP on triage [${label}] ${id} after ${attempt} attempts — marking it seen so it ` +
            `can't loop forever. ${next.deliver ? "Surfacing it as a notify anyway." : "The runtime produced NO output at all, so there is nothing to surface — check this message by hand."}`,
        );
      }
      commitSeen(key);
      if (next.deliver) await deliver(label, id, next.deliver);
    } catch (e) {
      // Leave it unseen: a throw says nothing about whether the email was handled.
      warn(`email triage/deliver failed [${label}] ${id}: ${e}`);
    }
  }

  /**
   * Re-run messages whose triage outcome we never understood. Gmail's history cursor
   * moves past them once their batch finishes, so "leave it unseen" alone would never
   * bring them back — the ledger is what makes the retry actually happen, on the pull
   * loop's own cadence.
   */
  async function drainRetries(): Promise<void> {
    for (const dropped of attempts.prune()) {
      warn(`email: retry ledger dropped ${dropped} (aged out) — that message was never successfully triaged`);
    }
    for (const key of attempts.pending()) {
      const idx = key.indexOf(":");
      const label = key.slice(0, idx);
      const id = key.slice(idx + 1);
      if (!accounts.some((a) => a.label === label)) {
        attempts.clear(key); // account no longer configured — stop tracking it
        continue;
      }
      await handleMessage(label, id);
    }
  }

  async function processAccount(label: string): Promise<void> {
    const w = state[label];
    if (!w?.historyId) return;
    let result: { ids: string[]; historyId: string };
    try {
      result = await newInboxIds(label, w.historyId);
    } catch (e: any) {
      if (e?.code === 404 || e?.response?.status === 404) {
        const prof = await gmailClient(label).users.getProfile({ userId: "me" });
        w.historyId = prof.data.historyId ? String(prof.data.historyId) : w.historyId;
        saveWatchState(state);
        warn(`gmail history baseline stale [${label}] — reset`);
        return;
      }
      throw e;
    }

    for (const id of result.ids) await handleMessage(label, id);
    // Advance the baseline ONLY after the whole batch is triaged. If fig crashes/restarts
    // mid-batch, historyId stays put so the startup sweep re-runs history.list from the
    // same point and re-triages whatever wasn't finished (seen dedups the done ones). This
    // is what makes a restart landing on top of an incoming email non-lossy.
    w.historyId = result.historyId;
    saveWatchState(state);
  }

  void (async function loop() {
    // Startup catch-up: before entering the pull loop, arm watches and sweep every
    // account once from its stored historyId. This recovers mail that arrived while fig
    // was down — e.g. a restart landing in the same second an email hits — even though
    // that email's Pub/Sub notification was never delivered to us. Cheap: one
    // history.list per account from the baseline, and seen dedups anything already done.
    try {
      for (const a of accounts) await ensureWatch(a.label, state);
      for (const a of accounts) await processAccount(a.label);
      await drainRetries(); // messages left mid-retry when fig went down
    } catch (e) {
      warn(`gmail startup sweep: ${e}`);
    }

    for (;;) {
      try {
        for (const a of accounts) await ensureWatch(a.label, state);
        // Before pulling new work, finish the old: anything triage couldn't classify is
        // still unseen and gets another attempt here, whether or not new mail arrives.
        await drainRetries();

        const res = await pubsub.projects.subscriptions.pull({
          subscription: SUBSCRIPTION,
          requestBody: { maxMessages: 10 },
        });
        const received = res.data.receivedMessages ?? [];
        if (received.length) {
          const ackIds = received.map((r) => r.ackId).filter((a): a is string => !!a);
          if (ackIds.length) {
            await pubsub.projects.subscriptions
              .acknowledge({ subscription: SUBSCRIPTION, requestBody: { ackIds } })
              .catch((e) => warn(`pubsub ack failed: ${e}`));
          }
          // Route each notification to its account by emailAddress; process each
          // affected account once. Unknown/undecodable → process all (safe fallback).
          const labels = new Set<string>();
          for (const r of received) {
            try {
              const data = JSON.parse(Buffer.from(r.message?.data ?? "", "base64").toString("utf8"));
              const label = data.emailAddress ? emailToLabel(String(data.emailAddress)) : undefined;
              if (label) labels.add(label);
              else accounts.forEach((a) => labels.add(a.label));
            } catch {
              accounts.forEach((a) => labels.add(a.label));
            }
          }
          for (const label of labels) await processAccount(label);
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/insufficient.*scope|PERMISSION_DENIED|forbidden|invalid_scope/i.test(msg)) {
          warn("gmail push: Pub/Sub access denied — token missing the pubsub scope. Re-mint with `npm run auth:google <label>`, then restart.");
        } else {
          warn(`gmail watch loop: ${msg}`);
        }
      }
      await new Promise((r) => setTimeout(r, PULL_INTERVAL_MS));
    }
  })();

  log(`gmail watch started (${accounts.length} account(s), pull ${SUBSCRIPTION})`);
}
