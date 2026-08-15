import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One temp home for all throwaway artifacts — Playwright page snapshots/console
 * dumps, browser/research scratch. Lives under the OS temp dir, NEVER the vault,
 * so it stays out of Obsidian/Cursor and the OS clears it on reboot. Previously
 * @playwright/mcp dumped a `.playwright-mcp/` dir (2.5MB, 130+ files) into the
 * vault root because cwd = the vault; this redirects it out.
 */
export const SCRATCH_DIR = path.join(os.tmpdir(), "fig-scratch");

/** Where @playwright/mcp writes its snapshots/console logs/downloads. */
export const BROWSER_OUTPUT_DIR = path.join(SCRATCH_DIR, "playwright");

/**
 * Wipe the scratch dir and recreate the subdirs. Called once on boot so nothing
 * accumulates across restarts. (The dev server restarts on every code change, so
 * boot-time clean keeps it from growing unbounded.)
 */
export function resetScratch(): void {
  try {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  } catch {
    // best effort — a stale lock shouldn't block startup
  }
  fs.mkdirSync(BROWSER_OUTPUT_DIR, { recursive: true });
}
