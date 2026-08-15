import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { warn } from "../core/log";

/**
 * AgentCard access-token resolution.
 *
 * The `agent-cards` CLI stores its session at ~/.agent-cards/config.json:
 *   { email, accessToken, refreshToken }
 * The accessToken is a ~5-MINUTE JWT. The CLI auto-rotates it (via the long-lived
 * refreshToken) and rewrites this file whenever it runs a command against an expired
 * token. So a token frozen into .env (`AGENTCARD_TOKEN`) goes stale almost immediately
 * — that was the "the agentcard token keeps going stale" bug.
 *
 * The durable fix: resolve the token LIVE from the CLI's own config at the moment the
 * browse specialist actually needs it, refreshing first if it's expired/near-expiry.
 */

const CONFIG_PATH = path.join(os.homedir(), ".agent-cards", "config.json");
// Refresh if the stored token has less than this much life left (the CLI only
// rotates a token it considers expired, so this is a best-effort freshness pull).
const REFRESH_BUFFER_MS = 90_000;

function readAccessToken(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return typeof cfg.accessToken === "string" && cfg.accessToken ? cfg.accessToken : null;
  } catch {
    return null; // not logged in / no config yet
  }
}

/** Milliseconds-since-epoch of a JWT's `exp`, or null if it can't be read. */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A fresh AgentCard access token, or null if AgentCard isn't logged in on this box
 * (no config / no token) — in which case the server should be left off entirely
 * rather than connect with a dead token.
 *
 * Note: the returned token still has at most ~5 minutes of life, and the http MCP
 * pins the header at connection time, so a very long checkout could still outlive it.
 * That's a known limit of a static-header MCP; this is strictly better than the frozen
 * env token (which was permanently stale). A refreshing proxy would be the next step
 * if mid-job expiry ever actually bites.
 */
export function resolveAgentCardToken(): string | null {
  let token = readAccessToken();
  if (!token) return null;

  const expMs = jwtExpMs(token);
  const stale = expMs === null || expMs - Date.now() < REFRESH_BUFFER_MS;
  if (stale) {
    try {
      // A harmless read hits the AgentCard API; against an expired token the CLI
      // refreshes it (via the refresh token) and persists the new one to config.json.
      execFileSync("agent-cards", ["cards", "list"], { stdio: "ignore", timeout: 15_000 });
      token = readAccessToken() ?? token;
    } catch (e) {
      warn(`agent-cards token refresh failed, using stored token: ${e}`);
    }
  }
  return token;
}

/**
 * Given the base agent-cards server config from mcp.json (url + placeholder header),
 * return a copy with a FRESH Authorization token — or undefined if AgentCard isn't
 * logged in, so the caller can simply omit the server. Keeps all AgentCard-specific
 * token plumbing out of the generic mcp.json loader.
 */
export function withFreshAgentCardToken(base: McpServerConfig | undefined): McpServerConfig | undefined {
  if (!base) return undefined;
  const token = resolveAgentCardToken();
  if (!token) {
    warn("agent-cards not logged in (no ~/.agent-cards token) — leaving the card server off.");
    return undefined;
  }
  const b = base as any;
  return { ...b, headers: { ...(b.headers ?? {}), Authorization: `Bearer ${token}` } };
}
