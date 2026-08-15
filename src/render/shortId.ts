/**
 * Shared primitives for the "static-file redirect" link minters (emailLink, linkPreview).
 *
 * Both minters do the same core trick: turn a target URL into a short, deterministic base36
 * id, then write a static HTML file to <OPENPAGE_PUBLIC_DIR>/<id>/index.html. That dir is
 * served by the local openpage http server and exposed over a Cloudflare tunnel, so the file
 * is reachable at open-email.cc/<id>, open-page.cc/<id>, AND open-url.cc/<id> (all three
 * domains point at the same public dir). There is NO database — the file on disk IS the
 * mapping. The id is a hash of the URL, so the SAME url always mints the SAME id/file
 * (idempotent, no dupes, safe to re-run).
 *
 * These helpers are the bits both minters must agree on (id scheme + reserved-word guard +
 * public dir + html escaping); minting/rewriting logic proper lives in each minter file.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Where the openpage static server serves from. Overridable (tests point it at a temp dir). */
export const OPENPAGE_PUBLIC_DIR =
  process.env.OPENPAGE_PUBLIC_DIR || path.join(os.homedir(), "GitHub", "openpage", "public");

/**
 * openpage's own top-level paths. A minted id must NEVER collide with one of these — otherwise
 * our redirect file would shadow (or be shadowed by) a real openpage route. Shared across every
 * minter so they can't diverge and start colliding with openpage routes independently.
 */
export const RESERVED_IDS = new Set(["doc", "paper", "x", "research", "ex", "assets", "index", "e"]);

/** Normalize a target URL before hashing so trivially-different strings don't fork the id. */
export function normalizeUrl(targetUrl: string): string {
  return targetUrl.trim();
}

/**
 * Deterministic short id for a URL: sha256 → first 5 bytes → base36 (~8 lowercase
 * alphanumeric chars). If the id lands on a reserved word, append a salt char and rehash
 * (still deterministic) until it doesn't — the append can't loop forever in practice.
 */
export function idFor(normalizedUrl: string): string {
  let salt = "";
  for (let attempt = 0; attempt < 64; attempt++) {
    const digest = crypto.createHash("sha256").update(normalizedUrl + salt).digest();
    const n = BigInt("0x" + digest.subarray(0, 5).toString("hex"));
    const id = n.toString(36);
    if (!RESERVED_IDS.has(id)) return id;
    salt += "x"; // reserved-word collision — rehash with a suffix and try again
  }
  // Astronomically unlikely fallback: guaranteed non-reserved.
  return "e" + crypto.createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 8);
}

/** HTML-escape a value so it can't break out of an attribute or inject markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
