import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";

const execFileAsync = promisify(execFile);
const WEB_EXPORT_DIR = path.join(os.homedir(), "GitHub", "web-export");
const WEB_EXPORT_ADAPTERS_DIR = path.join(WEB_EXPORT_DIR, "src", "adapters");

async function listWebExportSources(): Promise<string[]> {
  try {
    const files = await readdir(WEB_EXPORT_ADAPTERS_DIR);
    return files
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

async function runWebExport(cliArgs: string[]): Promise<string> {
  try {
    // The CLI prints the sole output-file path to stdout on success; on failure it
    // writes the error (e.g. a missing session capture) to stderr and exits non-zero.
    const { stdout, stderr } = await execFileAsync("node", ["src/cli.mjs", ...cliArgs], {
      cwd: WEB_EXPORT_DIR,
      timeout: 180_000,
    });
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return out || "done.";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || String(e)).trim();
    return `web_export command failed: ${detail}`;
  }
}

/**
 * Pull the owner's own data out of a site through its local web-export adapter.
 *
 * The second of the three capabilities genuinely unique to the old `fig_tools` bundle. Given
 * its own server so the bundle can stop existing — see `lights/tools.ts` for why the bundle
 * was the problem rather than the tool.
 *
 * The tool verb is `pull`, not `export`: `mcp__web_export__export` restates the server key,
 * which is the naming rule `defineServer` enforces.
 */
export const webExportServerDef = defineServer({
  key: "web_export",
  kind: "direct",
  purpose: "run a local per-site adapter to pull the owner's own data out of a website as JSON",
  exposure: "both",
  capabilities: [
    {
      name: "pull",
      purpose: "run one web-export adapter (or list which adapters exist)",
      mutates: "write",
      fallback: "allow",
      fallbackReason:
        "shells out to the local web-export CLI; was fallback-published before the rewrite as fig_tools.web_export",
      notes:
        "Shells out to the local web-export CLI to pull data from a site; some sources need a one-time session capture on disk first.",
      description:
        "Pull the owner's data out of a website via its web-export adapter (a local per-site exporter at ~/GitHub/web-export). source is the adapter name (e.g. 'x-bookmarks', 'canvas'), or 'list' to see which sources exist. maxPages optionally caps how many pages to page through. On success returns the path to the written JSON file; on failure returns the CLI's error text — most commonly a missing one-time session capture that has to be grabbed from a logged-in browser tab before that source can run.",
      input: {
        source: z
          .string()
          .describe("adapter name to export (e.g. 'x-bookmarks', 'canvas'), or 'list' to see available sources"),
        maxPages: z
          .number()
          .optional()
          .describe("optional cap on pages to pull (maps to --max-pages=N); omit to pull everything"),
      },
      handler: async (args) => {
        const source = String(args.source ?? "").trim();
        if (!source) return "web_export needs a source (an adapter name like 'x-bookmarks' or 'canvas', or 'list').";
        if (source.toLowerCase() === "list") {
          const list = await listWebExportSources();
          return list.length ? `available sources: ${list.join(", ")}` : "no adapters found in web-export/src/adapters.";
        }
        const cliArgs = [`--source=${source}`];
        if (typeof args.maxPages === "number" && Number.isFinite(args.maxPages)) {
          cliArgs.push(`--max-pages=${Math.max(1, Math.round(args.maxPages))}`);
        }
        return runWebExport(cliArgs);
      },
    },
  ],
});

export const webExportServer = toSdkServer(webExportServerDef);
