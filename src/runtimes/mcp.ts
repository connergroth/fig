import fs from "node:fs";
import path from "node:path";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../core/config";
import { warn } from "../core/log";
import { BROWSER_OUTPUT_DIR } from "../core/scratch";

/** Recursively substitute ${VAR} from the environment in any string value. */
function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnv) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out as T;
  }
  return value;
}

/**
 * Load MCP servers from the vault's mcp.json. Same config shape as Claude Code.
 * Living in the vault means the agent can add a server by editing the file itself
 * (text it "hook up this MCP: <url>"). A server whose required ${VAR}s are unset
 * (e.g. before you've pasted its token) is skipped rather than half-configured.
 */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const p = path.resolve(config.brainDir, "mcp.json");
  if (!fs.existsSync(p)) return {};

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    warn(`mcp.json is not valid JSON — ignoring it: ${e}`);
    return {};
  }

  const servers: Record<string, any> = raw.mcpServers ?? {};

  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (name.startsWith("_")) continue; // allow `_comment` keys
    // Skip any server that references an env var we don't have set — so a half-configured
    // entry (e.g. agent-cards before AGENTCARD_TOKEN exists, or context before its token)
    // never connects with an empty token rather than working. Checked on the RAW config so
    // an unset ${VAR} is caught before expandEnv blanks it out. ${HOME} etc. are set, so
    // fully-configured servers pass through.
    if (referencesUnsetEnv(cfg)) continue;
    const expanded = expandEnv(cfg);
    // Drop servers whose url is empty after expansion (a literal empty url in the file).
    const url = (expanded as any).url;
    if (typeof url === "string" && url.trim() === "") continue;
    out[name] = withBrowserOutputDir(name, expanded as McpServerConfig);
  }
  return out;
}

/**
 * Force @playwright/mcp to dump its snapshots/console/downloads into the temp
 * scratch dir instead of `.playwright-mcp/` in cwd (which is the vault → slop in
 * Obsidian/Cursor). Injected here rather than in mcp.json so the path resolves to
 * the OS temp dir at runtime and can't drift out of sync. No-op if the server
 * already pins its own --output-dir.
 */
function withBrowserOutputDir(name: string, cfg: McpServerConfig): McpServerConfig {
  const c = cfg as any;
  if (!Array.isArray(c.args)) return cfg;
  const isPlaywright = c.args.some((a: unknown) => typeof a === "string" && a.includes("@playwright/mcp"));
  if (!isPlaywright || c.args.includes("--output-dir")) return cfg;
  return { ...c, args: [...c.args, "--output-dir", BROWSER_OUTPUT_DIR] };
}

/** True if any string in the config contains a ${VAR} whose env value is empty/unset. */
function referencesUnsetEnv(value: unknown): boolean {
  if (typeof value === "string") {
    const matches = value.matchAll(/\$\{([A-Z0-9_]+)\}/gi);
    for (const m of matches) {
      if (!process.env[m[1]]?.trim()) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(referencesUnsetEnv);
  if (value && typeof value === "object") return Object.values(value).some(referencesUnsetEnv);
  return false;
}
