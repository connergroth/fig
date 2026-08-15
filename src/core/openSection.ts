import fs from "node:fs";
import path from "node:path";

import { config } from "./config";

/**
 * Shared reader for the `## Open` section of the three list files (Pending.md,
 * Lists/Todos.md, Tasks.md).
 *
 * These sections are injected VERBATIM into every single turn's prompt, so anything
 * sitting in them is paid for forever — which makes what gets stripped here a real
 * cost control, not cosmetics. Two things leak in repeatedly and neither is live work:
 *
 * 1. HTML-comment tombstones (`<!-- killed at the owner's word ... -->`). A real one is
 *    always MULTI-LINE, so a filter that only matches single-line comments injects every
 *    dead loop in full, indefinitely.
 * 2. Header prose explaining how to use the list. The policy for the three lists is
 *    taught once in HARNESS_RULES; a copy under `## Open` is a second, drifting one.
 *
 * Both are stripped MECHANICALLY here rather than by asking a cleanup pass to keep the
 * files tidy — a rule that depends on remembering to file a tombstone in the right
 * place regrows the moment it's forgotten. Now placement can't cost anything.
 */

/** Remove every `<!-- ... -->` block, including multi-line ones, then tidy blank runs. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n");
}

/** A line that starts real list content: a bullet, a checkbox, a numbered item, a subheading. */
const CONTENT_LINE = /^\s{0,3}(?:[-*+]\s|\d+\.\s|#{3,}\s)/;

/**
 * The lines under `## Open` in `relPath`, with comment blocks and any leading
 * how-to-use-this-list prose removed. Stops at the next `##` heading (so `## Done`,
 * `## Parked`, `## Tomorrow` archives below never ride along). Returns "" when the
 * file is missing, the heading is absent, or the section is just `- (none)`.
 *
 * `cap` truncates: generous on purpose — if a real item is routinely this big that's a
 * signal it should be a one-liner plus a pointer file, not a reason to cut it blind.
 */
export function readOpenSection(relPath: string, cap = 12_000): string {
  try {
    const raw = fs.readFileSync(path.join(config.brainDir, relPath), "utf8");
    const lines = stripHtmlComments(raw).split("\n");
    const start = lines.findIndex((l) => /^##\s+Open\b/i.test(l));
    if (start === -1) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    let body = end === -1 ? rest : rest.slice(0, end);
    // Drop the preamble prose above the first real item — but only when there IS one,
    // so a section written entirely as prose is passed through rather than vanishing.
    const firstItem = body.findIndex((l) => CONTENT_LINE.test(l));
    if (firstItem > 0) body = body.slice(firstItem);
    const out = body.join("\n").trim().slice(0, cap);
    return out && !/^-\s*\(none\)$/i.test(out) ? out : "";
  } catch {
    return "";
  }
}

/** Just the top-level bullet lines of an Open section — used for compact surfaces (calls). */
export function readOpenBullets(relPath: string, cap: number): string {
  const body = readOpenSection(relPath)
    .split("\n")
    .filter((l) => /^\s{0,3}[-*+]\s/.test(l))
    .join("\n")
    .trim();
  return body.length > cap ? `${body.slice(0, cap).trimEnd()}\n- …(more — ask_fig for the rest)` : body;
}
