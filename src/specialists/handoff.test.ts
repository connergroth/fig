import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// stage_for_review writes the staged-tab registry under stateDir, so point at a temp brain
// BEFORE config is imported — otherwise this test would clobber the live staged-tab list.
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-handoff-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

import type { BrowserContext, Page } from "playwright";

/**
 * The job↔tab binding.
 *
 * The bug this pins (2026-08-13, five runs in a row): stage_for_review resolved "your tab" with
 * activeBrowserPage() — the frontmost tab in the shared Chrome — so with a second browse job open
 * it staged and reported a completely unrelated page as the owner's filled application. The tools
 * here now read the Page this run was HANDED, or refuse. Both halves are tested, because the
 * refusal is the load-bearing one: falling back to a guess is precisely the failure.
 */

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

/** Minimal stand-in for a Page: these tools only ever call url(), title() and isClosed(). */
function fakePage(url: string, opts: { focused?: boolean } = {}) {
  const p = {
    closed: false,
    url: () => url,
    title: async () => `title of ${url}`,
    isClosed: () => p.closed,
    // activeBrowserPage's heuristic runs document.hasFocus() / visibilityState in the page.
    evaluate: async (expr: string) => (expr.includes("hasFocus") ? !!opts.focused : !!opts.focused),
  };
  return p;
}

type FakePage = ReturnType<typeof fakePage>;
const asPage = (p: FakePage) => p as unknown as Page;

/** Call one tool on an SDK MCP server the way the model would — over a real MCP session. */
async function callTool(server: unknown, name: string, args: Record<string, unknown>): Promise<string> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handoff-test", version: "1.0.0" });
  await (server as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverSide);
  await client.connect(clientSide);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    return (res.content ?? []).map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const { makeHandoffServer } = await import("./handoff");
  const { listStagedTabs, isHeldTab } = await import("../browser/stagedTabs");
  const { activeBrowserPage } = await import("../browser/chrome");

  console.log("handoff: the run stages ITS tab, not the frontmost one");

  try {
    await check("the frontmost tab is a DIFFERENT job's — staging still lands on ours", async () => {
      const jobTab = fakePage("https://boards.example.com/samsara/apply");
      const otherJob = fakePage("https://oracle.com/careers", { focused: true });
      // The old resolution, run for real: with another job's tab in front, this is what
      // stage_for_review used to be handed. Pinning it makes the divergence the point.
      const ctx = { pages: () => [asPage(jobTab), asPage(otherJob)] } as unknown as BrowserContext;
      assert.equal(await activeBrowserPage(ctx), asPage(otherJob), "the guess picks the wrong tab — that's the bug");

      const out = await callTool(makeHandoffServer(() => asPage(jobTab)), "stage_for_review", {
        reason: "filled except resume upload; do not submit",
        label: "apply",
      });
      assert.match(out, /boards\.example\.com\/samsara\/apply/, "reports the URL of the tab it was handed");
      assert.ok(!out.includes("oracle.com"), "never reports another job's page as the staged one");

      const rows = listStagedTabs();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].url, "https://boards.example.com/samsara/apply", "the registry row is the bound page too");
      assert.equal(isHeldTab(asPage(jobTab)), true, "and the bound tab is held from cleanup");
      assert.equal(isHeldTab(asPage(otherJob)), false, "the neighbour is untouched");
    });

    await check("a CLOSED bound tab is an honest error, never a fallback to the neighbour", async () => {
      const jobTab = fakePage("https://boards.example.com/gone");
      jobTab.closed = true;
      const before = listStagedTabs().length;
      const out = await callTool(makeHandoffServer(() => asPage(jobTab)), "stage_for_review", { reason: "r" });
      assert.match(out, /tab is gone/i);
      assert.match(out, /could NOT be preserved/, "tells the model to say so in the summary");
      assert.equal(listStagedTabs().length, before, "nothing was staged");
    });

    await check("no tab at all — request_handoff refuses instead of grabbing whatever's open", async () => {
      // A handoff on the wrong tab hands the owner a stranger's page to drive by hand, which is
      // the same failure with a person on the other end of it.
      const out = await callTool(makeHandoffServer(() => null), "request_handoff", { reason: "sign in" });
      assert.match(out, /tab is gone/i);
      assert.match(out, /some other job's tab/);
    });

    console.log(`\nspecialists/handoff.test.ts: ${passed} passed`);
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
