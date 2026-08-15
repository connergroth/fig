import fs from "node:fs";
import path from "node:path";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { YoutubeTranscript } from "youtube-transcript";
import { z } from "zod";

import { config } from "../core/config";
import { warn } from "../core/log";
import { defineServer, toSdkServer } from "../tools/define";

/**
 * A raw fetch/extract tool — the "httpx + BeautifulSoup" the built-in WebFetch
 * isn't. WebFetch runs a small model over the page and hands back its PARAPHRASE,
 * so you never see the real content: bad for exact quotes, tables, prices, JSON
 * APIs, or structured extraction. This tool returns the actual content instead:
 *
 *   - JSON          → pretty-printed verbatim
 *   - HTML article  → Readability-extracted, then HTML→markdown (clean body text)
 *   - HTML (raw)    → whole-page markdown, when you want nav/links too
 *   - YouTube       → the video transcript
 *   - PDF / binary  → downloaded to a temp file; path returned so the agent Reads it
 *
 * What it does NOT do: run JavaScript or carry a login. Client-rendered pages,
 * paywalls, and login walls (X, Instagram, LinkedIn, …) come back thin — those
 * escalate to the browser subagent, which drives the real logged-in Chrome. So
 * the ladder is: fetch_url (fast, exact) → browser subagent (JS, auth, blocked).
 */

// A real desktop browser UA — many sites 403 the default Node/undici agent.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on what we'll pull into memory
const MAX_CHARS = 60_000; // cap on text returned to the model (≈15k tokens)
const TIMEOUT_MS = 20_000;

/** Where downloaded PDFs/binaries land so the agent can Read them. Inside the vault → readable. */
const DOWNLOAD_DIR = path.join(config.stateDir, "fetch-cache");

function truncate(s: string): string {
  if (s.length <= MAX_CHARS) return s;
  return `${s.slice(0, MAX_CHARS)}\n\n…[truncated at ${MAX_CHARS} chars; ${s.length} total]`;
}

function isYouTube(u: URL): boolean {
  const h = u.hostname.replace(/^www\./, "");
  return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be" || h === "music.youtube.com";
}

async function fetchYouTubeTranscript(rawUrl: string): Promise<string | null> {
  try {
    const items = await YoutubeTranscript.fetchTranscript(rawUrl);
    if (!items?.length) return null;
    const body = items.map((i) => i.text).join(" ").replace(/\s+/g, " ").trim();
    return body || null;
  } catch (e) {
    warn(`youtube transcript failed for ${rawUrl}: ${e}`);
    return null;
  }
}

function htmlToMarkdown(html: string, url: string, mode: "article" | "raw"): string {
  const { document } = parseHTML(html);
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  if (mode === "article") {
    try {
      // Readability mutates the document; fine here since we only use it for the article pass.
      const article = new Readability(document as any).parse();
      if (article?.content && article.textContent && article.textContent.trim().length > 200) {
        const md = turndown.turndown(article.content).trim();
        const title = article.title ? `# ${article.title}\n\n` : "";
        const byline = article.byline ? `*${article.byline}*\n\n` : "";
        return `${title}${byline}${md}`;
      }
    } catch (e) {
      warn(`readability failed for ${url}, falling back to full-page: ${e}`);
    }
  }

  // Raw mode, or article extraction came up empty (non-article page) → whole body.
  const body = document.querySelector("body") ?? document;
  // Strip the noisy non-content nodes before converting.
  for (const sel of ["script", "style", "noscript", "svg", "iframe"]) {
    for (const el of Array.from((body as any).querySelectorAll?.(sel) ?? [])) {
      (el as any).remove?.();
    }
  }
  const md = turndown.turndown((body as any).innerHTML ?? html).trim();
  return md || "(page had no extractable text — it may be JavaScript-rendered; try the browser subagent)";
}

function extFor(contentType: string): string {
  if (contentType.includes("pdf")) return "pdf";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("zip")) return "zip";
  return "bin";
}

async function saveBinary(buf: Buffer, url: string, contentType: string): Promise<string> {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const base = (path.basename(new URL(url).pathname) || "download").replace(/[^\w.-]/g, "_").slice(0, 60);
  // Force the content-type's extension when the basename doesn't already carry it
  // (e.g. arxiv's "/pdf/1706.03762" → "1706.03762.pdf"), since Read sniffs by extension.
  const wantExt = extFor(contentType);
  const name = base.toLowerCase().endsWith(`.${wantExt}`) ? base : `${base}.${wantExt}`;
  const dest = path.join(DOWNLOAD_DIR, `${Date.now()}-${name}`);
  fs.writeFileSync(dest, buf);
  return dest;
}

interface FetchArgs {
  url: string;
  mode?: "auto" | "article" | "raw" | "json";
}

