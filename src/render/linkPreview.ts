/**
 * "Clean link preview" minting. When fig sends a bare external web URL (a news article, a
 * dashboard link, a partiful invite, …), iMessage tries to scrape that raw destination for a
 * rich preview card — and often FAILS (JS-rendered pages, bot walls, slow servers) so the owner
 * sees an ugly "tap to view preview" stub or just a naked link. This mirrors Flip: instead of
 * the raw URL, we send a short open-url.cc/<id> wrapper whose static page has the OpenGraph
 * card baked in AHEAD of time. iMessage hits our fast static file, gets clean og: tags
 * instantly, and renders the card every time; a human tap meta-refreshes on to the real URL.
 *
 * Same infra as emailLink: open-url.cc is a Cloudflare-tunnelled domain pointed at the local
 * openpage static server (OPENPAGE_PUBLIC_DIR). A "preview page" is just a static HTML file at
 * <public>/<id>/index.html carrying the scraped og:* meta tags + a meta-refresh/JS redirect to
 * the real target. There is NO database — the file on disk IS the mapping. The id is a
 * deterministic hash of the target url (idempotent — same url → same id/file, safe to re-run).
 *
 * Best-effort throughout: if the scrape fails we still mint a minimal card (host name +
 * favicon) so we never emit a naked wrapper; if the WRITE fails we fall back to the original
 * url unchanged, so a hiccup never breaks message delivery.
 */

import fs from "node:fs";
import path from "node:path";

import { parseHTML } from "linkedom";

import { warn } from "../core/log";
import { isImageUrl } from "./chunking";
import { OPENPAGE_PUBLIC_DIR, escapeHtml, idFor, normalizeUrl } from "./shortId";

// Scheme-LESS by convention (same as EMAIL_LINK_BASE): the wrapper is shown to the owner as a
// bare "open-url.cc/<id>". Unlike the email wrapper — which is kept INLINE to avoid a card —
// this one is deliberately lifted onto its own bubble (see chunking.splitBareUrls) so iMessage
// DOES render the baked preview card. The redirect is served over https regardless.
export const LINK_PREVIEW_BASE = "open-url.cc";

// A real desktop browser UA — many sites 403 the default Node/undici agent (same as fetch/tool).
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SCRAPE_TIMEOUT_MS = 5_000;
const MAX_SCRAPE_BYTES = 1_000_000; // og:* tags live in <head> near the top — 1MB is ample

/**
 * Hosts we must NEVER wrap: our own short-link domains (already ours — double-wrapping would
 * be silly and recursive), gmail web urls (those go through emailLink, not here), and
 * maps.apple.com deep-links (they open Maps and must stay raw). Compared host-only, www-stripped.
 */
const SKIP_HOSTS = new Set([
  "open-url.cc",
  "open-email.cc",
  "open-page.cc",
  "mail.google.com",
  "maps.apple.com",
]);

interface Card {
  /** The real destination the wrapper redirects to. */
  target: string;
  title?: string;
  description?: string;
  /** Absolute og:image / twitter:image url. */
  image?: string;
  siteName?: string;
  /** Absolute favicon url. */
  favicon?: string;
}

