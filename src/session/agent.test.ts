import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { browserSystemPrompt, emailSystemPrompt } from "./agent";

// The specialist briefs live in this repo, not the vault (they're runtime config, not memory —
// see readSpecialistPrompt in agent.ts). Their loader swallows read errors and returns "", which
// is the dangerous failure: a wrong path doesn't crash, it launches a sub-query with NO
// instructions and full tool access. So pin that each brief actually resolves and comes back
// with real content.
const PROMPTS = [
  ["email", emailSystemPrompt, "email-agent.md"],
  ["browser", browserSystemPrompt, "browser-agent.md"],
] as const;

for (const [name, load, file] of PROMPTS) {
  const text = load();
  assert.ok(text.length > 500, `${name} specialist prompt loaded empty or truncated (${text.length} chars)`);
  assert.equal(
    text,
    fs.readFileSync(path.join(config.repoRoot, "src", "specialists", "prompts", file), "utf8").trim(),
    `${name} specialist prompt must come from src/specialists/prompts/${file}`,
  );
}

// The loader must not depend on where the process was started: the chat session runs with
// cwd = the vault, and background jobs run with cwd = a scratch dir or another repo.
{
  const original = process.cwd();
  try {
    process.chdir(config.brainDir);
    assert.ok(emailSystemPrompt().length > 500, "prompts must load with cwd outside the bot repo");
  } finally {
    process.chdir(original);
  }
}

// A brief that no longer names its own tools is the exact staleness this move was meant to
// end — the email prompt described outlook as draft-only for two days after the tools changed.
assert.match(emailSystemPrompt(), /mcp__mailsearch__find/, "email brief must describe the unified mail search");
