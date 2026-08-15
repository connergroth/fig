import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the minter at a throwaway dir BEFORE importing the module (OPENPAGE_PUBLIC_DIR is
// read at module load), so tests never write into the real openpage public dir.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "emaillink-test-"));
process.env.OPENPAGE_PUBLIC_DIR = TMP_DIR;

// Imported lazily inside main() (after the env override above) so the module reads
// OPENPAGE_PUBLIC_DIR from the temp dir at load time — never the real openpage dir.
type EmailLinkModule = typeof import("./emailLink");
let mod: EmailLinkModule;
const idOf = (link: string): string => link.slice(mod.EMAIL_LINK_BASE.length + 1);

const GMAIL_URL = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQbtPqXnabc123";
const MESSAGE_URL = "message://%3Cschool-message-id%40colorado.edu%3E";
const withPrefix = (link: string): string => `✉️ ${link}`;

async function testEnvOverride(): Promise<void> {
  assert.equal(mod.OPENPAGE_PUBLIC_DIR, TMP_DIR, "env override must redirect writes to temp dir");
}

async function testMintDeterminism(): Promise<void> {
  const a = await mod.mintEmailLink(GMAIL_URL);
  const b = await mod.mintEmailLink(GMAIL_URL);
  assert.equal(a, b, "same url must mint the same link twice (idempotent)");
  assert.ok(a.startsWith(`${mod.EMAIL_LINK_BASE}/`), `link must be under ${mod.EMAIL_LINK_BASE}`);
  assert.ok(!idOf(a).includes("/"), "link has no trailing slash / extra path");
}

async function testWritesEscapedTarget(): Promise<void> {
  // A url with characters that MUST be escaped inside the href attribute.
  const tricky = 'https://mail.google.com/mail/u/0/#search/from:"a&b"/x<y>';
  const link = await mod.mintEmailLink(tricky);
  const html = fs.readFileSync(path.join(TMP_DIR, idOf(link), "index.html"), "utf8");
  assert.ok(html.includes("&amp;"), "& must be html-escaped in the written page");
  assert.ok(html.includes("&lt;") && html.includes("&gt;"), "< and > must be escaped");
  assert.ok(html.includes("&quot;"), '" must be escaped in the href attribute');
  assert.ok(!html.includes('"a&b"'), "raw unescaped quotes must not survive into the html");
  assert.ok(html.includes('http-equiv="refresh"'), "must contain a meta refresh");
  assert.ok(html.includes("location.replace"), "must contain a JS redirect");
}

async function testReservedWordAvoidance(): Promise<void> {
  assert.ok(mod.RESERVED_IDS.has("doc") && mod.RESERVED_IDS.has("e"), "reserved set populated");
  for (let i = 0; i < 500; i++) {
    const link = await mod.mintEmailLink(`https://mail.google.com/mail/u/0/#inbox/id${i}`);
    assert.ok(!mod.RESERVED_IDS.has(idOf(link)), `minted id must never be a reserved word (got ${idOf(link)})`);
  }
}

async function testRewriteToken(): Promise<void> {
  const raw = `here's that thread [[email:${GMAIL_URL}]] take a look`;
  const out = await mod.rewriteEmailLinks(raw);
  const minted = await mod.mintEmailLink(GMAIL_URL);
  assert.ok(!out.includes("[[email:"), "token must be removed");
  assert.equal(out, `here's that thread ${withPrefix(minted)} take a look`);
}

async function testRewriteBareGmail(): Promise<void> {
  const raw = `pulled it up: ${GMAIL_URL}.`;
  const out = await mod.rewriteEmailLinks(raw);
  const minted = await mod.mintEmailLink(GMAIL_URL);
  assert.ok(!out.includes("mail.google.com"), "raw gmail url must be gone");
  assert.ok(out.endsWith("."), "trailing punctuation must be preserved, not swallowed");
  assert.equal(out, `pulled it up: ${withPrefix(minted)}.`);
  const html = fs.readFileSync(path.join(TMP_DIR, idOf(minted), "index.html"), "utf8");
  assert.ok(html.includes('http-equiv="refresh"'), "gmail redirect must keep meta refresh behavior");
  assert.ok(html.includes("location.replace"), "gmail redirect must keep JS redirect behavior");
}

async function testRewriteBareMessageLink(): Promise<void> {
  const raw = `school thing: ${MESSAGE_URL}.`;
  const out = await mod.rewriteEmailLinks(raw);
  const minted = await mod.mintEmailLink(MESSAGE_URL);
  assert.ok(!out.includes("message://"), "raw message url must be gone from rewritten text");
  assert.ok(out.endsWith("."), "trailing punctuation must be preserved, not swallowed");
  assert.equal(out, `school thing: ${withPrefix(minted)}.`);
}

async function testMessageRedirectPageUsesTapButton(): Promise<void> {
  const link = await mod.mintEmailLink(MESSAGE_URL);
  const html = fs.readFileSync(path.join(TMP_DIR, idOf(link), "index.html"), "utf8");
  assert.ok(html.includes("Open in Mail"), "message redirect must show a clear tap button");
  assert.ok(html.includes("opening your email in Mail"), "message redirect must explain what is opening");
  assert.ok(html.includes(`href="${MESSAGE_URL}"`), "message redirect button must target Mail.app URL");
  assert.ok(html.includes("setTimeout"), "message redirect may attempt a deferred best-effort open");
  assert.ok(html.includes("location.href"), "message redirect should use deferred location.href");
  assert.ok(!html.includes('http-equiv="refresh"'), "message redirect must not use eager meta refresh");
  assert.ok(!html.includes("location.replace"), "message redirect must not use eager JS replace");
}

async function testMessageInsideTokenNotDoubleMatched(): Promise<void> {
  const raw = `open 📧 [[email:${MESSAGE_URL}]] now`;
  const out = await mod.rewriteEmailLinks(raw);
  const minted = await mod.mintEmailLink(MESSAGE_URL);
  assert.equal(out, `open ${withPrefix(minted)} now`);
  assert.equal(out.match(/open-email\.cc/g)?.length, 1, "token-contained message url must mint once");
}

async function testEmailEmojiPrefixDedupes(): Promise<void> {
  const raw = `school: 📧   ${MESSAGE_URL}\ngmail: ✉️ ${GMAIL_URL}`;
  const out = await mod.rewriteEmailLinks(raw);
  const messageMinted = await mod.mintEmailLink(MESSAGE_URL);
  const gmailMinted = await mod.mintEmailLink(GMAIL_URL);
  assert.equal(out, `school: ${withPrefix(messageMinted)}\ngmail: ${withPrefix(gmailMinted)}`);
  assert.ok(!out.includes("📧 ✉️"), "preceding email emoji must collapse into the deterministic prefix");
  assert.ok(!out.includes("✉️ ✉️"), "preceding envelope emoji must not double the prefix");
}

async function testRawFallbackHasNoPrefix(): Promise<void> {
  const failingUrl = "https://mail.google.com/mail/u/0/#inbox/fallback-write-fails";
  const firstMint = await mod.mintEmailLink(failingUrl);
  const blockingPath = path.join(TMP_DIR, idOf(firstMint));
  fs.rmSync(blockingPath, { recursive: true, force: true });
  fs.writeFileSync(blockingPath, "not a directory", "utf8");
  try {
    const out = await mod.rewriteEmailLinks(`fallback: ${failingUrl}`);
    assert.equal(out, `fallback: ${failingUrl}`, "write failure must fall back to raw url");
    assert.ok(!out.includes("✉️"), "raw fallback must not get the minted-link prefix");
  } finally {
    fs.rmSync(blockingPath, { force: true });
  }
}

async function testLeavesOthersUntouched(): Promise<void> {
  const other = "check https://example.com/foo and https://open-page.cc/doc/abc plus open-email.cc/abc123";
  const out = await mod.rewriteEmailLinks(other);
  assert.equal(out, other, "non-gmail / open-page / existing open-email urls must be untouched");
}

async function main(): Promise<void> {
  mod = await import("./emailLink");
  await testEnvOverride();
  await testMintDeterminism();
  await testWritesEscapedTarget();
  await testReservedWordAvoidance();
  await testRewriteToken();
  await testRewriteBareGmail();
  await testRewriteBareMessageLink();
  await testMessageRedirectPageUsesTapButton();
  await testMessageInsideTokenNotDoubleMatched();
  await testEmailEmojiPrefixDedupes();
  await testRawFallbackHasNoPrefix();
  await testLeavesOthersUntouched();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log("emailLink tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
