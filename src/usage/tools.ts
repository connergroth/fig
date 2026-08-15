import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { resolveOwnerTz } from "../location/timezone";
import { defineServer, toSdkServer } from "../tools/define";

const execFileAsync = promisify(execFile);

/**
 * Subscription rate-limit usage for the two coding providers the owner pays for:
 * Claude Code (the 5h session + 7d week windows) and Codex (primary/secondary windows).
 *
 * Design constraints, learned from the engine this was cribbed from (agent_accounts.rs):
 *  - READ-ONLY on credentials. We never refresh a token — OAuth refresh tokens are
 *    typically single-use, and rotating the CLI's token pair out from under a running
 *    Claude Code / Codex would force a re-login (or, with two concurrent refreshes,
 *    revoke the family and brick the login). If a token is expired we SAY so and stop.
 *    The Claude result carries a `staleToken` flag so the /usage slash command
 *    (usage/slash.ts) can self-heal the ONE safe way: spawn a real headless Claude
 *    Code run so the CLI rotates its own token, then retry. The flag is set only on
 *    known expiry (expiresAt in the past, or a 401) — never on network errors — so
 *    that lane can't burn a claude run on a flaky connection.
 *    Codex works the same way and carries the same flag, healed by spawning a real
 *    `codex exec` run (its CLI rotates auth.json at startup).
 *  - Each token only ever goes to its own provider's endpoint. Nowhere else, ever.
 *  - The token itself never enters the model context — the handler reads it, uses it,
 *    and returns only utilization numbers.
 *  - 60s cache so a chatty turn doesn't hammer either endpoint.
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; text: string }>();

export function fmtReset(v: unknown, tz: string = resolveOwnerTz()): string {
  let ms: number | undefined;
  if (typeof v === "number" && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === "string") {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) ms = parsed;
    else if (/^\d+$/.test(v)) ms = Number(v) > 1e12 ? Number(v) : Number(v) * 1000;
  }
  if (ms === undefined) return "unknown";
  const d = new Date(ms);
  // The owner reads this off their own phone clock, so it renders in THEIR timezone —
  // never the provider's billing zone and never the mini's. A hardcoded zone here is
  // silently wrong by an hour or more the moment those differ.
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  };
  // include the weekday when the reset is more than ~20h out
  if (ms - Date.now() > 20 * 3600 * 1000) {
    opts.weekday = "short";
    opts.month = "numeric";
    opts.day = "numeric";
  }
  return d.toLocaleString("en-US", opts);
}

function pct(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}%` : "?";
}

/**
 * 10-segment bar so a glance beats reading the number ("worked but awful to scan").
 * ▓/░ are same-width block glyphs, so this holds up in iMessage's proportional font
 * where space-alignment doesn't.
 */
export function bar(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const filled = Math.min(10, Math.max(0, Math.round(v / 10)));
  return "▓".repeat(filled) + "░".repeat(10 - filled) + " ";
}

// ---------- Claude Code ----------

type ClaudeCreds = { accessToken?: string; expiresAt?: number };

async function readClaudeCreds(): Promise<ClaudeCreds | { error: string }> {
  let raw: string | undefined;
  try {
    raw = await fs.readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
  } catch {
    // macOS: the CLI stores them in the Keychain instead
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 10_000 },
      );
      raw = stdout.trim();
    } catch {
      return { error: "no Claude Code credentials found (no ~/.claude/.credentials.json and no Keychain item)" };
    }
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return { error: "Claude credentials file has no claudeAiOauth.accessToken" };
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return { error: "Claude credentials found but not parseable as JSON" };
  }
}

/** True when the token on disk is already past (or within 30s of) its recorded expiry. */
export function tokenLooksExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  return expiresAt !== undefined && expiresAt - now < 30_000;
}

export type ClaudeUsageResult = { text: string; staleToken: boolean };

export async function claudeUsage(): Promise<ClaudeUsageResult> {
  const creds = await readClaudeCreds();
  if ("error" in creds) return { text: `claude: ${creds.error}`, staleToken: false };
  // never refresh; if the token is expired (or within 30s of it), give up loudly instead —
  // the CLI owns this token pair. Checked BEFORE the fetch so a caller that can self-heal
  // (the /usage command) knows without wasting a doomed request.
  if (tokenLooksExpired(creds.expiresAt)) {
    return {
      text: "claude: token expired — run any Claude Code turn to refresh it, then retry (this tool never refreshes tokens itself)",
      staleToken: true,
    };
  }
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { text: `claude: request failed (${e instanceof Error ? e.message : String(e)})`, staleToken: false };
  }
  if (!res.ok) {
    return {
      text: `claude: usage endpoint returned ${res.status}${res.status === 401 ? " (token stale — run a Claude Code turn to refresh)" : ""}`,
      staleToken: res.status === 401,
    };
  }
  const body = (await res.json()) as {
    five_hour?: { utilization?: number; resets_at?: unknown };
    seven_day?: { utilization?: number; resets_at?: unknown };
  };
  const parts: string[] = [];
  if (body.five_hour)
    parts.push(`${bar(body.five_hour.utilization)}session ${pct(body.five_hour.utilization)} · resets ${fmtReset(body.five_hour.resets_at)}`);
  if (body.seven_day)
    parts.push(`${bar(body.seven_day.utilization)}week ${pct(body.seven_day.utilization)} · resets ${fmtReset(body.seven_day.resets_at)}`);
  if (parts.length === 0) return { text: `claude: unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`, staleToken: false };
  return { text: `claude code\n${parts.join("\n")}`, staleToken: false };
}

