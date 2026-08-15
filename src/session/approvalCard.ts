/**
 * The RENDERED APPROVAL CARD — the picture that rides along with a money 🔐.
 *
 * A model plus a renderer, and three rules the design turns on:
 *
 *   1. **Image + ONE text line, and the TEXT is the tapback target.** iMessage's lock screen
 *      shows "1 Image", not its contents — a card-only prompt would force them to unlock and open
 *      the thread just to learn what they're approving, which is strictly worse than today's text.
 *      So the card is an attachment and `session.ts` sends the question as its own bubble. This
 *      file therefore only ever produces the PICTURE; the text line lives with the lane that
 *      raised the 🔐 (see `webExport/orderGate.ts`).
 *   2. **The TOTAL is the largest element on the card.** Pretty must not train approval-on-vibes,
 *      so `total` is required by the type — there is no way to build a card without one.
 *   3. **Off-pattern facts get FLAGGED, never blended in.** `flags` renders as a loud amber block
 *      above the totals. Pretty for the normal case, alarming for the weird one.
 *
 * Site-agnostic on purpose. Nothing here knows what GrubHub is: it takes a merchant, some lines,
 * a breakdown, a total, a payment footer and a flag list. An Amazon buy renders through the same
 * type with different field values.
 *
 * WHY IT'S SAFE TO PUT A PICTURE IN THE MONEY PATH:
 *   - It is fed from a SERVER read (the ordering CLI's `describe --json`, which renders purely
 *     from the API and throws rather than emit a partial block), never from the agent's own
 *     summary of what it thinks it put in the cart. See the hard requirement in the design note.
 *   - No model is in the path. No prompt, no classification, no judgment — a pure function from
 *     that server read to HTML.
 *   - It is BEST-EFFORT END TO END. Every failure (no Chrome, no Playwright, a logo that won't
 *     download, a write that fails) returns null and the 🔐 goes out as text with the store and
 *     the total still in it. A card can never delay an approval past its budget and can never
 *     block one. A missing logo must NEVER delay or block an approval.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log, warn } from "../core/log";
import { clockTime } from "./approvalPrompt";

/** One purchased/affected line on the card. */
export interface ApprovalCardLine {
  name: string;
  /** The options/config under the name — "chicken · white rice · guac". */
  detail?: string;
  /** Pre-formatted money, e.g. "$17.30". Formatting is the caller's, so this file stays currency-agnostic. */
  price?: string;
}

/** A breakdown row above the total (subtotal / fees / tax / tip). */
export interface ApprovalCardRow {
  label: string;
  value: string;
}

/**
 * Everything the card renders. `total` is non-optional by design — see rule 2 above.
 * `id` is the 🔐's minted tag, which is why the image is built LATE (session.ts mints the id,
 * then asks for the picture): two stacked approvals produce two cards that visibly disagree
 * about which one they belong to, which is the image half of the "stacked 🔐s are
 * indistinguishable" bug.
 */
export interface ApprovalCard {
  id: string;
  title: string;
  subtitle?: string;
  /** `data:image/png;base64,…` for the brand mark, or null → `logoEmoji` is drawn instead. */
  logoDataUri?: string | null;
  /** The last resort in the brand-mark chain. Never blank — a card always has a mark. */
  logoEmoji: string;
  lines: ApprovalCardLine[];
  /** The status pill under the lines — "Pickup ASAP · ready ~12:22pm". */
  status?: string;
  rows: ApprovalCardRow[];
  total: { label: string; value: string };
  payment?: { badge: string; text: string };
  /** Off-pattern facts. Rendered LOUD. Empty is the normal case. */
  flags: string[];
  /** When the card was built, so a card sitting in scrollback dates itself. */
  at: number;
}

/** Where cards and cached brand marks live. Scratch, because they're disposable by nature. */
const CARD_DIR = join(homedir(), "scratch", "approval-cards");
const LOGO_DIR = join(CARD_DIR, "logos");

/** Time boxes. Worst case ~9s, against a 10-minute approval window. */
const LOGO_TIMEOUT_MS = 2_500;
const RENDER_TIMEOUT_MS = 6_500;
/** A brand mark is decoration; anything bigger than this is a mis-hit, not a logo. */
const LOGO_MAX_BYTES = 512 * 1024;
/** Keep the last N cards on disk purely so a rendered card can be re-read/debugged. */
const CARD_KEEP = 20;

/** Card geometry. 440px is the prototype's width and reads well as an iMessage attachment. */
const CARD_WIDTH = 440;

function ensureDirs(): void {
  mkdirSync(LOGO_DIR, { recursive: true });
}

/** HTML-escape. Every single interpolated value goes through this — the card renders API text. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `8:41pm` — literally approvalPrompt's formatter, not a copy of it. A second copy is how the
 * card and the text bubble start disagreeing, and how both end up printing the mini's clock
 * instead of the owner's. One owner: the time on the card is the same owner-timezone render as
 * the "expires 8:41pm" line beside it.
 */
