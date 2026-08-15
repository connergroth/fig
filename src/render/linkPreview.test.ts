import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the minter at a throwaway dir BEFORE importing the module (OPENPAGE_PUBLIC_DIR is read
// at module load), so tests never write into the real openpage public dir.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "linkpreview-test-"));
process.env.OPENPAGE_PUBLIC_DIR = TMP_DIR;

// Imported lazily inside main() (after the env override above) so the module reads
// OPENPAGE_PUBLIC_DIR from the temp dir at load time — never the real openpage dir.
type LinkPreviewModule = typeof import("./linkPreview");
type ChunkingModule = typeof import("./chunking");
let mod: LinkPreviewModule;
let chunking: ChunkingModule;
const idOf = (link: string): string => link.slice(mod.LINK_PREVIEW_BASE.length + 1);
const htmlFor = (link: string): string =>
  fs.readFileSync(path.join(TMP_DIR, idOf(link), "index.html"), "utf8");

const ARTICLE_URL = "https://example.com/news/some-article";

/**
 * Swap global.fetch for a fake for the duration of `fn`. `impl` receives the requested url and
 * returns the html string to serve (or throws / returns null to simulate a failed scrape).
 */
async function withFetch(
  impl: (url: string) => string | null | Promise<string | null>,
  fn: () => Promise<void>,
): Promise<void> {
  const real = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    const body = await impl(url);
    if (body === null) throw new Error("simulated network failure");
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    global.fetch = real;
  }
}

const OG_PAGE = `<!doctype html><html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="Real & Proper <Title>">
  <meta property="og:description" content="Tips & tricks <fast>">
  <meta property="og:image" content="/img/hero.png">
  <meta property="og:site_name" content="Example">
  <link rel="icon" href="/favicon-32.png">
</head><body>hi</body></html>`;

async function testEnvOverride(): Promise<void> {
  // Shared with emailLink via shortId; the module re-exports nothing, but the write target must
  // be the temp dir — proven transitively by every write test landing under TMP_DIR.
  const link = await withMint(ARTICLE_URL, OG_PAGE);
  assert.ok(fs.existsSync(path.join(TMP_DIR, idOf(link), "index.html")), "writes must land in temp dir");
}

async function withMint(url: string, html: string | null): Promise<string> {
  let link = "";
  await withFetch(() => html, async () => {
    link = await mod.mintLinkPreview(url);
  });
  return link;
}

async function testMintDeterminism(): Promise<void> {
  await withFetch(() => OG_PAGE, async () => {
    const a = await mod.mintLinkPreview(ARTICLE_URL);
    const b = await mod.mintLinkPreview(ARTICLE_URL);
    assert.equal(a, b, "same url must mint the same link twice (idempotent)");
    assert.ok(a.startsWith(`${mod.LINK_PREVIEW_BASE}/`), `link must be under ${mod.LINK_PREVIEW_BASE}`);
    assert.ok(!idOf(a).includes("/"), "link has no trailing slash / extra path");
  });
}

async function testScrapedOgWritten(): Promise<void> {
  const link = await withMint(ARTICLE_URL, OG_PAGE);
  const html = htmlFor(link);
  // og:title present and HTML-escaped (never raw &/</>/").
  assert.ok(html.includes("Real &amp; Proper &lt;Title&gt;"), "og:title must be scraped + escaped");
  assert.ok(!html.includes("Real & Proper <Title>"), "raw unescaped og:title must not survive");
  assert.ok(html.includes("Tips &amp; tricks &lt;fast&gt;"), "description must be scraped + escaped");
  // Relative og:image + favicon resolved to absolute against the target.
  assert.ok(html.includes("https://example.com/img/hero.png"), "relative og:image must be absolutized");
  assert.ok(html.includes('href="https://example.com/favicon-32.png"'), "relative favicon must be absolutized");
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'), "must set twitter card type");
  // og:url points at the WRAPPER, never the target: some preview fetchers treat og:url as
  // canonical and re-fetch it, which would walk them onto a bot-walled destination.
  assert.ok(html.includes(`content="https://${mod.LINK_PREVIEW_BASE}/`), "og:url must self-reference the wrapper");
  assert.ok(!html.includes(`property="og:url" content="${ARTICLE_URL}"`), "og:url must not be the target");
  // No meta-refresh, ever: WebKit-based preview fetchers HONOR it and bounce off the baked
  // card onto the target — the exact failure this wrapper exists to prevent.
  assert.ok(!html.includes('http-equiv="refresh"'), "must NOT contain a meta refresh");
  assert.ok(html.includes("location.replace"), "must contain a JS redirect to the target");
}

