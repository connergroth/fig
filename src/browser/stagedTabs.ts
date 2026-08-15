import path from "node:path";

import type { Page } from "playwright";

import { config } from "../core/config";
import { log } from "../core/log";
import { readJsonArray, writeJson } from "../core/jsonStore";

/**
 * Tabs a browse job filled in and deliberately LEFT OPEN for the owner.
 *
 * Why this exists: tab-per-job isolation (see chrome.ts openJobTab) closes a run's tab when
 * the run ends, so two concurrent jobs can't navigate out from under each other. That was
 * right for the common case and WRONG for the one that matters most — the tier-1 application
 * policy is "fill the form, submit nothing, leave it for the owner." Without a staged state a
 * fully-filled application dies with its own run's exit: the only other thing that protects a
 * tab is `handedOff`, which trips solely on a LOGIN handoff. A staged form is not a handoff,
 * so the tab gets reaped along with everything typed into it.
 *
 * A staged tab is therefore its own first-class state, in the same protection class as a
 * live handoff: no run may close it, only an explicit release or expiry may. Two layers,
 * because the cost is asymmetric — a stray tab is clutter, a reaped tab is destroyed work:
 *
 *  1. An in-process HOLD set keyed on the Page object. This is what closeJobTab consults, so
 *     protection does not depend on matching URL strings or on the model's wording.
 *  2. A disk registry (url / title / why / when), so the staged work is still *nameable*
 *     after a restart — fig can tell the owner what's waiting and where, even if Chrome died
 *     and the tab itself is gone.
 */

const FILE = path.join(config.stateDir, "staged-tabs.json");

/** How long a staged tab is protected before it's assumed abandoned and reaped. */
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export type StagedTab = {
  /** Stable id so a release can name one specific staged item. */
  id: string;
  url: string;
  title: string;
  /** What's sitting there and what the owner has to do — shown to them verbatim. */
  reason: string;
  /** Which job staged it (skill/label), for the report. */
  label?: string;
  stagedAt: string;
};

/**
 * Live Page objects under hold. Deliberately NOT persisted — a Page can't survive a restart,
 * and the disk registry covers the after-restart question. Protection is by object identity
 * so it can't be defeated by a redirect changing the URL out from under us.
 */
const held = new Set<Page>();

/** Put a tab under hold for this process. Idempotent. */
export function holdTab(page: Page | null | undefined): void {
  if (page && !page.isClosed()) held.add(page);
}

/** Is this tab protected from its own run's cleanup? */
export function isHeldTab(page: Page | null | undefined): boolean {
  if (!page) return false;
  if (page.isClosed()) {
    held.delete(page);
    return false;
  }
  return held.has(page);
}

/** Drop the hold — the tab becomes a normal tab again and may be closed. */
export function unholdTab(page: Page | null | undefined): void {
  if (page) held.delete(page);
}

export function listStagedTabs(): StagedTab[] {
  return readJsonArray<StagedTab>(FILE);
}

/** The staged record a live page corresponds to, matched on current URL. */
export function stagedTabForPage(page: Page | null | undefined): StagedTab | null {
  if (!page || page.isClosed()) return null;
  const url = page.url();
  return listStagedTabs().find((t) => t.url === url) ?? null;
}

/**
 * Resolve "the staged tab I mean" to a live Page, so a run can RESUME work instead of opening
 * a fresh tab and starting over. Accepts a staged id, a full URL, or a bare host — a host is
 * how the model will usually say it ("resume the amazon one"), and it's enough because only
 * one staged tab per URL is ever recorded.
 *
 * Held pages are the source of truth, not the registry: the registry survives a Chrome restart
 * and the Page objects do not, so a row with no live page means the tab is genuinely gone and
 * the caller should open a fresh one rather than pretend.
 */
export function findHeldPage(pages: Page[], target: string): Page | null {
  const want = target.trim().toLowerCase();
  if (!want) return null;
  const live = pages.filter((p) => !p.isClosed() && held.has(p));
  if (!live.length) return null;

  const byId = listStagedTabs().find((t) => t.id.toLowerCase() === want);
  const wantedUrls = byId ? [byId.url] : [];

  const hostOf = (u: string): string => {
    try {
      return new URL(u).host.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const wantHost = want.startsWith("http") ? hostOf(want) : want.replace(/^www\./, "");

  return (
    live.find((p) => wantedUrls.includes(p.url())) ??
    live.find((p) => p.url().toLowerCase() === want) ??
    live.find((p) => hostOf(p.url()) === wantHost) ??
    null
  );
}

/** Staged rows whose tab is still live in this Chrome — the genuinely resumable ones. */
export function liveStagedTabs(pages: Page[]): StagedTab[] {
  const urls = new Set(pages.filter((p) => !p.isClosed() && held.has(p)).map((p) => p.url()));
  return listStagedTabs().filter((t) => urls.has(t.url));
}

/**
 * Record a staged tab and protect it. Called by the `stage_for_review` tool the browse
 * specialist fires, and by the caller-declared `stageForReview` flag on a browse job.
 */
export function stageTab(page: Page | null, entry: Omit<StagedTab, "id" | "stagedAt">): StagedTab {
  holdTab(page);
  const record: StagedTab = {
    id: Math.random().toString(36).slice(2, 8),
    stagedAt: new Date().toISOString(),
    ...entry,
  };
  const all = listStagedTabs().filter((t) => t.url !== record.url);
  all.push(record);
  try {
    writeJson(FILE, all);
  } catch (e) {
    // The in-process hold already protects the tab; the registry is the nice-to-have.
    log(`stagedTabs: couldn't persist registry (${e})`);
  }
  log(`stagedTabs: staged ${record.id} — ${record.title || record.url} (${record.reason})`);
  return record;
}

/**
 * Release a staged tab by id or url — they submitted it, or they're done with it. Drops the hold
 * so the next reap can close it, and removes the registry row. Returns the entry if found.
 */
export function releaseStagedTab(idOrUrl: string): StagedTab | null {
  const all = listStagedTabs();
  const hit = all.find((t) => t.id === idOrUrl || t.url === idOrUrl);
  if (!hit) return null;
  try {
    writeJson(
      FILE,
      all.filter((t) => t !== hit),
    );
  } catch {
    /* best effort */
  }
  for (const p of [...held]) {
    if (!p.isClosed() && p.url() === hit.url) held.delete(p);
  }
  log(`stagedTabs: released ${hit.id} — ${hit.title || hit.url}`);
  return hit;
}

/**
 * Housekeeping, run when a new job tab opens: forget registry rows whose tab is long gone
 * (Chrome restarted) or that have sat past EXPIRY_MS, and un-hold anything expired so it
 * stops accumulating forever. Never touches anything inside the window — an unsubmitted
 * application is worth more than a clean tab strip.
 */
export function reapExpiredStagedTabs(openUrls: string[]): void {
  const all = listStagedTabs();
  const now = Date.now();
  const keep = all.filter((t) => {
    const expired = now - Date.parse(t.stagedAt) > EXPIRY_MS;
    const vanished = !openUrls.includes(t.url);
    return !expired && !vanished;
  });
  if (keep.length === all.length) return;
  for (const gone of all.filter((t) => !keep.includes(t))) {
    for (const p of [...held]) {
      if (!p.isClosed() && p.url() === gone.url) held.delete(p);
    }
    log(`stagedTabs: dropped ${gone.id} — ${gone.title || gone.url} (expired or tab gone)`);
  }
  try {
    writeJson(FILE, keep);
  } catch {
    /* best effort */
  }
}
