import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// stagedTabs (imported by jobTabs for isHeldTab) persists under stateDir — point at a temp
// brain BEFORE config loads so this test can't read or clobber the live staged-tab list.
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-jobtabs-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type JobTabs = typeof import("./jobTabs");
type StagedTabs = typeof import("./stagedTabs");

let mod: JobTabs;
let staged: StagedTabs;

/**
 * Minimal stand-ins. jobTabs only ever touches url()/isClosed()/opener() and the
 * framenavigated + page events, so a fake with those is a faithful model of the real thing —
 * and unlike a real Chrome it can reproduce the exact ordering that caused the bug.
 */
function fakePage(url: string, opener: unknown = null) {
  const handlers: Array<(frame: unknown) => void> = [];
  const p = {
    closed: false,
    _url: url,
    url: () => p._url,
    isClosed: () => p.closed,
    opener: async () => opener,
    on(_e: string, h: (frame: unknown) => void) {
      handlers.push(h);
    },
    off(_e: string, h: (frame: unknown) => void) {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
    /** Simulate a real main-frame navigation to `to`. */
    navigate(to: string) {
      p._url = to;
      for (const h of [...handlers]) h({ parentFrame: () => null });
    },
    /** Simulate an iframe/ad navigating — must never move a binding. */
    navigateSubframe() {
      for (const h of [...handlers]) h({ parentFrame: () => ({}) });
    },
    listenerCount: () => handlers.length,
  };
  return p;
}

type FakePage = ReturnType<typeof fakePage>;

function fakeContext(pages: FakePage[]) {
  const pageHandlers: Array<(p: unknown) => void> = [];
  return {
    pages: () => pages,
    on(_e: string, h: (p: unknown) => void) {
      pageHandlers.push(h);
    },
    off(_e: string, h: (p: unknown) => void) {
      const i = pageHandlers.indexOf(h);
      if (i >= 0) pageHandlers.splice(i, 1);
    },
    /** Simulate Chrome opening a new tab (a popup, or the MCP's own newTab). */
    async addPage(p: FakePage) {
      pages.push(p);
      for (const h of [...pageHandlers]) h(p);
      await new Promise((r) => setImmediate(r)); // let the opener() promise settle
    },
  };
}

const asCtx = (c: ReturnType<typeof fakeContext>) => c as unknown as Parameters<JobTabs["bindJobTab"]>[0];
const asPage = (p: FakePage) => p as unknown as Parameters<JobTabs["bindJobTab"]>[2];

/**
 * THE BUG. @playwright/mcp binds to the oldest page in the shared Chrome, not the fresh tab
 * we opened — so the run drives a leftover while the binding sits on about:blank, and the 🔐
 * screenshot photographs a blank page. The binding must follow the tab that actually moves.
 */
function adoptsTheTabTheRunActuallyDrives(): void {
  const leftover = fakePage("about:blank");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([leftover, seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));

  assert.equal(b.current(), asPage(seed), "starts on the tab it was handed");
  assert.equal(b.adopted(), false);

  leftover.navigate("https://www.amazon.com/dp/B015CH1JIW");

  assert.equal(b.current(), asPage(leftover), "follows the tab the MCP is really driving");
  assert.equal(b.adopted(), true);
  b.release();
}

/** A blank tab is a seat, not a page — it must never satisfy the binding. */
function neverAdoptsBlank(): void {
  const other = fakePage("about:blank");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([other, seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  other.navigate("about:blank");
  assert.equal(b.adopted(), false, "about:blank is not a page to bind to");
  b.release();
}

/** Ads and iframes navigate constantly; none of that is a page change. */
function ignoresSubframeNavigation(): void {
  const other = fakePage("https://ads.example.com");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([other, seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  other.navigateSubframe();
  assert.equal(b.adopted(), false);
  b.release();
}

/** Once adopted, same-tab navigation (redirect, link click) keeps the binding current. */
function followsItsOwnTab(): void {
  const seed = fakePage("about:blank");
  const ctx = fakeContext([seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  seed.navigate("https://www.amazon.com/s?k=usb");
  seed.navigate("https://www.amazon.com/dp/B015CH1JIW");
  assert.equal(b.current().url(), "https://www.amazon.com/dp/B015CH1JIW");
  b.release();
}

/**
 * The concurrency guarantee. Two live jobs both see every navigation, so an unclaimed tab is
 * only adoptable on bare evidence when this is the only job in flight. With another job live,
 * adoption requires the run to have NAMED that host itself.
 */
async function concurrentJobsDoNotStealEachOthersTabs(): Promise<void> {
  const tabA = fakePage("about:blank");
  const tabB = fakePage("about:blank");
  const seedA = fakePage("about:blank");
  const seedB = fakePage("about:blank");
  const ctx = fakeContext([tabA, tabB, seedA, seedB]);

  const a = mod.bindJobTab(asCtx(ctx), "job-a", asPage(seedA));
  const b = mod.bindJobTab(asCtx(ctx), "job-b", asPage(seedB));

  // Neither run has said where it's going: nobody may claim on a bare navigation.
  tabA.navigate("https://www.amazon.com/dp/B015CH1JIW");
  assert.equal(a.adopted(), false, "no evidence — must not guess with another job live");
  assert.equal(b.adopted(), false);

  // Now each run names its own destination through its progress stream.
  a.noteAction("navigating to https://www.amazon.com/dp/B015CH1JIW");
  b.noteAction("navigating to https://job-boards.greenhouse.io/acme");

  tabA.navigate("https://www.amazon.com/dp/B015CH1JIW?th=1");
  tabB.navigate("https://job-boards.greenhouse.io/acme/apply");

  assert.equal(a.current(), asPage(tabA), "job A took the tab it named");
  assert.equal(b.current(), asPage(tabB), "job B took the tab it named");

  // And a claimed tab is off limits even when the other job later names the same host.
  b.noteAction("navigating to https://www.amazon.com/dp/B015CH1JIW");
  tabA.navigate("https://www.amazon.com/gp/cart");
  assert.equal(b.current(), asPage(tabB), "a live job's tab is never stolen");
  assert.equal(a.current(), asPage(tabA));

  a.release();
  b.release();
}

/** A checkout/oauth popup is this run's by parentage — the strongest signal available. */
async function adoptsPopupsByOpener(): Promise<void> {
  const seed = fakePage("about:blank");
  const ctx = fakeContext([seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  seed.navigate("https://www.amazon.com/gp/cart");

  const popup = fakePage("https://www.amazon.com/checkout", seed);
  await ctx.addPage(popup);

  assert.equal(b.current(), asPage(popup), "binding moves to the window the run opened");
  b.release();
}

/**
 * A tab left for the owner isn't grabbed on a bare navigation. It can redirect, refresh its
 * session, or bounce through an SSO hop entirely on its own while an unrelated run happens to
 * be live — none of that is evidence that THIS run is driving it.
 */
function neverAdoptsAHeldTabWithoutNamedEvidence(): void {
  const stagedTab = fakePage("about:blank");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([stagedTab, seed]);
  staged.holdTab(stagedTab as unknown as Parameters<StagedTabs["holdTab"]>[0]);

  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  stagedTab.navigate("https://job-boards.greenhouse.io/acme/apply");
  assert.equal(b.adopted(), false, "a staged tab is the owner's absent evidence we drove it");
  b.release();
}

/**
 * The 2026-08-14 bug, in one test. A previous run staged an amazon tab. The next run opens its
 * seed, but @playwright/mcp binds the OLDER staged tab and drives it. Vetoing adoption there
 * left the binding on the blank seed, so the place-order 🔐 photographed an empty page and the
 * owner was asked to approve a purchase they couldn't see. Naming the host is what makes it
 * ours to look at.
 */
function adoptsAHeldTabThisRunNamed(): void {
  const stagedTab = fakePage("https://www.amazon.com/gp/cart");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([stagedTab, seed]);
  staged.holdTab(stagedTab as unknown as Parameters<StagedTabs["holdTab"]>[0]);

  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  b.noteAction("navigating to https://www.amazon.com/dp/B01E17LOMU");
  stagedTab.navigate("https://www.amazon.com/dp/B01E17LOMU");

  assert.equal(b.adopted(), true, "the run named this host — it is the tab being driven");
  assert.equal(b.current(), asPage(stagedTab), "🔐 shots must photograph it, not the blank seed");
  assert.equal(
    mod.isUnownedTab(asPage(stagedTab)),
    false,
    "adopting it must not make it reapable — it is still the owner's tab",
  );
  b.release();
  assert.equal(
    mod.isUnownedTab(asPage(stagedTab)),
    false,
    "and the hold outlives the run that took it over",
  );
}

/**
 * Explicit resume: chrome.ts hands back the held Page itself as the seed. The run owns it from
 * navigation zero, work already typed into it intact, and the hold survives the run.
 */
function resumedHeldTabIsTheRunsTabFromZero(): void {
  const stagedTab = fakePage("https://myworkday.com/acme/apply/step3");
  const ctx = fakeContext([stagedTab]);
  staged.holdTab(stagedTab as unknown as Parameters<StagedTabs["holdTab"]>[0]);

  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(stagedTab));
  assert.equal(b.current(), asPage(stagedTab), "the resumed tab is the binding immediately");
  stagedTab.navigate("https://myworkday.com/acme/apply/step4");
  assert.equal(b.current(), asPage(stagedTab), "and the binding follows it forward");
  b.release();
  assert.equal(mod.isUnownedTab(asPage(stagedTab)), false, "still held for the owner after");
}

/**
 * Resolving "the staged one I mean". The model will name it however it remembers it — the id
 * fig reported, the full URL, or just the site — and all three have to land on the same live
 * Page, because the alternative is silently opening a fresh tab and re-typing the form.
 */
function findHeldPageResolvesIdUrlAndHost(): void {
  const url = "https://myworkday.com/acme/apply/step3";
  const heldTab = fakePage(url);
  const other = fakePage("https://example.com/unrelated");
  const pages = [heldTab, other] as unknown as Parameters<StagedTabs["findHeldPage"]>[0];

  const rec = staged.stageTab(heldTab as unknown as Parameters<StagedTabs["stageTab"]>[0], {
    url,
    title: "Acme — Application",
    reason: "filled, not submitted",
  });

  assert.equal(staged.findHeldPage(pages, rec.id), heldTab as unknown, "by staged id");
  assert.equal(staged.findHeldPage(pages, url), heldTab as unknown, "by full url");
  assert.equal(staged.findHeldPage(pages, "myworkday.com"), heldTab as unknown, "by bare host");
  assert.equal(staged.findHeldPage(pages, "nope.com"), null, "no match means open a fresh tab");
  assert.equal(
    staged.findHeldPage(pages, "example.com"),
    null,
    "an unheld tab is not resumable — only work actually staged is",
  );
  assert.equal(staged.liveStagedTabs(pages).length, 1, "and it reads back as resumable");
  staged.releaseStagedTab(rec.id);
}

/** Reap safety: claimed and held tabs are untouchable; ordinary leftovers are not. */
function unownedIsWhatTheReapCanTouch(): void {
  const leftover = fakePage("https://example.com/leftover");
  const seed = fakePage("about:blank");
  const heldTab = fakePage("https://example.com/held");
  const ctx = fakeContext([leftover, seed, heldTab]);
  staged.holdTab(heldTab as unknown as Parameters<StagedTabs["holdTab"]>[0]);

  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  assert.equal(mod.isUnownedTab(asPage(leftover)), true, "a leftover nobody owns is reapable");
  assert.equal(mod.isUnownedTab(asPage(seed)), false, "a live job's tab is not");
  assert.equal(mod.isUnownedTab(asPage(heldTab)), false, "a held tab is not");
  b.release();
  assert.equal(mod.isUnownedTab(asPage(seed)), true, "released when the run ends");
  assert.equal(mod.isUnownedTab(asPage(heldTab)), false, "still the owner's after the run");
}

/** Release must drop every listener, or long-lived tabs accumulate handlers per run. */
function releaseDetachesListeners(): void {
  const other = fakePage("https://example.com");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([other, seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  assert.equal(other.listenerCount(), 1);
  b.release();
  assert.equal(other.listenerCount(), 0);
  assert.equal(seed.listenerCount(), 0);
  // And a navigation after release is inert rather than reviving a dead binding.
  other.navigate("https://example.com/after");
  assert.equal(b.adopted(), false);
}

/** A closed tab can't be photographed — fall back to the seat rather than hand back a corpse. */
function fallsBackWhenTheAdoptedTabDies(): void {
  const other = fakePage("about:blank");
  const seed = fakePage("about:blank");
  const ctx = fakeContext([other, seed]);
  const b = mod.bindJobTab(asCtx(ctx), "job-1", asPage(seed));
  other.navigate("https://example.com/gone");
  assert.equal(b.current(), asPage(other));
  other.closed = true;
  assert.equal(b.current(), asPage(seed), "closed tab falls back to the run's own seat");
  b.release();
}

/** noteAction only cares about navigations; other chatter must not invent an intent. */
function noteActionIgnoresNonNavigation(): void {
  const other = fakePage("about:blank");
  const seedA = fakePage("about:blank");
  const seedB = fakePage("about:blank");
  const ctx = fakeContext([other, seedA, seedB]);
  const a = mod.bindJobTab(asCtx(ctx), "job-a", asPage(seedA));
  const b = mod.bindJobTab(asCtx(ctx), "job-b", asPage(seedB));
  a.noteAction("clicking Add to Cart on amazon.com");
  other.navigate("https://www.amazon.com/gp/cart");
  assert.equal(a.adopted(), false, "a click mentioning a host is not a navigation to it");
  a.release();
  b.release();
}

async function main(): Promise<void> {
  mod = await import("./jobTabs");
  staged = await import("./stagedTabs");
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["adoptsTheTabTheRunActuallyDrives", adoptsTheTabTheRunActuallyDrives],
    ["neverAdoptsBlank", neverAdoptsBlank],
    ["ignoresSubframeNavigation", ignoresSubframeNavigation],
    ["followsItsOwnTab", followsItsOwnTab],
    ["concurrentJobsDoNotStealEachOthersTabs", concurrentJobsDoNotStealEachOthersTabs],
    ["adoptsPopupsByOpener", adoptsPopupsByOpener],
    ["neverAdoptsAHeldTabWithoutNamedEvidence", neverAdoptsAHeldTabWithoutNamedEvidence],
    ["adoptsAHeldTabThisRunNamed", adoptsAHeldTabThisRunNamed],
    ["resumedHeldTabIsTheRunsTabFromZero", resumedHeldTabIsTheRunsTabFromZero],
    ["findHeldPageResolvesIdUrlAndHost", findHeldPageResolvesIdUrlAndHost],
    ["unownedIsWhatTheReapCanTouch", unownedIsWhatTheReapCanTouch],
    ["releaseDetachesListeners", releaseDetachesListeners],
    ["fallsBackWhenTheAdoptedTabDies", fallsBackWhenTheAdoptedTabDies],
    ["noteActionIgnoresNonNavigation", noteActionIgnoresNonNavigation],
  ];
  try {
    for (const [name, fn] of tests) {
      mod.resetJobTabs();
      try {
        await fn();
      } catch (e) {
        console.error(`browser/jobTabs.test.ts: FAILED ${name}`);
        throw e;
      }
    }
    console.log(`browser/jobTabs.test.ts: ${tests.length} passed`);
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
