/**
 * The rendered approval card: the layout rules the design turns on, pinned so a later
 * "make it prettier" pass can't quietly break the reason it exists.
 *
 * The rules under test:
 *   - the TOTAL is the largest element on the card (pretty must not train approval-on-vibes)
 *   - off-pattern facts are FLAGGED and visually separated, never blended in
 *   - the brand mark degrades API logo → favicon → emoji, and a missing one never blocks
 *   - the card carries the 🔐's `#id`, so two stacked cards are tellable apart as images
 *
 * The final case actually drives headless Chrome. It self-skips when Chrome/Playwright isn't
 * available, because the whole module is best-effort by design and a machine without a browser
 * should still pass the suite — it just sends text 🔐s.
 */

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";

import { esc, faviconUrl, renderApprovalCardHtml, renderApprovalCardImage, type ApprovalCard } from "./approvalCard";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

const CARD: ApprovalCard = {
  id: "a3f",
  title: "Chipotle",
  subtitle: "12 Example Ave, Springfield, IL 62704",
  logoDataUri: null,
  logoEmoji: "🛒",
  lines: [
    {
      name: "Burrito Bowl",
      detail: "Chicken · White Rice · Black Beans · Guacamole · Fresh Tomato Salsa · Cheese",
      price: "$17.30",
    },
  ],
  status: "Pickup ASAP · ready ~12:22pm (10-20 min)",
  rows: [
    { label: "Subtotal", value: "$17.30" },
    { label: "Tax", value: "$1.34" },
  ],
  total: { label: "Total", value: "$18.64" },
  payment: { badge: "AMEX", text: "AMEX ···· 1234" },
  flags: [],
  at: Date.parse("2026-07-29T19:22:00Z"),
};

/** The px size of the CSS rule that styles a selector's font, for the "biggest element" check. */
function fontSizeOf(html: string, selector: string): number {
  const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(html);
  assert.ok(block, `no CSS rule for ${selector}`);
  const size = /font-size:\s*([\d.]+)px/.exec(block![1]!);
  assert.ok(size, `no font-size on ${selector}`);
  return Number(size![1]);
}

async function main(): Promise<void> {
  await check("the TOTAL is the largest thing on the card", async () => {
    const html = renderApprovalCardHtml(CARD);
    const total = fontSizeOf(html, ".row.total .r");
    for (const other of [".head .store", ".item .name", ".item .price", ".row", ".status", ".pay", ".flag"]) {
      assert.ok(
        total > fontSizeOf(html, other),
        `${other} (${fontSizeOf(html, other)}px) is not smaller than the total (${total}px)`,
      );
    }
  });

  await check("the total value is always printed, even when it's unknown", async () => {
    const html = renderApprovalCardHtml({ ...CARD, total: { label: "Total", value: "unknown" } });
    assert.ok(/class="r">unknown</.test(html), html.slice(0, 200));
  });

  await check("the #id and the clock ride on the card, so stacked cards are tellable apart", async () => {
    const a = renderApprovalCardHtml(CARD);
    const b = renderApprovalCardHtml({ ...CARD, id: "b7q" });
    assert.ok(a.includes("#a3f"), "card is missing its own 🔐 id");
    assert.ok(b.includes("#b7q"));
    assert.ok(!b.includes("#a3f"), "two cards must not claim the same prompt");
    // The tag block is `<b>#a3f</b>8:41pm` — the clock is what dates a card sitting in scrollback.
    assert.ok(/<b>#a3f<\/b>\d{1,2}:\d{2}(?:am|pm)/.test(a), "card should date itself for scrollback");
  });

  await check("flags render as their own loud block, never blended into the body", async () => {
    const plain = renderApprovalCardHtml(CARD);
    assert.ok(!plain.includes('class="flags"'), "a clean order must have no warning block at all");

    const flagged = renderApprovalCardHtml({
      ...CARD,
      flags: ["paying with VISA …4242, not the usual …1234", "not the usual 12 Example Ave store"],
    });
    assert.ok(flagged.includes('class="flags"'));
    assert.ok(flagged.includes("2 things to check"));
    assert.ok(flagged.includes("VISA"));
    assert.ok(flagged.includes("12 Example Ave store"));
    // The flags block sits ABOVE the totals, so it can't be missed while reading to the number.
    assert.ok(
      flagged.indexOf('class="flags"') < flagged.indexOf('class="totals"'),
      "flags must come before the totals",
    );
  });

  await check("the brand mark degrades to the emoji, and an API logo is used when present", async () => {
    const emoji = renderApprovalCardHtml(CARD);
    assert.ok(emoji.includes('class="icon icon-emoji">🛒'), "missing emoji fallback");
    assert.ok(!emoji.includes("<img class=\"icon\""));

    const withLogo = renderApprovalCardHtml({ ...CARD, logoDataUri: "data:image/png;base64,AAAA" });
    assert.ok(withLogo.includes('<img class="icon" src="data:image/png;base64,AAAA"'));
  });

  await check("the favicon step only fires on a real domain", async () => {
    assert.equal(faviconUrl("chipotle.com"), "https://www.google.com/s2/favicons?domain=chipotle.com&sz=128");
    assert.equal(faviconUrl("https://chipotle.com/order"), "https://www.google.com/s2/favicons?domain=chipotle.com&sz=128");
    for (const bad of [null, undefined, "", "Chipotle", "not a domain", "localhost"]) {
      assert.equal(faviconUrl(bad), null, `should not build a favicon url from ${JSON.stringify(bad)}`);
    }
  });

  await check("everything interpolated is escaped — the card renders untrusted API text", async () => {
    assert.equal(esc(`<b>"x"&'y'`), "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;");
    const html = renderApprovalCardHtml({
      ...CARD,
      title: '<script>alert(1)</script>',
      lines: [{ name: '"><img onerror=1>', detail: "a & b", price: "$1.00" }],
      flags: ["</style><script>x</script>"],
    });
    assert.ok(!html.includes("<script>"), "script tag survived escaping");
    assert.ok(!html.includes("<img onerror"), "attribute break survived escaping");
    assert.ok(html.includes("&lt;script&gt;"));
  });

  await check("no card can exist without a total (compile-time, asserted here for the record)", async () => {
    // `total` is required on ApprovalCard, so this is a type-level guarantee rather than a
    // runtime branch. The assertion documents the intent for whoever reads the test file.
    const keys = Object.keys(CARD);
    assert.ok(keys.includes("total"));
    assert.ok(renderApprovalCardHtml(CARD).includes("$18.64"));
  });

  await check("headless Chrome actually produces a PNG (skips if there's no browser)", async () => {
    const out = await renderApprovalCardImage({ ...CARD, id: "tst", flags: ["render smoke test"] });
    if (!out) {
      console.log("     (skipped: no usable headless Chrome/Playwright on this machine — 🔐s degrade to text)");
      return;
    }
    assert.ok(existsSync(out), `render claimed ${out} but nothing is there`);
    assert.ok(statSync(out).size > 1000, `suspiciously small card png: ${statSync(out).size}B`);
    assert.ok(out.includes("tst"), `card path should name its prompt: ${out}`);
  });

  console.log(`\napproval card tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
