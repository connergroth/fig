import assert from "node:assert/strict";

import type { Page } from "playwright";

/**
 * The injector's tab binding.
 *
 * Origin-checking the right page is the whole guarantee (docs/credential-injector.md, invariant 3),
 * and until 2026-08-13 the page was a GUESS — activeBrowserPage(), i.e. whatever was frontmost in
 * the shared Chrome. Two live jobs meant the check ran against a neighbour's tab: it failed closed,
 * so no secret leaked, but the model was told "I can't type passwords here" and reported that to
 * the owner as a capability it lacks. Wrong tab, false confession. It now reads the tab this run
 * was handed, or does nothing.
 *
 * No Bitwarden, no network: every assertion here is on the path BEFORE any secret is resolved.
 */

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function fakePage(url: string) {
  const p = { closed: false, url: () => url, isClosed: () => p.closed };
  return p;
}
type FakePage = ReturnType<typeof fakePage>;
const asPage = (p: FakePage) => p as unknown as Page;

/** Call a tool on an SDK MCP server the way the model would — over a real MCP session. */
async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "credentials-test", version: "1.0.0" });
  await (server as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverSide);
  await client.connect(clientSide);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: (res.content ?? []).map((c) => c.text ?? "").join("\n"), isError: res.isError === true };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const { makeCredentialsServer } = await import("./tools");

  console.log("credentials: fill_login reads the bound tab, or refuses");

  await check("a closed bound tab types nothing and says so", async () => {
    const jobTab = fakePage("https://www.amazon.com/ap/signin");
    jobTab.closed = true;
    const res = await callTool(makeCredentialsServer(() => asPage(jobTab)), "fill_login", { handle: "amazon" });
    assert.match(res.text, /YOUR browser tab is gone/);
    assert.match(res.text, /no secret was read/);
  });

  await check("no tab at all is the same refusal, not a fill on the frontmost page", async () => {
    const res = await callTool(makeCredentialsServer(() => null), "fill_login", { handle: "amazon" });
    assert.match(res.text, /YOUR browser tab is gone/);
  });

  await check("the origin checked is the BOUND tab's, even when a neighbour is on the allowlist", async () => {
    // The precise shape of the production failure: the allowlisted login page is sitting in
    // another job's tab. The old guess would have origin-checked THAT one and filled it.
    const listed = await callTool(makeCredentialsServer(() => null), "list_handles", {});
    const handles = JSON.parse(listed.text) as Record<string, { allowedOrigins: string[] }>;
    const [handle, cfg] = Object.entries(handles)[0] ?? [];
    if (!handle || !cfg?.allowedOrigins?.length) {
      console.log("    (skipped: no credential handles configured on this machine)");
      return;
    }
    const jobTab = fakePage("https://oracle.com/careers");
    const res = await callTool(makeCredentialsServer(() => asPage(jobTab)), "fill_login", { handle });
    assert.equal(res.isError, true, "off-allowlist must fail closed");
    assert.match(res.text, /oracle\.com/, "names the bound tab's origin — the one it actually checked");
    assert.ok(!res.text.includes(new URL(cfg.allowedOrigins[0]).host), "the neighbour's origin was never consulted");
  });

  console.log(`\ncredentials/tools.test.ts: ${passed} passed`);
}

void main();
