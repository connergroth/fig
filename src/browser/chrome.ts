import type { BrowserContext, Page } from "playwright";

import { config } from "../core/config";
import { log } from "../core/log";
import { isUnownedTab } from "./jobTabs";
import { findHeldPage, isHeldTab, reapExpiredStagedTabs } from "./stagedTabs";

/**
 * Lazy-load Playwright so a machine that hasn't run `npm install` yet (deps aren't
 * synced across machines — see .stignore) still BOOTS: the bot's messaging/email/etc.
 * keep working and only browsing degrades, instead of a missing optional dep crashing
 * the whole daemon at startup. The error surfaces only when something actually drives
 * the browser.
 */
async function chromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright isn't installed on this machine. Run `npm install` (deps aren't synced across machines) and `npx playwright install chromium`.",
    );
  }
}

/**
 * The bot owns ONE shared Chromium. Both the browse specialist (via @playwright/mcp,
 * which connects over --cdp-endpoint) and the credential injector (which reuses the
 * in-process context directly) drive the same browser, so fill_login reads page.url()
 * of the exact tab the model is on. See config.browser for the why.
 *
 * Cached for the process. ensureBrowserChrome() is idempotent: concurrent callers share
 * the one launch, a live context is reused, and a previously-launched debug Chrome (e.g.
 * one that outlived a bot restart) is reconnected over CDP rather than relaunched.
 */
let ctx: BrowserContext | null = null;
let launching: Promise<BrowserContext> | null = null;

export function cdpEndpoint(): string {
  return `http://127.0.0.1:${config.browser.cdpPort}`;
}

