/**
 * Why scheduled passes had no MCP tools, and proof the fix holds.
 *
 * An in-process SDK MCP server instance can be mounted by exactly ONE open query. fig always
 * has a long-lived interactive session open, so every scheduled pass was handed instances the
 * session already held and came up toolless. Sequential mounts work fine — which is why a
 * one-shot out-of-process measurement showed everything healthy.
 *
 * Run: npx tsx scripts/dev/singleton-probe.ts
 */
import "dotenv/config";
import { query, type McpServerConfig, type Options } from "@anthropic-ai/claude-agent-sdk";

import { buildFigMcpServers, buildScheduledMcpServers } from "../../src/scheduling/lane";
import { gmailServer } from "../../src/google/tools";
import { jobsServer } from "../../src/specialists/jobs";

type Servers = Record<string, McpServerConfig>;

/** Mount a server map, read the init tool list, and leave the query OPEN like a live session. */
async function mount(label: string, servers: Servers, prompt = "say ok") {
  const options: Options = { mcpServers: servers, permissionMode: "bypassPermissions", maxTurns: 4 };
  const it = (query({ prompt, options }) as AsyncIterable<any>)[Symbol.asyncIterator]();
  let tools: string[] = [];
  const calls: string[] = [];
  for (;;) {
    const { value, done } = await it.next();
    if (done) break;
    if (value?.type === "system" && value.subtype === "init") {
      tools = (value.tools ?? []).filter((t: string) => t.startsWith("mcp__")).sort();
      if (prompt === "say ok") break; // hold open
    }
    if (value?.type === "assistant")
      for (const b of value.message?.content ?? []) if (b.type === "tool_use") calls.push(b.name);
  }
  console.log(`  ${label}: ${tools.length} mcp tools${calls.length ? ` | called ${calls.join(", ")}` : ""}`);
  return { tools, calls, drain: async () => { for (;;) { const { done } = await it.next(); if (done) break; } } };
}

async function main() {
  console.log("\nBEFORE — shared module singletons, two overlapping queries:");
  const shared = { gmail: gmailServer, jobs: jobsServer } as unknown as Servers;
  const a = await mount("first query (holds them)", shared);
  const b = await mount("second query (same instances)", shared);
  console.log(`  => ${b.tools.length === 0 ? "second query lost ALL tools ❌ (this was the bug)" : "no loss"}`);

  console.log("\nAFTER — the real builders, live session open while a scheduled pass mounts:");
  const live = await mount("live lane (buildFigMcpServers, held open)", buildFigMcpServers());
  const sched = await mount("scheduled lane (buildScheduledMcpServers)", buildScheduledMcpServers());
  const has = (t: string) => sched.tools.includes(t);
  console.log(
    `  => scheduled pass sees ${sched.tools.length} tools; ` +
      `mail ${has("mcp__mailsearch__find") ? "✅" : "❌"} calendar ${has("mcp__calendar__list") ? "✅" : "❌"} ` +
      `agentmail ${has("mcp__agentmail__check_inbox") ? "✅" : "❌"} ` +
      `list_inboxes-kept-out ${has("mcp__agentmail__list_inboxes") ? "❌ leaked" : "✅"}`,
  );

  console.log("\nAND — a second scheduled pass overlapping the first (two ticks colliding):");
  const sched2 = await mount("scheduled pass #2", buildScheduledMcpServers(), "Reply with just OK.");
  console.log(`  => ${sched2.tools.length === sched.tools.length ? "same tool surface ✅" : `MISMATCH ❌ (${sched2.tools.length} vs ${sched.tools.length})`}`);

  await Promise.all([a.drain(), b.drain(), live.drain(), sched.drain()]);
}
void main();