const cardClock = clockTime;

/**
 * The card as HTML. PURE — no fs, no network, no clock beyond what's on the model. That's what
 * makes the layout testable without a browser, which matters because this is the surface that
 * has to keep telling the truth about a dollar figure.
 *
 * Lifted from `~/scratch/approval-ui/card2.html` with three additions the design called for:
 * the `#id` tag, the flags block, and a brand-mark slot that degrades to an emoji.
 */
export function renderApprovalCardHtml(card: ApprovalCard): string {
  const mark = card.logoDataUri
    ? `<img class="icon" src="${esc(card.logoDataUri)}" alt="">`
    : `<div class="icon icon-emoji">${esc(card.logoEmoji)}</div>`;

  const lines = card.lines
    .map(
      (li) => `
      <div class="item">
        <div class="item-main">
          <div class="name">${esc(li.name)}</div>
          ${li.detail ? `<div class="opts">${esc(li.detail)}</div>` : ""}
        </div>
        ${li.price ? `<div class="price">${esc(li.price)}</div>` : ""}
      </div>`,
    )
    .join("");

  const rows = card.rows
    .map((r) => `<div class="row"><span>${esc(r.label)}</span><span>${esc(r.value)}</span></div>`)
    .join("");

  // Loud, separated, above the total — the design's "never blended in".
  const flags = card.flags.length
    ? `<div class="flags">
        <div class="flags-head">⚠️ ${card.flags.length === 1 ? "check this" : `${card.flags.length} things to check`}</div>
        ${card.flags.map((f) => `<div class="flag">${esc(f)}</div>`).join("")}
      </div>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width: ${CARD_WIDTH}px;
    background: #000;
    font-family: 'SF Pro Text', -apple-system, 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { background:#14161a; border:1px solid #262b33; border-radius:22px; padding:22px 22px 20px; color:#e8eaed; }
  .head { display:flex; align-items:center; gap:10px; padding-bottom:14px; border-bottom:1px solid #23272e; }
  .head .icon { width:38px; height:38px; border-radius:9px; object-fit:cover; background:#fff; flex:0 0 38px; }
  .head .icon-emoji { display:flex; align-items:center; justify-content:center; background:#1b1f25; font-size:20px; }
  .head .store { font-size:17px; font-weight:600; letter-spacing:-0.2px; }
  .head .addr { font-size:12.5px; color:#8a9099; margin-top:2px; }
  .head .flex { flex:1; min-width:0; }
  /* The #id tag. Same tag as the text bubble, so a card in scrollback names its own prompt. */
  .head .tag { font-size:11.5px; color:#6f757e; font-variant-numeric:tabular-nums; text-align:right; flex:0 0 auto; }
  .head .tag b { display:block; color:#9aa1aa; font-size:12.5px; font-weight:600; }

  .items { padding:15px 0 4px; }
  .item { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px; }
  .item-main { min-width:0; }
  .item .name { font-size:15px; font-weight:500; }
  .item .opts { font-size:12.5px; color:#7f858e; margin-top:3px; line-height:1.45; max-width:285px; }
  .item .price { font-size:15px; font-variant-numeric:tabular-nums; color:#c9ced6; white-space:nowrap; }

  .status { display:flex; align-items:center; gap:7px; background:#1b1f25; border-radius:10px;
            padding:9px 11px; margin:6px 0 14px; font-size:13px; color:#b3b9c2; }
  .dot { width:6px; height:6px; border-radius:50%; background:#3ddc84; box-shadow:0 0 8px #3ddc84aa; flex:0 0 6px; }

  /* Off-pattern facts. Deliberately the only warm colour on the card. */
  .flags { background:#2a1d0c; border:1px solid #7a4f12; border-radius:12px; padding:11px 12px; margin:0 0 14px; }
  .flags-head { font-size:12px; font-weight:700; color:#ffc65c; letter-spacing:0.2px; text-transform:uppercase; }
  .flag { font-size:13px; color:#f4d9a6; margin-top:5px; line-height:1.4; }

  .totals { border-top:1px solid #23272e; padding-top:13px; }
  .row { display:flex; justify-content:space-between; font-size:13.5px; color:#8a9099; margin-bottom:6px; font-variant-numeric:tabular-nums; }
  .row.total { margin-top:9px; margin-bottom:0; align-items:baseline; }
  .row.total .l { font-size:15px; color:#e8eaed; font-weight:600; }
  /* Rule 2: the biggest thing on the card, always. */
  .row.total .r { font-size:26px; color:#fff; font-weight:700; letter-spacing:-0.5px; }

  .pay { display:flex; align-items:center; gap:8px; margin-top:14px; padding-top:13px;
         border-top:1px solid #23272e; font-size:13px; color:#8a9099; }
  .pay .badge { background:#2e77bb; color:#fff; font-size:10px; font-weight:700; padding:3px 6px;
                border-radius:4px; letter-spacing:0.3px; }
</style></head>
<body>
  <div class="card">
    <div class="head">
      ${mark}
      <div class="flex">
        <div class="store">${esc(card.title)}</div>
        ${card.subtitle ? `<div class="addr">${esc(card.subtitle)}</div>` : ""}
      </div>
      <div class="tag"><b>#${esc(card.id)}</b>${esc(cardClock(card.at))}</div>
    </div>

    <div class="items">${lines}</div>
    ${card.status ? `<div class="status"><div class="dot"></div><div>${esc(card.status)}</div></div>` : ""}
    ${flags}

    <div class="totals">
      ${rows}
      <div class="row total"><span class="l">${esc(card.total.label)}</span><span class="r">${esc(card.total.value)}</span></div>
    </div>

    ${
      card.payment
        ? `<div class="pay"><span class="badge">${esc(card.payment.badge)}</span><span>${esc(card.payment.text)}</span></div>`
        : ""
    }
  </div>
</body></html>`;
}

