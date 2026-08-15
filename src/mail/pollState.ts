import path from "node:path";

import { config } from "../core/config";
import { readJson, writeJson } from "../core/jsonStore";
import { log, warn } from "../core/log";
import { LEGACY_ACCOUNT_KEY } from "./accounts";
import type { AttemptState } from "./triageRetry";

/**
 * Durable per-account state for the Apple Mail poller: the watermark, the seen-set,
 * and the retry ledger, one file per account key.
 *
 * Per-ACCOUNT is the whole point. The watermark and seen-set are statements about one
 * inbox; sharing a file between two accounts would let a quiet account's watermark
 * advance past a busy one's unread mail (or the seen cap evict the other's ids), which
 * is exactly the "handled" lie the retry ledger exists to prevent.
 *
 * MIGRATION: the CU Outlook account was polled long before there was a registry, and
 * its state lives at `.state/outlook-poll.json`. Read that as the `outlook` account's
 * state and copy it forward on first load. Getting this wrong wouldn't fail loudly —
 * a missing state file means "first run ever", so the poller would BASELINE, mark the
 * whole current inbox seen and never triage the mail that arrived while it was down.
 */

export interface PollState {
  /** Unix seconds; messages received at/before this (minus slack + seen) are settled. */
  watermark: number;
  /** RFC message ids already handled (capped, newest last — same shape as gmail-seen). */
  seen: string[];
  /** Messages triaged but NOT understood yet — the retry ledger (see ./triageRetry.ts). */
  attempts?: AttemptState;
}

/** How many seen ids we keep per account before the oldest fall off. */
const SEEN_CAP = 3000;

/** Where an account's poll state lives. `dir` is injectable so tests don't touch the vault. */
export function pollStatePath(key: string, dir = config.stateDir): string {
  return path.join(dir, `mail-poll-${key}.json`);
}

/** The pre-registry single-account file, kept readable for the migration above. */
export function legacyPollStatePath(dir = config.stateDir): string {
  return path.join(dir, "outlook-poll.json");
}

function readState(file: string): PollState | null {
  const s = readJson<PollState | null>(file, null);
  return s && typeof s.watermark === "number" && Array.isArray(s.seen) ? s : null;
}

/**
 * Load an account's state, migrating the legacy single-account file the first time the
 * `outlook` account is loaded from it. Returns null only when this account has genuinely
 * never been polled — which is what tells the poller to baseline.
 */
export function loadPollState(key: string, dir = config.stateDir): PollState | null {
  const current = readState(pollStatePath(key, dir));
  if (current) return current;
  if (key !== LEGACY_ACCOUNT_KEY) return null;
  const legacy = readState(legacyPollStatePath(dir));
  if (!legacy) return null;
  log(`mail poll [${key}]: migrating state from ${legacyPollStatePath(dir)} — no re-baseline`);
  savePollState(key, legacy, dir);
  return legacy;
}

/** Persist an account's state. Never throws: a failed save must not kill the poll loop. */
export function savePollState(key: string, state: PollState, dir = config.stateDir): void {
  try {
    writeJson(pollStatePath(key, dir), {
      watermark: state.watermark,
      seen: state.seen.slice(-SEEN_CAP),
      attempts: state.attempts ?? {},
    });
  } catch (e) {
    warn(`mail poll [${key}]: state save failed: ${e}`);
  }
}
