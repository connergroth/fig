import assert from "node:assert/strict";

import { config } from "../core/config";
import { BASE_DISALLOWED_TOOLS } from "../scheduling/builtinDenylist";
import { planBrainTextRun, type BrainTextRun } from "./brain";

const baseRun = (overrides: Partial<BrainTextRun> = {}): BrainTextRun => ({
  label: "provider-neutral test",
  prompt: "do the scoped work",
  options: {
    cwd: config.brainDir,
    systemPrompt: "keep this system prompt",
    allowedTools: ["Read", "mcp__calendar__list"],
    disallowedTools: ["Write"],
    permissionMode: "default",
  },
  ...overrides,
});

function testClaudeSelection(): void {
  const plan = planBrainTextRun(baseRun(), "claude");
  assert.equal(plan.runtimeName, "claude");
  assert.equal(plan.runtime.name, "claude");

  const options = plan.providerOptions as Record<string, any>;
  assert.equal(options.systemPrompt, "keep this system prompt", "Claude system prompt must survive");
  assert.deepEqual(options.allowedTools, ["Read", "mcp__calendar__list"], "Claude allowlist must survive");
  assert.ok(options.disallowedTools.includes("Write"), "caller's Claude denylist must survive");
  for (const name of Object.keys(BASE_DISALLOWED_TOOLS)) {
    assert.ok(options.disallowedTools.includes(name), `Claude sub-query must still deny ${name}`);
  }
}

function testCodexSelection(): void {
  const plan = planBrainTextRun(
    baseRun({
      options: {
        cwd: config.brainDir,
        systemPrompt: "provider-specific and intentionally not mapped",
        allowedTools: [],
      },
    }),
    "codex",
  );
  assert.equal(plan.runtimeName, "codex");
  assert.equal(plan.runtime.name, "codex");
  assert.equal((plan.providerOptions as Record<string, any>).role, "main");
  assert.equal(
    (plan.providerOptions as Record<string, any>).model,
    undefined,
    "ordinary scoped passes, including compaction, stay on Codex's normal selected tier",
  );
}

function testTriageLightTier(): void {
  const plan = planBrainTextRun(baseRun({ lane: "triage" }), "codex");
  assert.equal(plan.runtimeName, "codex");
  assert.equal((plan.providerOptions as Record<string, any>).model, "gpt-5.6-luna");
  assert.equal((plan.providerOptions as Record<string, any>).reasoning, "low");
}

function testTriageKillSwitch(): void {
  const before = process.env.TRIAGE_RUNTIME;
  process.env.TRIAGE_RUNTIME = "claude";
  try {
    const plan = planBrainTextRun(baseRun({ lane: "triage" }), "codex");
    assert.equal(plan.runtimeName, "claude");
    assert.equal(plan.runtime.name, "claude");
    assert.equal((plan.providerOptions as Record<string, any>).model, config.emailTriageModel);
    assert.match(plan.claudePinReason ?? "", /TRIAGE_RUNTIME=claude/);
  } finally {
    if (before === undefined) delete process.env.TRIAGE_RUNTIME;
    else process.env.TRIAGE_RUNTIME = before;
  }
}

function testRequiredToolFallback(): void {
  const pinned = planBrainTextRun(baseRun({ requiredTools: ["calendar"] }), "codex");
  assert.equal(pinned.runtimeName, "claude", "the calendar tools are not on Codex's stdio surface");
  assert.match(pinned.claudePinReason ?? "", /cannot provide required tool/);
  assert.match(pinned.prompt, /mcp__calendar__list/, "Claude keeps the existing required-tool preamble");

  const codex = planBrainTextRun(baseRun({ requiredTools: ["location"] }), "codex");
  assert.equal(codex.runtimeName, "codex", "fallback-published tools may stay on Codex");
  assert.match(codex.prompt, /location__where_is/, "Codex receives the flat fig_tools name");
}

function testClaudeBuiltinFallback(): void {
  const plan = planBrainTextRun(
    baseRun({ options: { cwd: config.brainDir, tools: ["WebSearch", "WebFetch"] } }),
    "codex",
  );
  assert.equal(plan.runtimeName, "claude");
  assert.match(plan.claudePinReason ?? "", /Claude-only built-in tool surface/);
}

testClaudeSelection();
testCodexSelection();
testTriageLightTier();
testTriageKillSwitch();
testRequiredToolFallback();
testClaudeBuiltinFallback();

console.log("provider-neutral brain text lane tests passed");
