/**
 * "Clean email link" minting. Whenever fig hands the owner a link to an actual email, it
 * should go out as a short https://open-email.cc/<id> link instead of a raw, ugly gmail
 * web URL. open-email.cc is a Cloudflare-tunnelled domain pointed at the local openpage
 * static server, which serves files from OPENPAGE_PUBLIC_DIR. So a redirect "page" is just
 * a static HTML file at <public>/<id>/index.html that meta-refreshes + JS-redirects to the
 * real email URL. There is NO database — the HTML file on disk IS the mapping.
 *
 * The id is a deterministic short hash of the target URL, so the SAME email always mints
 * the SAME id/file (idempotent, no dupes, safe to re-run). Writes are best-effort: if the
 * file can't be written we fall back to the original URL rather than break message delivery.
 */

import fs from "node:fs";
import path from "node:path";

import { warn } from "../core/log";
import { OPENPAGE_PUBLIC_DIR, RESERVED_IDS, escapeHtml, idFor, normalizeUrl } from "./shortId";

// Re-export the shared minter primitives under the names emailLink has always exposed, so
// existing importers (and emailLink.test.ts) keep working unchanged after the shortId split.
export { OPENPAGE_PUBLIC_DIR, RESERVED_IDS };

// Scheme-LESS on purpose: the minted link is shown to the owner as a bare "open-email.cc/<id>".
// iMessage's data detector still makes it tappable (and prepends https:// on tap), but the
// bare form reads cleaner and — with no lone https:// url — imessage renders it as an inline
// link instead of a scrapey rich preview card. The redirect is served over https regardless.
export const EMAIL_LINK_BASE = "open-email.cc";

function isMessageUrl(target: string): boolean {
  return /^message:\/\//i.test(target);
}

/** The minimal dark redirect page written to disk. `target` is already the raw URL. */
function redirectHtml(target: string): string {
  const esc = escapeHtml(target);
  if (isMessageUrl(target)) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>opening your email in Mail…</title>
<style>
  html,body{margin:0;height:100%;background:#0d0d10;color:#e7e5e0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;text-align:center}
  p{margin:0;color:#8a877f;font-size:16px;letter-spacing:.2px}
  a{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 22px;border-radius:8px;
    background:#c9b7e6;color:#18151f;text-decoration:none;font-size:17px;font-weight:650}
  a:hover{background:#d8c7f3}
</style>
</head>
<body><div class="wrap">
  <p>opening your email in Mail…</p>
  <a href="${esc}">Open in Mail</a>
</div>
<script>setTimeout(function(){ location.href = ${JSON.stringify(target)}; }, 250)</script>
</body>
</html>
`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${esc}">
<title>opening your email…</title>
<style>
  html,body{margin:0;height:100%;background:#0d0d10;color:#e7e5e0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
  p{margin:0;color:#8a877f;font-size:16px;letter-spacing:.2px}
  a{color:#c9b7e6;text-decoration:none;font-size:15px}
  a:hover{text-decoration:underline}
</style>
</head>
<body><div class="wrap">
  <p>opening your email…</p>
  <a href="${esc}">tap here if it doesn't open</a>
</div>
<script>location.replace(${JSON.stringify(target)})</script>
</body>
</html>
`;
}

/**
 * Mint (or reuse) a clean open-email.cc link for `targetUrl`. Writes the redirect file to
 * <OPENPAGE_PUBLIC_DIR>/<id>/index.html (idempotent — same URL → same id → same file) and
 * returns `${EMAIL_LINK_BASE}/${id}` = a bare `open-email.cc/<id>` (no scheme, no trailing
 * slash; iMessage adds https:// on tap and the server 301s to add the slash).
 *
 * Best-effort: on any fs failure, logs a warning and returns the ORIGINAL url unchanged, so
 * a redirect-file hiccup never breaks message delivery.
 */
export async function mintEmailLink(targetUrl: string): Promise<string> {
  const url = normalizeUrl(targetUrl);
  if (!url) return targetUrl;
  const id = idFor(url);
  try {
    const dir = path.join(OPENPAGE_PUBLIC_DIR, id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "index.html"), redirectHtml(url), "utf8");
    return `${EMAIL_LINK_BASE}/${id}`;
  } catch (e) {
    warn(`mintEmailLink write failed, falling back to raw url: ${e}`);
    return targetUrl;
  }
}

/**
 * Rewrite email links in `raw` to clean open-email.cc short links. Three things get rewritten:
 *   (a) an explicit `[[email:<url>]]` token anywhere → the minted short link (token removed).
 *   (b) a bare `https://mail.google.com/...` web URL → its minted short link.
 *   (c) a bare `message://...` Mail.app URL → its minted short link.
 * Everything else — non-gmail urls, open-page.cc/open-email.cc links, image urls — is left
 * exactly as-is. Trailing punctuation/newlines are kept out of the matched url. Successful
 * minted links are rendered as `✉️ open-email.cc/<id>`. Mints run concurrently.
 */
export async function rewriteEmailLinks(raw: string): Promise<string> {
  interface Span {
    start: number;
    end: number;
    url: string;
  }
  const spans: Span[] = [];
  const TRAILING_URL_JUNK = /[.,;:!?)\]}'">]+$/;
  const EMAIL_EMOJI_PREFIX = /(?:📧|✉️?|📨|📩)[ \t]*$/u;

  // (a) explicit [[email:<url>]] tokens.
  const TOKEN = /\[\[email:([^\]]+)\]\]/gi;
  const tokenRanges: Array<[number, number]> = [];
  for (const m of raw.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    tokenRanges.push([start, end]);
    spans.push({ start, end, url: m[1].trim() });
  }

  const addBareUrlSpans = (re: RegExp): void => {
    for (const m of raw.matchAll(re)) {
      const start = m.index ?? 0;
      if (tokenRanges.some(([ts, te]) => start >= ts && start < te)) continue;
      // Keep trailing punctuation/quotes/brackets/newlines out of the url.
      const trimmed = m[0].replace(TRAILING_URL_JUNK, "");
      spans.push({ start, end: start + trimmed.length, url: trimmed });
    }
  };

  // (b)/(c) bare gmail web urls and Mail.app message urls — but skip any that live INSIDE
  // a [[email:…]] token (the token's inner url is already captured above; matching it again
  // would overlap).
  addBareUrlSpans(/https:\/\/mail\.google\.com\/\S+/gi);
  addBareUrlSpans(/message:\/\/\S+/gi);

  if (!spans.length) return raw;
  spans.sort((a, b) => a.start - b.start);

  const links = await Promise.all(spans.map((s) => mintEmailLink(s.url)));

  let out = "";
  let last = 0;
  spans.forEach((s, i) => {
    if (s.start < last) return; // defensive: skip any overlap
    const link = links[i];
    const minted = link.startsWith(`${EMAIL_LINK_BASE}/`);
    const before = raw.slice(last, s.start);
    out += (minted ? before.replace(EMAIL_EMOJI_PREFIX, "") : before) + (minted ? `✉️ ${link}` : link);
    last = s.end;
  });
  out += raw.slice(last);
  return out;
}