async function testFallbackWhenFetchFails(): Promise<void> {
  // Simulate a network failure — must STILL mint (not fall back to raw), with a minimal card.
  const link = await withMint("https://blocked.example.org/x", null);
  assert.ok(link.startsWith(`${mod.LINK_PREVIEW_BASE}/`), "failed scrape must still mint a wrapper");
  const html = htmlFor(link);
  assert.ok(html.includes("blocked.example.org"), "fallback card must title on the host");
  assert.ok(html.includes("https://blocked.example.org/favicon.ico"), "fallback favicon must be host/favicon.ico");
  assert.ok(html.includes("location.replace"), "fallback card must still redirect to the target");
}

async function testFallbackWhenNoOgData(): Promise<void> {
  // A page that loads fine but has no og tags + no <title> → still host-titled, never naked.
  const link = await withMint("https://bare.example.net/page", "<html><body>nothing here</body></html>");
  const html = htmlFor(link);
  assert.ok(html.includes("bare.example.net"), "no-og page must fall back to host title");
  assert.ok(html.includes("https://bare.example.net/favicon.ico"), "no-og page must use fallback favicon");
}

async function testReservedWordAvoidance(): Promise<void> {
  await withFetch(() => OG_PAGE, async () => {
    for (let i = 0; i < 500; i++) {
      const link = await mod.mintLinkPreview(`https://example.com/a/${i}`);
      assert.ok(
        !mod.LINK_PREVIEW_BASE.includes("/") && !RESERVED.has(idOf(link)),
        `minted id must never be a reserved word (got ${idOf(link)})`,
      );
    }
  });
}
const RESERVED = new Set(["doc", "paper", "x", "research", "ex", "assets", "index", "e"]);

async function testRawFallbackOnWriteFailure(): Promise<void> {
  // Block the id dir with a plain FILE so mkdir/writeFile throws → mint returns the raw url.
  const failing = "https://example.com/write-fails";
  const firstLink = await withMint(failing, OG_PAGE);
  const blockingPath = path.join(TMP_DIR, idOf(firstLink));
  fs.rmSync(blockingPath, { recursive: true, force: true });
  fs.writeFileSync(blockingPath, "not a directory", "utf8");
  try {
    const out = await withMint(failing, OG_PAGE);
    assert.equal(out, failing, "write failure must fall back to the raw url unchanged");
  } finally {
    fs.rmSync(blockingPath, { force: true });
  }
}

async function testRewriteReplacesBareUrl(): Promise<void> {
  await withFetch(() => OG_PAGE, async () => {
    const raw = `check this out: ${ARTICLE_URL}.`;
    const out = await mod.rewriteLinkPreviews(raw);
    const minted = await mod.mintLinkPreview(ARTICLE_URL);
    assert.ok(!out.includes("example.com/news"), "raw general url must be replaced");
    assert.ok(out.includes(minted), "must contain the minted open-url.cc wrapper");
    assert.ok(out.endsWith("."), "trailing punctuation must be preserved, not swallowed");
    assert.equal(out, `check this out: ${minted}.`);
  });
}

/**
 * A url ALONE on its own line is delivered as a native iMessage rich link, so it must stay
 * RAW — wrapping it would aim LinkPresentation at our redirect page instead of the real
 * site. Inline (mid-sentence) links can never be carded, so those still get the wrapper.
 */