export async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint()}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Drop the cached context so the next ensureBrowserChrome() re-attaches (or relaunches)
 * from scratch instead of handing back a context whose underlying Chrome has died. Used by
 * the browse specialist's mid-run reconnect: after a Chrome/CDP crash, a stale cached ctx
 * can still look "open" (its .pages() doesn't always throw synchronously), so we clear it
 * explicitly before retrying to guarantee a fresh CDP connection.
 */
export function resetBrowserChrome(): void {
  ctx = null;
}

/**
 * Poll the CDP endpoint a few times before concluding no debug Chrome is up. Guards the
 * cold-start race: a persistent Chrome (a launchd daemon, or one still coming up right
 * after a bot restart) doesn't have its debug port listening for the first second or two.
 * A single check would return false and send us down the LAUNCH path — which then fails on
 * the profile's SingletonLock because that other Chrome already holds it, and we can't
 * attach either because its port wasn't up yet. That's the "won't drive / had to flip
 * remote-debugging manually" flakiness. Retrying lets us attach to the browser that's
 * already coming up instead of fighting it for the profile. Cheap: on a genuine cold start
 * (no Chrome at all) this adds ~1s before we launch, dwarfed by Chrome's own boot time.
 */
async function cdpAliveWithRetry(attempts = 3, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await cdpAlive()) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/** Attach to a live debug Chrome over CDP, returning its context. Null if attach fails. */
async function attachOverCdp(): Promise<BrowserContext | null> {
  try {
    const browser = await (await chromium()).connectOverCDP(cdpEndpoint());
    const existing = browser.contexts()[0] ?? (await browser.newContext());
    log(`browser: reattached to Chrome on ${cdpEndpoint()}`);
    return existing;
  } catch (e) {
    // The port answered /json/version a moment ago but the CDP handshake failed (Chrome
    // shutting down, or a transient race). Let the caller fall through to launch.
    log(`browser: CDP attach failed on ${cdpEndpoint()} (${e}); will try launching`);
    return null;
  }
}

export async function ensureBrowserChrome(): Promise<BrowserContext> {
  if (ctx) {
    try {
      ctx.pages(); // throws if the context was closed out from under us
      return ctx;
    } catch {
      ctx = null;
    }
  }
  if (launching) return launching;

  launching = (async () => {
    // Reconnect to an already-running debug Chrome (one that survived a bot restart, or a
    // manually-launched debug Chrome) instead of fighting it for the profile lock.
    // Poll rather than check once, so a Chrome that's mid-boot is attached to — not raced.
    if (await cdpAliveWithRetry()) {
      const existing = await attachOverCdp();
      if (existing) {
        ctx = existing;
        return existing;
      }
      // Port was up but the handshake lost a race — fall through to launch below.
    }

    // Launch options shared by both the real-Chrome and fallback paths. We strip the
    // automation fingerprint so aggressive bot-detection (X) doesn't flag us: drop the
    // --enable-automation switch and hide navigator.webdriver.
    const launchOpts = {
      headless: false as const,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        `--remote-debugging-port=${config.browser.cdpPort}`,
        "--disable-blink-features=AutomationControlled",
      ],
    };

    const cm = await chromium();
    let context: BrowserContext;
    try {
      // Drive the REAL Google Chrome stable, not Playwright's bundled Chrome-for-Testing
      // Chromium. Sites with hard browser-integrity walls (X/Twitter especially) reject
      // Chrome-for-Testing as "not a secure browser" — the branded build ships the proper
      // UA + Widevine/secure components, so it passes.
      log(`browser: launching shared Chrome stable (profile ${config.browser.userDataDir}, cdp :${config.browser.cdpPort})`);
      context = await cm.launchPersistentContext(config.browser.userDataDir, { channel: "chrome", ...launchOpts });
    } catch (e) {
      // The launch failed. Two very different causes, so disambiguate before falling back:
      //  1. Profile lock held by a NON-debug Chrome (e.g. someone ran `npm run browser:login`,
      //     which opens the profile WITHOUT --remote-debugging-port). We can't attach (no port)
      //     and can't launch (SingletonLock held). One more CDP poll in case a real debug Chrome
      //     just finished coming up and won the race; otherwise surface an actionable error
      //     instead of a raw Chromium stack trace.
      //  2. Chrome stable simply isn't installed — degrade to bundled Chromium so the bot still
      //     browses (just won't clear the strictest integrity walls).
      const lockHeld = String(e).includes("ProcessSingleton") || String(e).includes("SingletonLock") || String(e).includes("already running");
      if (lockHeld) {
        if (await cdpAliveWithRetry()) {
          const existing = await attachOverCdp();
          if (existing) {
            ctx = existing;
            return existing;
          }
        }
        throw new Error(
          `The ${config.browser.userDataDir} profile is locked by another Chrome that has no remote-debugging port, ` +
            `so the browser can't attach or relaunch. This is usually a \`npm run browser:login\` Chrome left open. ` +
            `Close that Chrome (or relaunch it WITH --remote-debugging-port=${config.browser.cdpPort}) and retry. Original: ${e}`,
        );
      }
      log(`browser: Chrome stable unavailable (${e}); falling back to bundled Chromium`);
      context = await cm.launchPersistentContext(config.browser.userDataDir, launchOpts);
    }
    ctx = context;
    return context;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/**
 * Give a browse job its OWN tab in the shared Chrome, focused and blank.
 *
 * Why this exists: every browse job attaches to the SAME persistent Chrome over CDP (that's
 * what keeps it logged in as the owner — a fresh BrowserContext would be incognito-clean and
 * therefore signed out of everything). Same context means two concurrent jobs otherwise
 * share a tab and navigate out from under each other. Observed 2026-08-05: the daily
 * job-sweep and a second browse job traded tabs mid-run and one page read came back as a
 * completely different site — a WRONG READ, which is far worse than a crash, because it
 * gets reported as fact.
 *
 * Isolation therefore has to happen at the TAB level, not the context level. This opens a
 * fresh page and brings it to front — and, critically, REAPS every tab no live job owns and
 * nobody is holding for the owner first.
 *
 * The reap is not tidiness, it's the binding. @playwright/mcp picks its current tab in
 * `_onPageCreated` with `if (!this._currentTab)` over the pages already open when it attaches
 * — so it binds to the OLDEST tab in the shared Chrome, never the newest or the focused one.
 * Bringing a fresh tab to front does nothing to it. Clearing the unowned leftovers is what
 * leaves the MCP nothing to bind to except this job's tab in the ordinary single-job case.
 *
 * NOTE: still necessary-but-not-sufficient — a HELD tab (staged application, live handoff)
 * legitimately outlives its run and is older than ours, so it can still win the MCP's pick.
 * That case is caught after the fact by adoption in jobTabs.ts, which follows the tab the run
 * actually navigates, held or not, once the run has named that host itself. The run also
 * carries a prompt-level rule to re-verify its URL before acting. Structure narrows the window,
 * adoption closes it, the assert backs both up.
 *
 * When the staged tab is the POINT — continuing a half-filled application — pass `resume` and
 * the run is bound to it directly, so the typed-in work is picked up instead of re-done on a
 * fresh tab that then has to compete with it.
 *
 * The Page returned here is the run's binding for everything that works OUTSIDE the MCP —
 * stage_for_review, request_handoff, the credential injector, the 🔐 screenshot. They're handed
 * this object (browser.ts's jobPageRef) instead of re-deriving "the current tab", which they
 * cannot do correctly: see activeBrowserPage below for what that cost.
 */
export async function openJobTab(
  context: BrowserContext,
  opts: { resume?: string } = {},
): Promise<Page> {
  // RESUME: the run explicitly wants a tab that was staged for the owner — a half-filled
  // application, a cart waiting on approval. Opening a fresh tab there is the wrong answer
  // twice over: the work already on the page is thrown away and re-done from scratch, and the
  // staged tab is left behind as an older sibling that the MCP will bind to anyway. So bind
  // the run TO it. The hold stays on (this is still the owner's tab, no run may close it);
  // what changes is that the run now owns the binding, so the 🔐 shot and the injector aim at
  // the page actually being driven.
  if (opts.resume) {
    const existing = findHeldPage(context.pages(), opts.resume);
    if (existing) {
      await existing.bringToFront().catch(() => {});
      log(`openJobTab: resuming tab staged for the owner — ${existing.url()}`);
      return existing;
    }
    // Registry row with no live page = Chrome restarted since. Fall through and open fresh
    // rather than pretending the typed-in work survived.
    log(`openJobTab: no live staged tab matching "${opts.resume}" — opening a fresh one`);
  }

  // Open this job's tab BEFORE reaping, so the context is never momentarily empty (Chrome
  // exits with its last tab) and every leftover is therefore reapable — including the oldest,
  // which is precisely the one the MCP would otherwise bind to.
  const page = await context.newPage();
  await page.bringToFront().catch(() => {
    /* headless or detached — front-ness is cosmetic; the binding is the reap plus adoption */
  });

  // Leftovers from a dead or finished run are what the MCP grabs instead of this job's tab.
  // Only tabs that no live job has claimed AND nobody is holding for the owner are touched, so
  // a staged application or a live sign-in is out of reach by construction, not by policy.
  for (const p of context.pages()) {
    if (p === page || p.isClosed() || !isUnownedTab(p)) continue;
    log(`openJobTab: reaping unowned leftover tab ${p.url()}`);
    await p.close().catch(() => {});
  }

  // Housekeeping on the staged registry: drop rows whose tab died with a Chrome restart, and
  // let go of anything past its window, so holds can't pile up forever.
  reapExpiredStagedTabs(
    context
      .pages()
      .filter((p) => !p.isClosed())
      .map((p) => p.url()),
  );
  return page;
}

/**
 * Retire a job's tab when its run ends. Never closes the last tab (Chrome would exit), and
 * never closes a HELD tab — one handed to the owner mid-login, or one staged for their review with
 * a filled-but-unsubmitted form on it. Leaving work for them IS the deliverable in the tier-1
 * application path, so the run's own exit must not be able to destroy it.
 */
export async function closeJobTab(context: BrowserContext, page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;
  if (isHeldTab(page)) {
    log("closeJobTab: tab is held for the owner (staged/handoff) — leaving it open");
    return;
  }
  if (context.pages().filter((p) => !p.isClosed()).length <= 1) return;
  await page.close().catch(() => {
    /* already gone / mid-navigation — nothing to clean up */
  });
}

/**
 * Guess the tab the model is driving: the focused tab, else the visible one, else the most
 * recently opened. @playwright/mcp doesn't expose its "current tab", so there's nothing better
 * to go on — but it IS a guess, and with two browse jobs in the shared Chrome it lands on the
 * other job's tab as often as not.
 *
 * Which is why nothing on the job path calls this any more. Staging, handoff, the credential
 * injector and the 🔐 screenshot are all handed the run's own Page by src/specialists/browser.ts
 * (see openJobTab above); on 2026-08-13 this heuristic had them staging, photographing and
 * origin-checking a neighbouring job's page instead. Left for the dev scripts under scripts/dev,
 * which drive a Chrome with one tab in it and no concurrency to be wrong about.
 */
export async function activeBrowserPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages().filter((p) => !p.isClosed());
  if (pages.length === 0) throw new Error("no open browser tab — navigate to the login page first");
  if (pages.length === 1) return pages[0];

  for (const p of pages) {
    try {
      if (await p.evaluate<boolean>("document.hasFocus()")) return p;
    } catch {
      /* page mid-navigation — skip */
    }
  }
  for (const p of pages) {
    try {
      if (await p.evaluate<boolean>("document.visibilityState === 'visible'")) return p;
    } catch {
      /* ignore */
    }
  }
  return pages[pages.length - 1];
}
