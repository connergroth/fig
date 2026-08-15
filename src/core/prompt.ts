import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildContextReport, estimateTokens, summarizeContextReport } from "./contextReport";
import { log, warn } from "./log";

/**
 * Live `/prompt` command. Sends whichever bot's real, currently-running system
 * prompt back as an actual .md file attachment — byte-for-byte what the agent
 * loop is handed, read straight off disk/source each time (no cached copy to
 * drift). Intercepted in Conversation.enqueue() like the kill switch, /model,
 * and the fig↔spot switch, so it NEVER becomes an agent turn — zero tokens.
 *
 * Replaces the old `prompt` skill, which did the same thing but burned a full
 * turn (an LLM call) just to shell out and paste text back.
 *
 * For fig the attachment now LEADS with a full context accounting (see
 * `contextReport.ts`) and the prompt text follows it unchanged. The prompt alone was
 * never the answer to "what's loaded" — it's roughly a third of it — and printing its
 * size as though it were the total is what made the tool quietly misleading. `/prompt
 * spot` is untouched: the accounting is derived from THIS repo's builders and registry,
 * and would be a guess about someone else's process.
 */

const execFileAsync = promisify(execFile);

// This file lives at <bot repo>/src/core/prompt.ts — two levels up is the repo root.
// (Computed here rather than imported: this used to be the ONLY correct copy, back when
// config.repoRoot mis-resolved to bot/src. That's fixed and the two now agree — kept
// local only because prompt.ts otherwise has no reason to pull in config.)
const FIG_REPO = path.resolve(__dirname, "..", "..");
const SPOT_REPO = process.env.SPOT_REPO_PATH || path.join(os.homedir(), "GitHub", "spot");

const SPOT_MODES = new Set(["coach", "onboarding", "proactive"]);

export interface PromptResult {
  /** Plain text to send — a label, help text, or an error. */
  text?: string;
  /** A file to send as a real attachment. */
  file?: { path: string; filename: string };
}

const HELP =
  "🤖 /prompt [fig | spot [coach|onboarding|proactive]] — e.g. /prompt, /prompt spot, /prompt spot onboarding";

/**
 * Runs a `print-prompt.mjs` script in the given repo and returns its raw stdout —
 * exactly what the live builder composes, no summarizing or trimming.
 */
async function printPrompt(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npx", ["tsx", "scripts/internal/print-prompt.mjs", ...args], {
    cwd: repoDir,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/** Stage prompt text to a temp .md file so it can go out as a real attachment. */
function stage(filename: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fig-prompt-"));
  const fpath = path.join(dir, filename);
  fs.writeFileSync(fpath, contents, "utf8");
  return fpath;
}

/**
 * If `text` is a `/prompt [...]` command, run it and return what to send back.
 * Returns null when it isn't a match at all, so the normal turn runs untouched.
 * Once it matches `/prompt`, it ALWAYS intercepts (bad args → help text, not a
 * fallthrough to an agent turn) — same contract as /model.
 */
export async function resolvePromptCommand(text: string): Promise<PromptResult | null> {
  const m = text.trim().match(/^\/prompt\b(.*)$/i);
  if (!m) return null;

  const args = m[1].trim().toLowerCase().split(/\s+/).filter(Boolean);
  const target = args.length === 0 ? "fig" : args[0];

  try {
    if (target === "fig" || target === "self" || target === "yours") {
      const out = await printPrompt(FIG_REPO, []);
      // The accounting is best-effort by construction (contextReport degrades every block it
      // can't read into an "unavailable" row), but if the whole thing somehow fails, /prompt
      // still does what it always did rather than returning an error.
      let accounting = "";
      let summary = "";
      try {
        const report = buildContextReport();
        accounting = report.text;
        summary = summarizeContextReport(report);
      } catch (e) {
        warn(`/prompt: context accounting failed, sending the prompt alone: ${e}`);
        summary = `context accounting unavailable (${e instanceof Error ? e.message : e})\nprompt text is in the file`;
      }
      const fpath = stage("fig-prompt.md", accounting + out);
      const tokens = estimateTokens(out);
      log(`/prompt → sent fig's live system prompt (~${tokens} tokens, ${out.length} chars) + context accounting`);
      return {
        text: `🤖 what's actually in your context right now\n${summary}`,
        file: { path: fpath, filename: "fig-prompt.md" },
      };
    }

    if (target === "spot") {
      const mode = args[1] && SPOT_MODES.has(args[1]) ? args[1] : "coach";
      const out = await printPrompt(SPOT_REPO, mode === "coach" ? [] : [mode]);
      const fpath = stage(`spot-prompt-${mode}.md`, out);
      const tokens = estimateTokens(out);
      log(`/prompt spot ${mode} → sent spot's live system prompt (~${tokens} tokens, ${out.length} chars)`);
      return {
        text: `🤖 spot's live ${mode}-mode system prompt, ~${tokens.toLocaleString()} tokens:`,
        file: { path: fpath, filename: `spot-prompt-${mode}.md` },
      };
    }

    return { text: HELP };
  } catch (e) {
    warn(`/prompt failed for target "${target}": ${e}`);
    return { text: `🤖 couldn't pull that prompt: ${e instanceof Error ? e.message : e}` };
  }
}
