import type { BrowserContext, Frame, Page } from "playwright";

import { log } from "../core/log";
import { isHeldTab } from "./stagedTabs";

/**
 * Which tab is a browse job ACTUALLY driving?
 *
 * The naive answer — "the fresh tab we opened for it" (chrome.ts openJobTab) — is wrong, and
 * the reason is in @playwright/mcp itself. Its Context sets `_currentTab` in `_onPageCreated`
 * with `if (!this._currentTab)`, and every page already open in the context is registered at
 * attach time. So the MCP binds to the FIRST page it sees — the oldest tab in the shared
 * Chrome — not the newest or the focused one. openJobTab's tab is created BEFORE the MCP
 * attaches, lands at the END of that list, and is never adopted. It sits on about:blank for
 * the whole run while the model drives some other tab.
 *
 * Everything that runs beside the MCP reads that binding: the credential injector, staging,
 * handoff, and the 🔐 approval screenshot. A wrong binding therefore means typing into the
 * wrong page, staging the wrong page, or — the one the owner actually sees — photographing a
 * blank tab and shipping a white rectangle as "here's what you're approving."
 *
 * So the binding FOLLOWS the run instead of leading it, in two layers:
 *
 *  1. Structural (chrome.ts): reap tabs nobody owns before opening this job's, so in the
 *     common single-job case the MCP has nothing to bind to EXCEPT this job's tab.
 *  2. Adoption (here): watch main-frame navigations. The first real page this run navigates
 *     that no other live job has claimed becomes this run's tab, and stays claimed until the
 *     run ends. Popups are attributed by `opener()`, so a checkout that opens a new window
 *     doesn't strand the binding on the page it came from.
 *
 * Concurrency is what makes layer 2 non-trivial: two live jobs both see every navigation. An
 * unclaimed tab is only adopted on a bare navigation when this is the ONLY live job. With
 * others in flight, adoption additionally requires the URL's host to match one this run
 * announced through its own progress stream (`noteAction`) — the model's own browser_navigate
 * argument, which is the one piece of evidence that names the tab from the inside.
 *
 * HELD TABS (staged form, live sign-in) get the same named-evidence rule and nothing stronger.
 * They outlive their run by design, which makes them older than ours and therefore exactly what
 * the MCP's oldest-tab pick lands on. Vetoing adoption on them — the first version of this file
 * — protected nothing: the MCP drove that tab regardless, and the veto only stranded the
 * binding on the blank seed, so the 🔐 photographed an empty page. Not-looking is not
 * protection. A held tab's protection is that closeJobTab never closes it; this file's job is
 * to answer honestly which tab is live, and a run that named the host is driving it.
 *
 * Resuming staged work is therefore a first-class path, not a collision: chrome.ts openJobTab
 * takes a `resume` target, hands the held Page back as the seed, and the claim below makes it
 * the run's tab from navigation zero with everything already typed into it intact.
 */

/** Page → id of the live job that owns it. Object identity, so a redirect can't defeat it. */
const claims = new Map<Page, string>();

/** Live bindings by job id, so "how many jobs are in flight" is answerable. */
const bindings = new Map<string, JobTabBinding>();

export type JobTabBinding = {
  jobId: string;
  /** The tab this run is driving, best evidence available. Never null while the run is live. */
  current(): Page;
  /** Feed the run's progress one-liners in; used to attribute navigations under concurrency. */
  noteAction(action: string): void;
  /** Has a real (non-blank) page been adopted yet? */
  adopted(): boolean;
  /** Run over: drop listeners and release claims, except tabs held for the owner. */
  release(): void;
};

/** Is this tab spoken for by a live job other than `jobId`? */
export function isClaimedTab(page: Page, jobId?: string): boolean {
  const owner = claims.get(page);
  return owner !== undefined && owner !== jobId;
}

