import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The registry persists under stateDir, so point at a temp brain BEFORE config is imported —
// otherwise this test would read (and clobber) the live staged-tab list.
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-stagedtabs-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type StagedTabs = typeof import("./stagedTabs");
type FakePage = { url(): string; isClosed(): boolean; close?: () => void };

let mod: StagedTabs;

/** Minimal stand-in for a playwright Page — hold/reap only ever touch url() and isClosed(). */
function fakePage(url: string): FakePage & { closed: boolean } {
  const p = {
    closed: false,
    url: () => url,
    isClosed(): boolean {
      return p.closed;
    },
  };
  return p;
}

// stageTab's parameter, not holdTab's: holdTab also accepts `undefined`, and a helper typed
// that wide can't be passed to stageTab at all (tsc rejected every call site).
const asPage = (p: FakePage) => p as unknown as Parameters<StagedTabs["stageTab"]>[0];

/** Nothing is held until something says so — the default has to stay "this tab is disposable". */
function defaultsToUnheld(): void {
  const page = fakePage("https://example.com/one");
  assert.equal(mod.isHeldTab(asPage(page)), false);
  assert.deepEqual(mod.listStagedTabs(), []);
}

/** The core guarantee: a staged tab reports as held, so closeJobTab refuses to reap it. */
function stagingHoldsTheTab(): void {
  const page = fakePage("https://boards.greenhouse.io/samsara/jobs/123");
  const rec = mod.stageTab(asPage(page), {
    url: page.url(),
    title: "Samsara — SWE I",
    reason: "filled except resume upload; do not submit",
    label: "apply",
  });
  assert.ok(rec.id, "gets an id so a release can name it");
  assert.equal(mod.isHeldTab(asPage(page)), true, "staged tab must be held");
  const all = mod.listStagedTabs();
  assert.equal(all.length, 1);
  assert.equal(all[0].reason, "filled except resume upload; do not submit");
}

/** Held by object identity, not URL — a redirect must not silently drop the protection. */
function holdSurvivesUrlChange(): void {
  const page = fakePage("https://example.com/form");
  mod.holdTab(asPage(page));
  const moved = { ...page, url: () => "https://example.com/form?step=2" } as FakePage;
  assert.equal(mod.isHeldTab(asPage(page)), true);
  assert.equal(mod.isHeldTab(asPage(moved)), false, "a different Page object is not the held one");
}

/** A closed tab can't be held — stale entries must not keep answering true forever. */
function closedTabIsNotHeld(): void {
  const page = fakePage("https://example.com/gone");
  mod.holdTab(asPage(page));
  page.closed = true;
  assert.equal(mod.isHeldTab(asPage(page)), false);
}

/** They submitted it (or gave up): release drops both the hold and the registry row. */
function releaseFreesTheTab(): void {
  const page = fakePage("https://example.com/release-me");
  const rec = mod.stageTab(asPage(page), { url: page.url(), title: "t", reason: "r" });
  assert.equal(mod.releaseStagedTab(rec.id)?.id, rec.id);
  assert.equal(mod.isHeldTab(asPage(page)), false, "released → reapable");
  assert.equal(
    mod.listStagedTabs().some((t) => t.id === rec.id),
    false,
  );
  assert.equal(mod.releaseStagedTab("nope"), null, "unknown id is a no-op, not a throw");
}

/** Chrome restarted: the tab is gone, so the row is a lie and gets dropped. */
function reapDropsVanishedTabs(): void {
  const page = fakePage("https://example.com/vanished");
  mod.stageTab(asPage(page), { url: page.url(), title: "t", reason: "r" });
  mod.reapExpiredStagedTabs(["https://example.com/something-else"]);
  assert.equal(
    mod.listStagedTabs().some((t) => t.url === "https://example.com/vanished"),
    false,
  );
}

/** ...but a tab that IS still open survives the sweep. Unsubmitted work outlives tidiness. */
function reapKeepsLiveTabs(): void {
  const page = fakePage("https://example.com/still-here");
  mod.stageTab(asPage(page), { url: page.url(), title: "t", reason: "r" });
  mod.reapExpiredStagedTabs(["https://example.com/still-here"]);
  assert.equal(
    mod.listStagedTabs().some((t) => t.url === "https://example.com/still-here"),
    true,
  );
  assert.equal(mod.isHeldTab(asPage(page)), true, "still held after a sweep");
}

async function main(): Promise<void> {
  mod = await import("./stagedTabs");
  try {
    defaultsToUnheld();
    stagingHoldsTheTab();
    holdSurvivesUrlChange();
    closedTabIsNotHeld();
    releaseFreesTheTab();
    reapDropsVanishedTabs();
    reapKeepsLiveTabs();
    console.log("browser/stagedTabs.test.ts: 7 passed");
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