async function testOwnLineUrlStaysRawForRichLink(): Promise<void> {
  await withFetch(() => OG_PAGE, async () => {
    const raw = `here's the thing\n\n${ARTICLE_URL}\n\nlet me know`;
    const out = await mod.rewriteLinkPreviews(raw);
    assert.equal(out, raw, "an own-line url must pass through untouched");

    // Same url mid-sentence still gets wrapped.
    const inline = await mod.rewriteLinkPreviews(`see ${ARTICLE_URL} for details`);
    assert.ok(!inline.includes(ARTICLE_URL), "inline url must still be wrapped");

    // Mixed: the own-line one survives raw, the inline one is replaced.
    const mixed = await mod.rewriteLinkPreviews(`see ${ARTICLE_URL} for details\n${ARTICLE_URL}`);
    assert.ok(mixed.endsWith(`\n${ARTICLE_URL}`), "own-line url must survive alongside an inline one");
  });
}

/** Which link-only bubbles become native rich-link cards, and which must stay plain. */
function testBareRichLinkUrl(): void {
  assert.equal(mod.bareRichLinkUrl(`  ${ARTICLE_URL}  `), ARTICLE_URL, "own-line url → rich link (trimmed)");
  assert.equal(mod.bareRichLinkUrl(`see ${ARTICLE_URL}`), null, "url with surrounding text is not a card");
  assert.equal(mod.bareRichLinkUrl("https://example.com/pic.jpg"), null, "image url → attachment, not a card");
  // A card attaches metadata to the SAME url, so the universal link still opens Maps —
  // unlike the open-url.cc wrapper, which swaps the tap target and is still skipped.
  assert.equal(
    mod.bareRichLinkUrl("https://maps.apple.com/?q=coffee"),
    "https://maps.apple.com/?q=coffee",
    "maps deep-link → native card",
  );
  assert.equal(mod.bareRichLinkUrl("https://open-email.cc/abc123"), null, "email link stays inline, no card");
  assert.equal(mod.bareRichLinkUrl("open-url.cc/abc123"), null, "scheme-less text is not a url");
  assert.equal(mod.bareRichLinkUrl("just some words"), null, "plain text is not a url");
}

async function testRewriteSkipList(): Promise<void> {
  await withFetch(() => OG_PAGE, async () => {
    const cases = [
      "https://example.com/pic.jpg", // image url → attachment, not a card
      "https://open-url.cc/abc123", // already ours
      "https://open-email.cc/abc123", // email wrapper
      "https://open-page.cc/doc/foo", // openpage doc
      "https://mail.google.com/mail/u/0/#inbox/x", // gmail → emailLink's job
      "https://maps.apple.com/?ll=37,-122", // apple maps deep link
    ];
    for (const url of cases) {
      assert.equal(mod.shouldWrapUrl(url), false, `must NOT wrap ${url}`);
      const out = await mod.rewriteLinkPreviews(`see ${url} here`);
      assert.equal(out, `see ${url} here`, `rewrite must leave ${url} untouched`);
    }
    assert.equal(mod.shouldWrapUrl(ARTICLE_URL), true, "a general web link must be wrapped");
  });
}

async function testChunkingLiftsWrapperOntoOwnBubble(): Promise<void> {
  // The scheme-less wrapper, alone on a line, must be lifted onto its own bubble so iMessage
  // renders the card — while open-email.cc / open-page.cc stay inline.
  const wrapper = `${mod.LINK_PREVIEW_BASE}/abc123`;
  const chunks = chunking.splitIntoChunks(`here's the piece\n${wrapper}\ngood read`);
  assert.ok(chunks.includes(wrapper), `wrapper must be its own bubble (got ${JSON.stringify(chunks)})`);
  // Email/page short links must NOT be lifted (kept inline).
  const inline = chunking.splitIntoChunks("thread\nopen-email.cc/xyz\nend");
  assert.ok(!inline.includes("open-email.cc/xyz"), "email short link must stay inline, not its own bubble");
}

async function main(): Promise<void> {
  mod = await import("./linkPreview");
  chunking = await import("./chunking");
  await testEnvOverride();
  await testMintDeterminism();
  await testScrapedOgWritten();
  await testFallbackWhenFetchFails();
  await testFallbackWhenNoOgData();
  await testReservedWordAvoidance();
  await testRawFallbackOnWriteFailure();
  await testRewriteReplacesBareUrl();
  await testOwnLineUrlStaysRawForRichLink();
  testBareRichLinkUrl();
  await testRewriteSkipList();
  await testChunkingLiftsWrapperOntoOwnBubble();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log("linkPreview tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