/** Tabs no live job owns and nobody is holding for the owner — safe to reap. */
export function isUnownedTab(page: Page): boolean {
  return !claims.has(page) && !isHeldTab(page);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A tab on about:blank (or Chrome's new-tab page) is a seat, not a page — never adoptable. */
function isBlank(url: string): boolean {
  return !url || url === "about:blank" || url.startsWith("chrome://newtab");
}

/**
 * Start following a browse run's real tab.
 *
 * `seed` is the tab chrome.ts opened for it — claimed immediately so a concurrent job can't
 * adopt it, and used as the binding until something real gets adopted. A run that never
 * navigates (an immediate failure) therefore still has a valid, if empty, Page rather than a
 * null nobody checked for.
 */
export function bindJobTab(context: BrowserContext, jobId: string, seed: Page): JobTabBinding {
  claims.set(seed, jobId);

  let currentPage = seed;
  let hasAdopted = false;
  let released = false;
  /** Hosts this run asked for by name (from browser_navigate), newest first. */
  const intendedHosts: string[] = [];
  const cleanups: Array<() => void> = [];

  const adopt = (page: Page, why: string): void => {
    claims.set(page, jobId);
    currentPage = page;
    hasAdopted = true;
    log(`jobTabs[${jobId}]: bound to ${page.url()} (${why})`);
  };

  const onNavigated = (page: Page): void => {
    if (released || page.isClosed()) return;
    const url = page.url();
    if (isBlank(url)) return;

    const owner = claims.get(page);
    if (owner === jobId) {
      // Our own tab moved — follow it. Covers redirects and same-tab link clicks.
      if (currentPage !== page) log(`jobTabs[${jobId}]: following own tab to ${url}`);
      currentPage = page;
      hasAdopted = true;
      return;
    }
    if (owner) return; // another live job's tab — not ours to look at, let alone photograph

    const host = hostOf(url);
    const announced = host !== null && intendedHosts.includes(host);

    if (isHeldTab(page)) {
      // A held tab (staged form, live sign-in) deliberately outlives its run, so it is OLDER
      // than ours and wins @playwright/mcp's oldest-tab pick — the model ends up driving it.
      //
      // Refusing to adopt never protected it. The MCP was navigating that tab either way; all
      // the veto did was strand OUR binding on the blank seed, so the 🔐 shot photographed an
      // empty page, the credential injector aimed at the wrong tab, and staging re-staged
      // nothing. Not-looking is not protection. Protection is closeJobTab, which never closes a
      // held tab; knowing which tab is live is this file's job and it has to answer honestly.
      //
      // Named evidence is still required, and that is the whole safety margin: the run must
      // have asked for this host BY NAME through its own browser_navigate. That separates "this
      // run is deliberately resuming the staged tab" from "a staged tab redirected on its own
      // while an unrelated job happened to be running". The bare only-live-job fallback below
      // is never enough to take one over.
      if (!announced) return;
      adopt(page, "resumed a tab held for the owner — host named by this run");
      return;
    }

    if (announced) {
      adopt(page, "host matches a URL this run navigated to");
      return;
    }
    // No naming evidence. Safe only when there's no one else it could belong to.
    if (bindings.size <= 1 && !hasAdopted) adopt(page, "only live browse job");
  };

  const watchPage = (page: Page): void => {
    const handler = (frame: Frame) => {
      if (frame.parentFrame()) return; // sub-frame (ads, iframes) — not a page change
      onNavigated(page);
    };
    page.on("framenavigated", handler);
    cleanups.push(() => page.off("framenavigated", handler));
  };

  for (const p of context.pages()) if (!p.isClosed()) watchPage(p);

  const onNewPage = (page: Page): void => {
    watchPage(page);
    // A popup opened FROM one of our tabs is ours by parentage — the strongest signal there
    // is, and the one that keeps a checkout/oauth window from stranding the binding.
    void page
      .opener()
      .then((opener) => {
        if (released || !opener) return;
        if (claims.get(opener) === jobId) adopt(page, "popup opened from this run's tab");
      })
      .catch(() => {
        /* page died before we could ask */
      });
  };
  context.on("page", onNewPage);
  cleanups.push(() => context.off("page", onNewPage));

  const binding: JobTabBinding = {
    jobId,
    current: () => (currentPage.isClosed() && !seed.isClosed() ? seed : currentPage),
    adopted: () => hasAdopted,
    noteAction(action: string) {
      // The model's own browser_navigate argument, as rendered for the job board
      // ("navigating to https://…"). Cheap to read here and it's the only in-band evidence
      // that names the tab from inside the run.
      const m = /\bnavigating to (\S+)/i.exec(action);
      if (!m) return;
      const host = hostOf(m[1].startsWith("http") ? m[1] : `https://${m[1]}`);
      if (host && !intendedHosts.includes(host)) intendedHosts.unshift(host);
    },
    release() {
      if (released) return;
      released = true;
      for (const c of cleanups) {
        try {
          c();
        } catch {
          /* listener target already gone */
        }
      }
      cleanups.length = 0;
      // Claims are per-run and all of them go. A tab left for the owner doesn't need one:
      // isHeldTab already blocks both adoption and reaping, and it's the state that actually
      // tracks whether the tab is still theirs — a stale claim would outlive the hold and
      // quietly make the tab un-reapable forever.
      for (const [page, owner] of [...claims]) if (owner === jobId) claims.delete(page);
      bindings.delete(jobId);
    },
  };
  bindings.set(jobId, binding);
  return binding;
}

/** Test seam: forget every claim and binding. */
export function resetJobTabs(): void {
  claims.clear();
  bindings.clear();
}
