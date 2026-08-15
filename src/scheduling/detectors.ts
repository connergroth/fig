import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { readJsonArray, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";

/**
 * The detector registry: cheap change gates for authenticated websites.
 *
 * A detector is the low-cost half of a watch. The scheduler runs a registered
 * probe on cadence, stores the probe's compact signal, and only wakes a full
 * agent pass when that signal changes. Most ticks therefore spend no LLM tokens:
 * they just open a read-only browser page, compute a fingerprint, and exit.
 *
 * Like watches, detectors live under `.state` so they can be edited at runtime.
 * Unlike watches, `probe` is only a key into the in-process probe registry; it is
 * never a user-supplied shell command.
 */

export interface Detector {
  /** Stable slug, unique in the registry. */
  id: string;
  /** Human label for logs/state. */
  label: string;
  /** Key into the probe registry, not an arbitrary command. */
  probe: string;
  /** Focused instruction to run when the probe signal changes. */
  prompt: string;
  /** Scheduler grammar ("every 30m 07:00-23:00", "daily 08:00"). */
  schedule: string;
  /** Allows pausing a detector without deleting its state. */
  enabled: boolean;
  /** Last probe fingerprint, scheduler-managed. */
  lastValue?: string;
  /** Last time the cheap probe ran, scheduler-managed. */
  lastCheckedISO?: string;
  /** Last time a changed signal woke an agent pass, scheduler-managed. */
  lastFiredISO?: string;
  /** Last probe error, scheduler-managed. */
  lastError?: string;
  /** ISO when created. */
  createdISO: string;
  /** Optional hard stop. */
  expiresISO?: string;
}

const DETECTORS_FILE = path.join(config.stateDir, "detectors.json");
let attemptedDefaultSeed = false;

const DEFAULT_DETECTORS: Detector[] = [
  {
    id: "reddit-unread",
    label: "Reddit unread inbox",
    probe: "reddit-unread",
    prompt:
      "The reddit outreach account's inbox changed. Use the browse specialist to read the new unread replies/DMs on that account's inbox (reddit.com/message/unread), and text the owner a short summary: who replied, on which thread/subreddit, the gist, and the permalink for each. This ties into the reddit-outreach loop - note anything worth acting on. Read-only, don't reply from the account.",
    schedule: "every 30m 07:00-23:00",
    enabled: true,
    createdISO: "2026-07-15T03:22:17Z",
  },
];

function cloneDefaults(): Detector[] {
  return DEFAULT_DETECTORS.map((d) => ({ ...d }));
}

export function loadDetectors(): Detector[] {
  if (!fs.existsSync(DETECTORS_FILE)) {
    const seeded = cloneDefaults();
    if (!attemptedDefaultSeed) {
      attemptedDefaultSeed = true;
      saveDetectors(seeded);
    }
    return seeded;
  }
  return readJsonArray<Detector>(DETECTORS_FILE);
}

export function saveDetectors(detectors: Detector[]): void {
  try {
    writeJson(DETECTORS_FILE, detectors);
  } catch (e) {
    warn(`saveDetectors failed: ${e}`);
  }
}

/** Drop a detector by id. Returns true if removed. */
export function removeDetector(id: string): boolean {
  const detectors = loadDetectors();
  const next = detectors.filter((d) => d.id !== id);
  if (next.length === detectors.length) return false;
  saveDetectors(next);
  return true;
}

function patchDetector(id: string, patch: (d: Detector) => void): void {
  const detectors = loadDetectors();
  const d = detectors.find((x) => x.id === id);
  if (!d) return;
  patch(d);
  saveDetectors(detectors);
}

/** Stamp the last cheap probe check time. */
export function markDetectorChecked(id: string, atISO: string): void {
  patchDetector(id, (d) => {
    d.lastCheckedISO = atISO;
  });
}

/** Store the last stable probe signal. */
export function setDetectorValue(id: string, value: string): void {
  patchDetector(id, (d) => {
    d.lastValue = value;
  });
}

/** Stamp the last time a detector woke an agent pass. */
export function markDetectorFired(id: string, atISO: string): void {
  patchDetector(id, (d) => {
    d.lastFiredISO = atISO;
  });
}

/** Store or clear the last probe error. */
export function setDetectorError(id: string, error: string | undefined): void {
  patchDetector(id, (d) => {
    if (error) d.lastError = error;
    else delete d.lastError;
  });
}

/** True if the detector has passed its hard expiry. */
export function isDetectorExpired(d: Detector, now: Date): boolean {
  return !!d.expiresISO && new Date(d.expiresISO).getTime() <= now.getTime();
}