/** Host of a url (www-stripped, lowercased), or undefined if it won't parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** Resolve a possibly-relative url against `base` → absolute; undefined if empty/invalid. */
function absolutize(maybeRelative: string | undefined | null, base: string): string | undefined {
  const v = maybeRelative?.trim();
  if (!v) return undefined;
  try {
    return new URL(v, base).href;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the target's HTML (follow redirects, browser UA, ~5s timeout, byte-capped). Returns
 * the html string, or null on any failure / non-html response — the caller degrades to a
 * fallback card. Never throws.
 */
async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    // Only parse markup for og tags. An empty content-type is tolerated (some servers omit it).
    if (ct && !ct.includes("html") && !ct.includes("xml")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, MAX_SCRAPE_BYTES).toString("utf8");
  } catch (e) {
    warn(`link preview scrape failed for ${url}: ${e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse OpenGraph / twitter / <title> / favicon out of a page's html. Every field is optional. */
function parseOg(html: string, baseUrl: string): Omit<Card, "target"> {
  const { document } = parseHTML(html);
  // Try each selector in order, first non-empty content wins. og:* appears as either
  // property="…" (spec) or name="…" (sloppy sites), so check both.
  const pick = (...selectors: string[]): string | undefined => {
    for (const sel of selectors) {
      const c = document.querySelector(sel)?.getAttribute("content")?.trim();
      if (c) return c;
    }
    return undefined;
  };

  const title =
    pick(
      'meta[property="og:title"]',
      'meta[name="og:title"]',
      'meta[name="twitter:title"]',
      'meta[property="twitter:title"]',
    ) || document.querySelector("title")?.textContent?.trim() || undefined;

  const description = pick(
    'meta[property="og:description"]',
    'meta[name="og:description"]',
    'meta[name="twitter:description"]',
    'meta[property="twitter:description"]',
    'meta[name="description"]',
  );

  const rawImage = pick(
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="og:image:url"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  );

  const siteName = pick('meta[property="og:site_name"]', 'meta[name="og:site_name"]');

  // rel~="icon" matches rel="icon" AND rel="shortcut icon"; apple-touch-icon is a separate token.
  const iconEl =
    document.querySelector('link[rel~="icon"]') ||
    document.querySelector('link[rel="apple-touch-icon"]');
  const rawFavicon = iconEl?.getAttribute("href");

  return {
    title,
    description,
    image: absolutize(rawImage, baseUrl),
    siteName,
    favicon: absolutize(rawFavicon, baseUrl),
  };
}

/**
 * Build the card for `target`: scrape its og data, and fill any gaps with a graceful fallback
 * (title = host, favicon = https://<host>/favicon.ico) so we never end up with a naked card.
 * Never throws — a scrape/parse failure degrades to the fallback.
 */
async function buildCard(target: string): Promise<Card> {
  const host = hostOf(target);
  const fallbackFavicon = host ? `https://${host}/favicon.ico` : undefined;
  try {
    const html = await fetchHtml(target);
    const og = html ? parseOg(html, target) : {};
    return {
      target,
      title: og.title || host || target,
      description: og.description,
      image: og.image,
      siteName: og.siteName || host,
      favicon: og.favicon || fallbackFavicon,
    };
  } catch (e) {
    warn(`link preview card build failed for ${target}: ${e}`);
    return { target, title: host || target, favicon: fallbackFavicon, siteName: host };
  }
}

/**
 * The static preview page: baked og:* meta tags + a JS redirect to the real url.
 *
 * IMPORTANT — no `<meta http-equiv="refresh">` here, on purpose. iMessage's link-preview
 * fetcher (UA `facebookexternalhit/1.1 Facebot Twitterbot/1.0`) is WebKit-based: it HONORS an
 * instant meta-refresh, so it would bounce straight off this page onto the target and try to
 * scrape the target itself — exactly what this wrapper exists to avoid. When the target is
 * bot-blocked/JS-walled/login-walled the crawler then comes back empty and iMessage falls back
 * to the grey "tap to load preview" stub. So: humans get redirected by JS, and the redirect is
 * skipped for any crawler UA so it stays on the page and reads the baked card.
 */
function previewHtml(card: Card, id: string): string {
  const target = card.target;
  const escTarget = escapeHtml(target);
  // og:url must point at THIS wrapper page, never the target. Some preview fetchers treat
  // og:url as canonical and re-fetch it — pointing it at the target would walk the crawler
  // straight onto the bot-walled destination, the same failure the meta-refresh caused.
  const selfUrl = `https://${LINK_PREVIEW_BASE}/${id}/`;
  const title = card.title || hostOf(target) || target;
  // Emit a <meta> only when we actually have the value — a blank tag is worse than none.
  const meta = (attr: "property" | "name", key: string, val?: string): string =>
    val ? `<meta ${attr}="${key}" content="${escapeHtml(val)}">\n` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(selfUrl)}">
${meta("property", "og:title", title)}${meta("property", "og:description", card.description)}${meta("property", "og:image", card.image)}${meta("property", "og:site_name", card.siteName)}<meta name="twitter:card" content="${card.image ? "summary_large_image" : "summary"}">
${meta("name", "twitter:title", title)}${meta("name", "twitter:description", card.description)}${meta("name", "twitter:image", card.image)}${card.favicon ? `<link rel="icon" href="${escapeHtml(card.favicon)}">\n` : ""}<style>
  html,body{margin:0;height:100%;background:#0d0d10;color:#e7e5e0;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
  p{margin:0;color:#8a877f;font-size:16px;letter-spacing:.2px}
  a{color:#c9b7e6;text-decoration:none;font-size:15px}
  a:hover{text-decoration:underline}
</style>
</head>
<body><div class="wrap">
  <p>opening…</p>
  <a href="${escTarget}">tap here if it doesn't open</a>
</div>
<script>if(!/facebookexternalhit|Facebot|Twitterbot|Slackbot|Discordbot|WhatsApp|LinkedInBot|TelegramBot|Applebot|SkypeUriPreview|Iframely|redditbot|bot\b|crawler|spider|preview/i.test(navigator.userAgent))location.replace(${JSON.stringify(target)})</script>
</body>
</html>
`;
}

/**
 * Mint (or reuse) a clean open-url.cc preview wrapper for `targetUrl`. Scrapes the target's
 * OpenGraph card, writes the baked preview page to <OPENPAGE_PUBLIC_DIR>/<id>/index.html
 * (idempotent — same url → same id → same file) and returns `${LINK_PREVIEW_BASE}/${id}` =
 * a bare `open-url.cc/<id>` (no scheme, no trailing slash).
 *
 * Best-effort: on any fs failure (or unexpected throw), logs a warning and returns the
 * ORIGINAL url unchanged, so a redirect-file hiccup never breaks message delivery. A failed
 * SCRAPE does NOT fall back to raw — we still mint a minimal card (host + favicon).
 */
export async function mintLinkPreview(targetUrl: string): Promise<string> {
  const url = normalizeUrl(targetUrl);
  if (!url) return targetUrl;
  try {
    const id = idFor(url);
    const card = await buildCard(url);
    const dir = path.join(OPENPAGE_PUBLIC_DIR, id);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "index.html"), previewHtml(card, id), "utf8");
    return `${LINK_PREVIEW_BASE}/${id}`;
  } catch (e) {
    warn(`mintLinkPreview write failed, falling back to raw url: ${e}`);
    return targetUrl;
  }
}

/**
 * Hosts that must never be sent as a native rich-link card: gmail/open-email.cc links are
 * deliberately kept INLINE (no card) by the email-link renderer.
 *
 * `maps.apple.com` is deliberately NOT here. A native card sends the SAME url with an
 * LPLinkMetadata payload attached, so the tap target is unchanged and the universal link
 * still opens the Maps app — while maps.apple.com's og:image is a real signed map snapshot
 * with the destination pinned. Without the card the bubble is bare text, and since card
 * metadata comes from the SENDER (never the recipient), the receiving device can only show
 * the grey "Tap to Load Preview" stub. It still must never be WRAPPED (see SKIP_HOSTS) —
 * the open-url.cc wrapper replaces the tap target with a web redirect, which does break the
 * deep link.
 */
const NO_RICH_LINK_HOSTS = new Set(["mail.google.com", "open-email.cc"]);

/**
 * If `chunk` is a bubble consisting of NOTHING but one http(s) url, return that url — the
 * caller sends it as a native iMessage rich-link card (`SendOptions.richLinkUrl`) so it
 * renders a real preview instead of the grey "Tap to Load Preview" stub. Returns null for
 * anything else: text around the url (a card needs the url to be the whole message), image
 * urls (those become inline attachments), and the NO_RICH_LINK_HOSTS above.
 */
export function bareRichLinkUrl(chunk: string): string | null {
  const url = chunk.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  if (isImageUrl(url)) return null;
  const host = hostOf(url);
  if (!host || NO_RICH_LINK_HOSTS.has(host)) return null;
  return url;
}

/** Should this bare http(s) url be wrapped in a preview, or left exactly as-is? */
export function shouldWrapUrl(url: string): boolean {
  if (isImageUrl(url)) return false; // image urls become inline attachments, not preview cards
  const host = hostOf(url);
  if (!host) return false; // unparseable — leave it alone
  return !SKIP_HOSTS.has(host);
}

/**
 * Rewrite bare external web URLs in `raw` to clean open-url.cc preview wrappers. Only
 * "general" http(s) links are wrapped; image urls, our own short-link domains
 * (open-url/open-email/open-page), gmail web urls, and apple-maps deep-links are left
 * untouched (see shouldWrapUrl / SKIP_HOSTS). Trailing punctuation/newlines are kept out of
 * the matched url. Non-http(s) targets (message://, local paths) never match. Mints run
 * concurrently. Intended to run AFTER rewriteEmailLinks, so email links are already minted
 * (open-email.cc) and skipped here. The replacement is scheme-less so — when it lands alone
 * on a line — chunking lifts it onto its own bubble and iMessage renders the baked card.
 */
/** True when [start,end) is the ONLY non-whitespace content on its line in `raw`. */
function isOwnLine(raw: string, start: number, end: number): boolean {
  const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = raw.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = raw.length;
  return raw.slice(lineStart, start).trim() === "" && raw.slice(end, lineEnd).trim() === "";
}

export async function rewriteLinkPreviews(raw: string): Promise<string> {
  const TRAILING_URL_JUNK = /[.,;:!?)\]}'">]+$/;
  interface Span {
    start: number;
    end: number;
    url: string;
  }
  const spans: Span[] = [];
  for (const m of raw.matchAll(/https?:\/\/\S+/gi)) {
    const start = m.index ?? 0;
    const trimmed = m[0].replace(TRAILING_URL_JUNK, "");
    if (!shouldWrapUrl(trimmed)) continue;
    // A url ALONE on its own line is delivered as a native iMessage rich link
    // (`imsg send-rich --url`, see deliver.ts) — LinkPresentation fetches the target
    // itself on this mac and bakes a real card into the message. Wrapping it would
    // point that fetch at our redirect page instead of the real site, so leave it raw.
    // Inline links (mid-sentence) can never be carded, so those still get the short wrapper.
    if (isOwnLine(raw, start, start + trimmed.length)) continue;
    spans.push({ start, end: start + trimmed.length, url: trimmed });
  }
  if (!spans.length) return raw;

  const links = await Promise.all(spans.map((s) => mintLinkPreview(s.url)));

  let out = "";
  let last = 0;
  spans.forEach((s, i) => {
    if (s.start < last) return; // defensive: skip any overlap
    out += raw.slice(last, s.start) + links[i];
    last = s.end;
  });
  out += raw.slice(last);
  return out;
}
