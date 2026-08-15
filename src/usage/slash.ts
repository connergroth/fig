import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { claudeUsage, codexUsage, type ClaudeUsageResult, type CodexUsageResult } from "./tools";

const execFileAsync = promisify(execFile);

/**
 * `/usage` — answered in code, intercepted in Conversation.enqueue() like /model and
 * /prompt (spending an agent turn to read two numbers would eat the very quota being
 * checked). Same fetch as the MCP tool, uncached — a human typing /usage wants now,
 * not a 60s-old answer.
 *
 * The one thing this lane does that the tool refuses to: self-heal a stale token, for
 * BOTH providers. A token on disk only rotates when a real CLI run happens, so it goes
 * stale exactly when fig's been quiet — which is when the owner is most likely to ask.
 * The heal is NOT a token refresh by us (refresh tokens are single-use; racing a CLI
 * could brick the login): it spawns a minimal headless run of that provider's own CLI
 * so the CLI rotates its own token, then retries the fetch. Fires only on a known-stale
 * token (staleToken from tools.ts: past expiry, or a 401), never on network errors, and
 * at most once per invocation per provider — if it still fails, the honest error goes
 * out and the other half is unaffected.
 */

export function isUsageCommand(text: string): boolean {
  return /^\/usage\b/i.test(text.trim());
}

/** First path that exists, else the bare name and let PATH try. The daemon's launchd PATH is not a login shell's. */
function resolveBin(candidates: string[], fallback: string): string {
  return candidates.find((p) => fs.existsSync(p)) ?? fallback;
}

/**
 * Env for a refresh spawn. The ONLY job of these runs is the side effect of rotating
 * the credentials on disk, so any ambient token that lets the CLI answer WITHOUT
 * touching those credentials defeats the entire point: the run succeeds, exits 0, and
 * the stale token is still stale. fig's own process carries exactly such a token
 * (CLAUDE_CODE_OAUTH_TOKEN, a long-lived `claude setup-token` credential), so a spawn
 * that inherits process.env is not the same run as the same command typed in a shell.
 * Strip them and let the CLI fall back to the credential we actually need rotated.
 */
export function refreshEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  return env;
}

/** Cheapest non-interactive Claude Code run; its only job is the side effect of the CLI refreshing its own token. Output discarded. */
async function spawnClaudeRefresh(): Promise<boolean> {
  const bin = resolveBin([path.join(os.homedir(), ".local", "bin", "claude")], "claude");
  try {
    await execFileAsync(bin, ["-p", "ok"], { timeout: 60_000, env: refreshEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Same for Codex. Measured 2026-08-12: `codex exec` rewrites ~/.codex/auth.json with a
 * rotated access_token roughly a second after launch — at startup, long before the model
 * turn it also kicks off finishes. So a timeout kill still counts as a completed refresh;
 * we bound the wait rather than making the owner sit through a whole codex turn.
 */
async function spawnCodexRefresh(): Promise<boolean> {
  const bin = resolveBin(["/opt/homebrew/bin/codex", path.join(os.homedir(), ".local", "bin", "codex")], "codex");
  try {
    await execFileAsync(bin, ["exec", "ok"], { timeout: 25_000, env: refreshEnv() });
    return true;
  } catch (e) {
    // `killed` is set when our own timeout fired — the rotation already happened.
    return (e as { killed?: boolean } | undefined)?.killed === true;
  }
}

/** Injectable for tests — the real deps hit the network and spawn CLI runs. */
export interface UsageDeps {
  fetchClaude: () => Promise<ClaudeUsageResult>;
  fetchCodex: () => Promise<CodexUsageResult>;
  refreshClaude: () => Promise<boolean>;
  refreshCodex: () => Promise<boolean>;
  /** injectable so tests don't spend real seconds on the settle waits */
  sleep?: (ms: number) => Promise<void>;
}

const realDeps: UsageDeps = {
  fetchClaude: claudeUsage,
  fetchCodex: codexUsage,
  refreshClaude: spawnClaudeRefresh,
  refreshCodex: spawnCodexRefresh,
};

/** How many post-refresh reads to attempt, and the pause between them. */
const SETTLE_READS = 3;
const SETTLE_WAIT_MS = 2_000;

type Healable = { text: string; staleToken: boolean };

/**
 * One stale-token dance, shared by both providers: read, and if the token is known-stale,
 * spawn that CLI once and re-read a bounded number of times. The spawned CLI persists its
 * rotated token at exit and a concurrently-running turn can be racing the same token
 * family, so one instant re-read can still see the old token even after a successful
 * heal — hence the settle reads rather than declaring failure off the first look.
 */
async function withHeal(
  fetch: () => Promise<Healable>,
  refresh: () => Promise<boolean>,
  label: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  let result = await fetch();
  if (!result.staleToken) return result.text;

  const refreshed = await refresh();
  if (refreshed) {
    for (let attempt = 0; attempt < SETTLE_READS; attempt++) {
      if (attempt > 0) await sleep(SETTLE_WAIT_MS);
      result = await fetch();
      if (!result.staleToken) return result.text;
    }
  }
  // Still stale. Don't guess at a cause in the owner's face — name what was tried and
  // the one move that actually rotates the token: running that CLI in a real terminal.
  return refreshed
    ? `${label}: token's stale and my auto-refresh run didn't rotate it — needs a real \`${label}\` run in a terminal`
    : `${label}: token's stale and the auto-refresh run failed to start — needs a real \`${label}\` run in a terminal`;
}

export async function runUsageCommand(deps: UsageDeps = realDeps): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = (who: string) => (e: unknown) =>
    `${who}: check failed (${e instanceof Error ? e.message : String(e)})`;
  // Both halves run their own heal concurrently — a stale codex token used to make the
  // whole command useless while claude healed fine (and vice versa).
  const [claude, codex] = await Promise.all([
    withHeal(deps.fetchClaude, deps.refreshClaude, "claude", sleep).catch(fail("claude")),
    withHeal(deps.fetchCodex, deps.refreshCodex, "codex", sleep).catch(fail("codex")),
  ]);
  // blank line between the two provider blocks — each is multi-line (header + one bar line per window)
  return `📊 ${claude}\n\n${codex}`;
}