export async function runFetch(args: FetchArgs): Promise<string> {
  let url: URL;
  try {
    url = new URL(args.url);
  } catch {
    return `Not a valid URL: ${args.url}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}" — only http/https.`;
  }

  const mode = args.mode ?? "auto";

  // YouTube → transcript, unless raw was explicitly asked for.
  if (mode !== "raw" && isYouTube(url)) {
    const transcript = await fetchYouTubeTranscript(args.url);
    if (transcript) {
      return `Transcript of ${args.url}:\n\n${truncate(transcript)}`;
    }
    // fall through to a normal fetch if no transcript (e.g. a channel/playlist page)
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/json,application/pdf,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    return `Couldn't fetch ${args.url}: ${e instanceof Error ? e.message : e}. If it's a JS-heavy or login-walled site (X, Instagram, LinkedIn, a paywall), hand the link to the browser subagent.`;
  } finally {
    clearTimeout(timer);
  }

  const status = `${res.status} ${res.statusText}`.trim();
  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if (!res.ok && res.status >= 400) {
    const hint =
      res.status === 403 || res.status === 401
        ? " (blocked or auth-walled — the browser subagent with the logged-in Chrome can likely reach it)"
        : "";
    return `${args.url} returned ${status}${hint}.`;
  }

  // Read the body with a size cap.
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  const oversized = buf.length > MAX_BYTES;
  const headerUrl = res.url && res.url !== args.url ? ` (redirected to ${res.url})` : "";

  // JSON → verbatim, pretty-printed.
  if (contentType.includes("json") || (mode === "json" && !contentType.includes("html"))) {
    const raw = buf.subarray(0, MAX_BYTES).toString("utf8");
    try {
      return `JSON from ${args.url}${headerUrl}:\n\n${truncate(JSON.stringify(JSON.parse(raw), null, 2))}`;
    } catch {
      return `Response from ${args.url}${headerUrl} (content-type ${contentType || "unknown"}):\n\n${truncate(raw)}`;
    }
  }

  // PDF / images / archives / other binary → save to disk, return the path to Read.
  const isBinary =
    contentType.includes("pdf") ||
    contentType.startsWith("image/") ||
    contentType.includes("zip") ||
    contentType.includes("octet-stream") ||
    (!contentType.startsWith("text/") && !contentType.includes("html") && !contentType.includes("xml") && buf.includes(0));
  if (isBinary) {
    const dest = await saveBinary(buf, res.url || args.url, contentType);
    const kind = contentType.includes("pdf") ? "PDF" : contentType.startsWith("image/") ? "image" : "file";
    return `Downloaded ${kind} from ${args.url}${headerUrl} (${contentType || "unknown type"}, ${buf.length} bytes) to:\n${dest}\n\nRead that path to view it.`;
  }

  // HTML / text.
  const html = buf.subarray(0, MAX_BYTES).toString("utf8");
  if (contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(html)) {
    const md = htmlToMarkdown(html, args.url, mode === "raw" ? "raw" : "article");
    const note = oversized ? "\n\n[note: page exceeded 5MB and was truncated before parsing]" : "";
    return `Content of ${args.url}${headerUrl}:\n\n${truncate(md)}${note}`;
  }

  // Plain text / XML / anything else textual → return verbatim.
  return `Content of ${args.url}${headerUrl} (${contentType || "text"}):\n\n${truncate(html)}`;
}

export const fetchServerDef = defineServer({
  key: "fetch",
  kind: "direct",
  purpose:
    "fetch one URL and return its real content — article text, JSON verbatim, YouTube transcript, or a downloaded file path",
  exposure: "both",
  capabilities: [
    {
      name: "fetch_url",
      purpose:
        "fetch one URL and return its real content — article text, JSON verbatim, YouTube transcript, or a downloaded file path",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "a plain outbound GET; was fallback-published before the rewrite as fig_tools.fetch_url",
      namingException:
        "`fetch_url` is the established name in the system prompt, in skill declarations and across the vault. `mcp__fetch__url` reads as a noun rather than an action, so the rename would cost real churn to buy nothing.",
      description:
        "Fetch a URL and get its REAL content back (not a summary). Use this over WebFetch whenever you need " +
        "the actual page — exact quotes, prices, tables, a JSON API response, full article text, or a YouTube " +
        "transcript. Returns: JSON verbatim, article pages as clean markdown, YouTube links as their transcript, " +
        "and PDFs/images downloaded to a local path you then Read. It does NOT run JavaScript or carry a login, so " +
        "if a page comes back thin/empty or returns 401/403 (X, Instagram, LinkedIn, paywalls, app-like sites), " +
        "hand the link to the browser subagent instead — it drives the real logged-in Chrome.",
      input: {
        url: z.string().describe("the URL to fetch"),
        mode: z
          .enum(["auto", "article", "raw", "json"])
          .optional()
          .describe(
            "auto (default): detect type and extract the main content. article: force readable-article extraction. " +
              "raw: whole-page markdown including nav/links (and skip YouTube-transcript handling). json: treat as JSON.",
          ),
      },
      handler: async (args) => {
        try {
          return await runFetch(args as FetchArgs);
        } catch (e) {
          warn(`fetch_url crashed for ${args.url}: ${e}`);
          return `fetch_url failed for ${args.url}: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const fetchServer = toSdkServer(fetchServerDef);