/**
 * Fetch a brand mark and return it as a data URI, or null.
 *
 * Chain: the merchant logo the site's own API returns → a favicon by domain →
 * the emoji the caller supplied. The API logo is first because it comes from the SAME server read
 * everything else on the card comes from, and it's higher resolution.
 *
 * Cached on disk by URL hash so a repeat order costs nothing. Never throws, always time-boxed:
 * a logo is decoration on a safety surface and must not be able to slow it down.
 */
export async function fetchLogoDataUri(urls: (string | null | undefined)[]): Promise<string | null> {
  for (const url of urls) {
    if (!url) continue;
    try {
      ensureDirs();
      const cacheKey = createHash("sha1").update(url).digest("hex").slice(0, 16);
      const cached = readdirSync(LOGO_DIR).find((f) => f.startsWith(cacheKey));
      if (cached) {
        const buf = readFileSync(join(LOGO_DIR, cached));
        if (buf.length > 0) return `data:${mimeFromName(cached)};base64,${buf.toString("base64")}`;
      }

      const res = await fetch(url, { signal: AbortSignal.timeout(LOGO_TIMEOUT_MS) });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
      if (!type.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > LOGO_MAX_BYTES) continue;
      writeFileSync(join(LOGO_DIR, `${cacheKey}.${extFromMime(type)}`), buf);
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
      // Any failure just means the next candidate, and eventually the emoji. Never fatal.
    }
  }
  return null;
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "img";
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop() || "";
  if (ext === "png") return "image/png";
  if (ext === "jpg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

/** `google.com/s2/favicons` — step two of the brand-mark chain, when a merchant domain is known. */
export function faviconUrl(domain: string | null | undefined): string | null {
  const d = (domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`;
}

/** Keep the card folder from growing forever. Cosmetic housekeeping; failures are ignored. */
function pruneCards(): void {
  try {
    const files = readdirSync(CARD_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: statSync(join(CARD_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(CARD_KEEP)) rmSync(join(CARD_DIR, f), { force: true });
  } catch {
    /* housekeeping only */
  }
}

/**
 * Render the card to a PNG and return its absolute path, or null on ANY failure.
 *
 * Mechanism is the design's: headless Chrome screenshots an HTML template. It goes through
 * Playwright with `channel: "chrome"` — i.e. the same Google Chrome binary the rest of the bot
 * drives — because an ELEMENT screenshot gives an exact-fit card with no height guessing, where
 * `chrome --screenshot` can only capture a fixed window and would either clip the total or pad
 * the card with dead space. No new dependency either way: playwright is already the browse
 * lane's engine, and it's imported lazily here for the same reason `browser/chrome.ts` does it
 * (a machine that hasn't run `npm install` still boots; only the picture degrades).
 *
 * A separate short-lived headless browser, not the shared live Chrome: this must not touch the
 * profile, the cookie jar, or the tab the owner (or a live browse job) is looking at.
 */
export async function renderApprovalCardImage(card: ApprovalCard): Promise<string | null> {
  let browser: { close(): Promise<void> } | null = null;
  try {
    ensureDirs();
    const html = renderApprovalCardHtml(card);
    const out = join(CARD_DIR, `card-${card.id}-${card.at}.png`);

    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      channel: "chrome",
      timeout: RENDER_TIMEOUT_MS,
      args: ["--hide-scrollbars"],
    });
    const ctx = await (browser as import("playwright").Browser).newContext({
      // Retina, so the total is crisp rather than a fuzzy number on a money prompt.
      deviceScaleFactor: 2,
      viewport: { width: CARD_WIDTH, height: 900 },
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: "load" });
    const buf = await page.locator(".card").screenshot({ type: "png" });
    if (!buf?.length) return null;
    writeFileSync(out, buf);
    pruneCards();
    log(`approval card: rendered #${card.id} (${buf.length}B, ${card.flags.length} flag(s))`);
    return existsSync(out) ? out : null;
  } catch (e) {
    // Silent as far as the owner is concerned — they still get the text 🔐 with store + total.
    warn(`approval card render failed (sending the 🔐 as text): ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* already gone */
    }
  }
}