// ---------- Codex ----------

/**
 * Codex's access_token is a JWT, so its expiry is readable without asking anyone —
 * same proactive check as Claude's recorded `expiresAt`, just parsed out of the token.
 * Unreadable/absent `exp` returns undefined so the caller falls through to the fetch
 * rather than guessing at staleness.
 */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export type CodexUsageResult = { text: string; staleToken: boolean };

export async function codexUsage(): Promise<CodexUsageResult> {
  const authPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch {
    return { text: `codex: no auth file at ${authPath}`, staleToken: false };
  }
  let accessToken: string | undefined;
  let accountId: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string } };
    accessToken = parsed.tokens?.access_token;
    accountId = parsed.tokens?.account_id;
  } catch {
    return { text: "codex: auth.json not parseable", staleToken: false };
  }
  if (!accessToken || !accountId)
    return { text: "codex: auth.json missing tokens.access_token / tokens.account_id", staleToken: false };
  // Same rule as Claude: never refresh here, but say WHICH kind of failure it is so the
  // /usage lane can spawn a codex run (which rotates auth.json) instead of a doomed retry.
  if (tokenLooksExpired(jwtExpiryMs(accessToken))) {
    return {
      text: "codex: token expired — run any codex turn to refresh it, then retry (this tool never refreshes tokens itself)",
      staleToken: true,
    };
  }
  let res: Response;
  try {
    res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { text: `codex: request failed (${e instanceof Error ? e.message : String(e)})`, staleToken: false };
  }
  if (!res.ok)
    return {
      text: `codex: usage endpoint returned ${res.status}${res.status === 401 ? " (token stale — run any codex turn to refresh)" : ""}`,
      staleToken: res.status === 401,
    };
  const body = (await res.json()) as {
    rate_limit?: {
      primary_window?: { used_percent?: number; reset_at?: unknown; resets_at?: unknown; limit_window_seconds?: number };
      secondary_window?: { used_percent?: number; reset_at?: unknown; resets_at?: unknown; limit_window_seconds?: number };
    };
  };
  const windows = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window].filter(
    (w): w is NonNullable<typeof w> => !!w,
  );
  if (windows.length === 0)
    return { text: `codex: unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`, staleToken: false };
  const parts = windows.map((w) => {
    const label = (w.limit_window_seconds ?? 0) > 86_400 ? "week" : "session";
    return `${bar(w.used_percent)}${label} ${pct(w.used_percent)} · resets ${fmtReset(w.reset_at ?? w.resets_at)}`;
  });
  return { text: `codex\n${parts.join("\n")}`, staleToken: false };
}

// ---------- server ----------

async function cached(key: "claude" | "codex", force: boolean, fn: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
  const text = await fn();
  cache.set(key, { at: Date.now(), text });
  return text;
}

export const usageServerDef = defineServer({
  key: "usage",
  kind: "direct",
  purpose: "check Claude Code and Codex subscription rate-limit usage (session + weekly windows)",
  exposure: "both",
  capabilities: [
    {
      name: "check",
      purpose: "fetch current utilization of the Claude Code and Codex rate-limit windows",
      mutates: "read",
      description:
        "Check how much of the Claude Code and/or Codex subscription rate limits are currently used. Returns each provider's windows (session ≈ 5h, week ≈ 7d) as percent-used plus when each window resets. Reads existing CLI credentials only — never refreshes or rotates tokens, and each token is only ever sent to its own provider. Results are cached 60s; pass force to bypass. Useful before deciding whether to fire a heavy coding delegation, or when the owner asks how much quota is left.",
      input: {
        provider: z.enum(["claude", "codex"]).optional().describe("limit to one provider; default is both"),
        force: z.boolean().optional().describe("bypass the 60s cache and hit the network"),
      },
      handler: async (args) => {
        const force = args.force === true;
        const want = args.provider;
        const jobs: Promise<string>[] = [];
        if (!want || want === "claude") jobs.push(cached("claude", force, async () => (await claudeUsage()).text));
        if (!want || want === "codex") jobs.push(cached("codex", force, async () => (await codexUsage()).text));
        const lines = await Promise.all(jobs);
        return lines.join("\n\n");
      },
    },
  ],
});

export const usageServer = toSdkServer(usageServerDef);
