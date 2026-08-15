import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LiveRuntime, TextRuntime, TextRuntimeRun } from "./runtime";

async function testFigToolsRegistry(): Promise<number> {
  const { fallbackAllows, fallbackCapabilities, fallbackInstructions, fallbackToolList } = await import(
    "../tools/fallback"
  );
  const { FIG_TOOLS_MCP_NAME, figToolsStdioMcpServer } = await import("../tools/stdio");

  const names = fallbackCapabilities().map((c) => c.fallbackName);
  assert.equal(new Set(names).size, names.length, "fallback tool names must be unique");

  for (const t of fallbackToolList()) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `invalid tool name: ${t.name}`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} must expose an object input schema`);
    assert.ok(t.description.trim().length > 0, `${t.name} must have a description`);
  }

  assert.ok(names.length > 0, "fallback surface should expose at least one tool");
  assert.ok(names.includes("fetch__fetch_url"), "fallback surface should include fetch_url");
  // The job board lives in the main process; an out-of-process runtime would only ever see an
  // empty one, so it's `fallback: "deny"` on all three definitions.
  for (const denied of ["jobs__list", "jobs__check", "jobs__cancel"]) {
    assert.ok(!names.includes(denied), `fallback surface must not expose ${denied}`);
    assert.equal(fallbackAllows(denied), false, `${denied} must be denied`);
  }
  // Two capabilities deliberately outside the fallback surface, asserted by name so a future
  // `fallback: "allow"` on either is a decision someone reads rather than a silent widening.
  assert.ok(!names.includes("location__request_share"), "fallback must not expose location-share onboarding");
  assert.ok(!names.includes("agentmail__list_inboxes"), "fallback must use the configured AgentMail inbox directly");
  assert.equal(fallbackAllows("location__request_share"), false, "unknown/denied fallback tools must be denied");

  const instructions = fallbackInstructions();
  assert.ok(!instructions.includes("request_share"), "fallback instructions must not mention location-share onboarding");
  assert.ok(!instructions.includes("list_inboxes"), "fallback instructions must not mention inbox discovery");

  // The Codex config contract: ONE stdio server, under a name Codex is already configured
  // with. `fig_tools` survives as transport precisely so this file never has to change.
  const stdio = figToolsStdioMcpServer();
  assert.equal(stdio.name, FIG_TOOLS_MCP_NAME);
  assert.equal(FIG_TOOLS_MCP_NAME, "fig_tools", "renaming the stdio server would require editing Codex's config");
  assert.ok(stdio.command.endsWith("/node_modules/.bin/tsx"), "stdio MCP should launch through repo-local tsx");
  assert.ok(stdio.args[0].endsWith("/src/runtimes/fig-tools-mcp.ts"), "stdio MCP should point at fig-tools bridge");
  return names.length;
}

async function testRuntimeContract(): Promise<void> {
  const { runSpecialist } = await import("../specialists/run");

  interface FakeOptions {
    marker: string;
  }

  let seen: TextRuntimeRun<FakeOptions> | undefined;
  const fakeRuntime: TextRuntime<FakeOptions> = {
    name: "fake",
    async runTextResult(run) {
      seen = run;
      return { text: `fake:${run.providerOptions.marker}:${run.prompt}`, ok: true };
    },
  };

  const text = await runSpecialist({
    label: "fake-provider",
    prompt: "hello",
    mcpServers: {},
    canUseTool: (() => undefined) as any,
    runtime: fakeRuntime,
    providerOptions: { marker: "runtime" },
  });

  assert.equal(text, "fake:runtime:hello");
  assert.equal(seen?.label, "fake-provider specialist");
  assert.equal(seen?.providerOptions.marker, "runtime");

  let emitted = "";
  const fakeLiveRuntime: LiveRuntime<FakeOptions> = {
    name: "fake-live",
    async runLiveTurn(run) {
      await run.emit(`live:${run.providerOptions.marker}:${run.prompt}`);
      return { ok: true };
    },
  };
  const live = await fakeLiveRuntime.runLiveTurn({
    prompt: "turn",
    providerOptions: { marker: "runtime" },
    signal: new AbortController().signal,
    askOwner: async () => false,
    userInitiated: true,
    emit: async (text) => {
      emitted = text;
    },
  });
  assert.equal(live.ok, true);
  assert.equal(emitted, "live:runtime:turn");
}

/**
 * A specialist runs in its OWN query, so neither lane's `disallowedTools` reaches it. That gap
 * is not hypothetical: the code specialist called `AskUserQuestion` and parked on a picker
 * nobody can click over iMessage, even though its `allowedTools` listed six file tools — because
 * `allowedTools` is the SDK's auto-approve list, not a tool surface. These pin both halves of
 * the fix, on the real `runSpecialist` options builder, via a fake runtime that just records
 * what it was handed.
 */
async function testSubQueryToolSurface(): Promise<void> {
  const { runSpecialist } = await import("../specialists/run");
  const { BASE_DISALLOWED_TOOLS, subQueryDisallowedTools } = await import("../scheduling/builtinDenylist");

  let seen: TextRuntimeRun<Record<string, any>> | undefined;
  const recorder: TextRuntime<Record<string, any>> = {
    name: "recorder",
    async runTextResult(run) {
      seen = run;
      return { text: "ok", ok: true };
    },
  };
  const call = async (allowedTools?: string[]) => {
    seen = undefined;
    await runSpecialist({
      label: "surface",
      prompt: "x",
      mcpServers: {},
      canUseTool: (() => undefined) as any,
      runtime: recorder as any,
      ...(allowedTools ? { allowedTools } : {}),
    });
    return seen!.providerOptions;
  };

  const coded = await call(["Read", "Bash", "mcp__browse__use"]);
  // 1. The built-in surface is genuinely CAPPED — `tools` is the option that restricts.
  assert.deepEqual(coded.tools, ["Read", "Bash"], "built-in surface must be capped to the declared non-MCP tools");
  // 2. …while allowedTools keeps its real (auto-approve) meaning, MCP names included.
  assert.deepEqual(coded.allowedTools, ["Read", "Bash", "mcp__browse__use"]);
  // 3. Every base-denied built-in is denied here too — AskUserQuestion above all.
  for (const name of Object.keys(BASE_DISALLOWED_TOOLS)) {
    assert.ok(coded.disallowedTools.includes(name), `sub-query must deny ${name}`);
  }

  // No allowlist (the browser specialist's shape) → no cap invented, but still denied.
  const open = await call();
  assert.equal(open.tools, undefined, "a specialist that declares no built-ins must not be handed tools: []");
  assert.ok(open.disallowedTools.includes("AskUserQuestion"));

  // The escape hatch, and the one caller that needs it: a pass that names a base-denied built-in
  // in its own `tools` list keeps it (research/workflowRunner and `Workflow`). Without this the
  // deep_research path would lose the one tool it's built on.
  const kept = subQueryDisallowedTools(["Workflow", "Write", "Bash"]);
  assert.ok(!kept.includes("Workflow"), "an explicitly declared built-in must survive the sub-query denylist");
  assert.ok(kept.includes("AskUserQuestion"), "declaring one tool must not lift the rest of the denylist");
}

async function testModelCommand(): Promise<void> {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "fig-model-test-"));
  process.env.BRAIN_DIR = brain;
  process.env.AGENT_MODEL = "claude-default-test";

  const model = await import("../core/model");

  assert.equal(model.currentModelRuntime(), "claude");
  assert.equal(model.currentModel(), "claude-default-test");
  assert.equal(model.currentModelLabel(), "claude-default-test");

  assert.match(model.resolveModelCommand("/model codecs") ?? "", /model . codex/);
  assert.equal(model.currentModelRuntime(), "codex");
  assert.equal(model.currentModel(), "claude-default-test", "Codex runtime must not become a fake Claude model id");
  assert.equal(model.currentModelLabel(), "codex");
  assert.match(model.resolveModelCommand("/model") ?? "", /codex/);

  assert.match(model.resolveModelCommand("/model sonnet") ?? "", /claude-sonnet-5/);
  assert.equal(model.currentModelRuntime(), "claude");
  assert.equal(model.currentModel(), "claude-sonnet-5");

  assert.match(model.resolveModelCommand("/model codex") ?? "", /model . codex/);
  assert.equal(model.currentModelRuntime(), "codex");

  const registry = await import("./registry");
  const backgroundSelection = registry.selectedLiveRuntimeSelection();
  const scheduledSelection = registry.selectedTextRuntimeSelection();
  assert.equal(backgroundSelection?.name, "codex", "top-level background turns must inherit the selected runtime");
  assert.equal(scheduledSelection?.name, "codex", "top-level scheduled turns must inherit the selected runtime");
  assert.equal(
    (backgroundSelection?.providerOptions as { role?: string }).role,
    "main",
    "a background fig turn must keep the main-agent prompt rather than the delegated-coding prompt",
  );

  assert.match(model.resolveModelCommand("/model default") ?? "", /default/);
  assert.equal(model.currentModelRuntime(), "claude");
  assert.equal(model.currentModel(), "claude-default-test");
  assert.equal(registry.selectedLiveRuntimeSelection(), null, "Claude background turns stay on their native SDK path");
  assert.equal(registry.selectedTextRuntimeSelection(), null, "Claude scheduled turns stay on their native SDK path");

  fs.rmSync(brain, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await testModelCommand();
  await testRuntimeContract();
  await testSubQueryToolSurface();
  const sharedToolCount = await testFigToolsRegistry();
  console.log(`provider runtime tests passed (${sharedToolCount} shared tools)`);
}

void main();
