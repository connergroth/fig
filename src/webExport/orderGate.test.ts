/**
 * The ordering-CLI money gate: what counts as `order place`, what gets FLAGGED, and what the
 * one text line says.
 *
 * These assertions are the point of the gate, not decoration. The "FIFTH bug" in
 * Pending/guardrail-gate.md was money moving with no 🔐 at all, and the shape of the fix is a
 * string match on a command — which is exactly the kind of thing that silently re-broadens or
 * silently stops matching when someone edits it. Each case below is a real invocation shape.
 */

import assert from "node:assert/strict";

import {
  orderCard,
  orderFlags,
  orderPlaceInvocation,
  orderQuestion,
  parseDescribeJson,
  type OrderExpectations,
  type OrderPreview,
} from "./orderGate";
import { renderApprovalCardHtml } from "../session/approvalCard";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok: ${name}`);
}

/** A typical pickup order, in the exact shape `order describe --json` prints. */
const NORMAL: OrderPreview = {
  cart_id: "aEF4wIsDEfG4wSnkYoGVwA",
  fulfillment: "PICKUP",
  restaurant: {
    id: "9900123",
    name: "Chipotle",
    address: "12 Example Ave, Springfield, IL 62704",
    logo: "https://media-cdn.grubhub.com/image/upload/v1/chipotle.png",
  },
  when: { local: "12:22pm", asap: true, estimate_minutes: { minimum: 10, maximum: 20 } },
  items: [
    {
      name: "Burrito Bowl",
      quantity: 1,
      total: 17.3,
      options: ["Chicken", "White Rice", "Black Beans", "Guacamole", "Fresh Tomato Salsa", "Cheese"],
    },
  ],
  charges: { subtotal: 17.3, fees: 0, tax: 1.34, tip: 0, total: 18.64 },
  card: { brand: "AMEX", last4: "1234" },
  validation_errors: [],
};

const EXP: OrderExpectations = {
  cardLast4: "1234",
  fulfillment: "PICKUP",
  merchants: {
    chipotle: { storeId: "9900123", storeLabel: "12 Example Ave", typicalTotal: 19.93, domain: "chipotle.com" },
  },
  ceiling: 75,
  driftFraction: 0.4,
};

function main(): void {
  // --- 1. what executes `order place` ------------------------------------------------------

  check("every real place-order invocation shape is caught", () => {
    const shapes = [
      "node src/cli.mjs order place --source=grubhub --cart=abc123",
      "cd ~/GitHub/web-export && node src/cli.mjs order place --cart=abc123 --source=grubhub",
      "node ~/GitHub/web-export/src/cli.mjs order place --source=grubhub --cart=abc123",
      "npm run order -- place --source=grubhub --cart=abc123",
      "npm run order place --cart=abc123",
      "npm --prefix ~/GitHub/web-export run order -- place --cart=abc123",
      "web-export order place --cart=abc123",
      "npx web-export order place --cart=abc123",
      "SESSION_JSON=/tmp/s.json node src/cli.mjs order place --cart=abc123",
      // Unrecognised leader: a wrapper/variable/shell function must fail CLOSED, not walk through.
      "$CLI order place --cart=abc123",
      "./place-lunch.sh && node src/cli.mjs order place --cart=abc123",
      // Reaching the same code without the CLI's argv shape at all.
      "node -e \"import('./src/order/runOrder.mjs').then(m => m.runOrder(['place','--cart=abc123']))\"",
      // Two segments: cart built in one, placed in the next.
      "CART=$(node src/cli.mjs order cart --store=9900123) && node src/cli.mjs order place --cart=$CART",
    ];
    for (const cmd of shapes) {
      assert.ok(orderPlaceInvocation(cmd), `MISSED the money door: ${cmd}`);
    }
  });

  check("the read-only verbs stay completely ungated", () => {
    const free = [
      "node src/cli.mjs order cart --source=grubhub --store=9900123 --item=@specs/chipotle-9900123-bowl.json",
      "node src/cli.mjs order describe --source=grubhub --cart=abc123",
      "node src/cli.mjs order describe --source=grubhub --cart=abc123 --json",
      "node src/cli.mjs order menu --source=grubhub --store=9900123 --item=2084073826",
      "node src/cli.mjs --source=x-bookmarks --max-pages=3",
      "npm test",
      "npm run order -- describe --cart=abc123",
      // `place` is not the verb here — runOrder reads argv[0], so this errors rather than buys.
      "node src/cli.mjs order describe --cart=placeholder-123",
      "node src/cli.mjs order cart --store=9900123 --item=@specs/place-setting.json",
    ];
    for (const cmd of free) {
      assert.equal(orderPlaceInvocation(cmd), null, `over-gated a read: ${cmd}`);
    }
  });

  check("reading or printing the words 'order place' is not placing an order", () => {
    const reads = [
      'grep -n "order place" ~/GitHub/web-export/README.md',
      "rg 'order place' src/",
      "cat Pending/web-export.md | head -40",
      "sed -n '1,20p' src/order/runOrder.mjs",
      "git log --oneline --grep='order place'",
      'echo "run: node src/cli.mjs order place --cart=X"',
      "wc -l src/order/runOrder.mjs",
    ];
    for (const cmd of reads) {
      assert.equal(orderPlaceInvocation(cmd), null, `over-gated a pure read: ${cmd}`);
    }
  });

  check("the invocation carries the cart id and source back out", () => {
    const inv = orderPlaceInvocation("cd ~/GitHub/web-export && node src/cli.mjs order place --source=grubhub --cart=aEF4wIsDEfG4wSnkYoGVwA");
    assert.equal(inv?.source, "grubhub");
    assert.equal(inv?.cart, "aEF4wIsDEfG4wSnkYoGVwA");
  });

  // --- 2. off-pattern flags ------------------------------------------------------------------

  check("the normal downtown pickup order raises no flags", () => {
    assert.deepEqual(orderFlags(NORMAL, EXP), []);
  });

  check("a wrong card, a wrong store, delivery, and a wild total each get flagged", () => {
    const wrongCard = orderFlags({ ...NORMAL, card: { brand: "VISA", last4: "4242" } }, EXP);
    assert.ok(wrongCard.some((f) => f.includes("1234")), wrongCard.join(" | "));

    const wrongStore = orderFlags(
      { ...NORMAL, restaurant: { ...NORMAL.restaurant, id: "6836520", address: "734 University Ave" } },
      EXP,
    );
    assert.ok(wrongStore.some((f) => f.includes("734 University Ave")), wrongStore.join(" | "));

    const delivery = orderFlags({ ...NORMAL, fulfillment: "DELIVERY" }, EXP);
    assert.ok(delivery.some((f) => f.includes("delivery")), delivery.join(" | "));

    const huge = orderFlags({ ...NORMAL, charges: { ...NORMAL.charges, total: 412.5 } }, EXP);
    assert.ok(huge.some((f) => f.includes("ceiling")), huge.join(" | "));

    const drift = orderFlags({ ...NORMAL, charges: { ...NORMAL.charges, total: 44.0 } }, EXP);
    assert.ok(drift.some((f) => f.includes("well off the usual")), drift.join(" | "));

    const noCard = orderFlags({ ...NORMAL, card: null }, EXP);
    assert.ok(noCard.some((f) => f.includes("no card")), noCard.join(" | "));

    const invalid = orderFlags({ ...NORMAL, validation_errors: [{ code: "CART_EXPIRED" }] }, EXP);
    assert.ok(invalid.some((f) => f.includes("validation errors")), invalid.join(" | "));
  });

  check("an unknown merchant has no anchor to be off, so it isn't flagged for it", () => {
    const flags = orderFlags(
      { ...NORMAL, restaurant: { id: "999", name: "Some Deli", address: "1 Main St", logo: null } },
      EXP,
    );
    assert.deepEqual(flags, []);
  });

  // --- 3. the text line, which is the safety surface ----------------------------------------

  check("the text line leads with store and TOTAL — the two facts a lock screen must show", () => {
    const q = orderQuestion(NORMAL, { segment: "", source: "grubhub", cart: "abc" }, []);
    assert.equal(q, "🛒 Chipotle · $18.64 · buy it?");
  });

  check("a flag is surfaced IN the text line, not hidden on the image", () => {
    const p = { ...NORMAL, card: { brand: "VISA", last4: "4242" } };
    const q = orderQuestion(p, { segment: "", source: "grubhub", cart: "abc" }, orderFlags(p, EXP));
    assert.ok(q.startsWith("⚠️ "), q);
    assert.ok(q.includes("$18.64"), q);
    assert.ok(q.includes("1234"), q);
  });

  check("an unreadable cart cannot produce an approval question", () => {
    assert.throws(
      () => orderQuestion(null, { segment: "", source: "grubhub", cart: "abc" }, ["unreadable"]),
      /refusing to offer a blind purchase approval/,
    );
  });

  // --- 4. the CLI's json, and the card built from it ----------------------------------------

  check("describe --json survives the transport chatter the CLI writes to stderr", () => {
    const out = `transport: in-page (CDP) — issuing from the logged-in tab\n${JSON.stringify(NORMAL)}\n`;
    const parsed = parseDescribeJson(out);
    assert.equal(parsed?.charges?.total, 18.64);
    assert.equal(parseDescribeJson("boom: NotCaptured"), null);
    assert.equal(parseDescribeJson(""), null);
  });

  check("the card model is built purely from the server read", () => {
    const card = orderCard("a3f", NORMAL, orderFlags(NORMAL, EXP), null, 1_753_000_000_000);
    assert.equal(card.id, "a3f");
    assert.equal(card.title, "Chipotle");
    assert.equal(card.total.value, "$18.64");
    assert.equal(card.lines.length, 1);
    assert.equal(card.lines[0]!.price, "$17.30");
    assert.ok(card.lines[0]!.detail?.includes("Guacamole"));
    assert.ok(card.status?.includes("Pickup ASAP"), card.status);
    assert.ok(card.status?.includes("12:22pm"), card.status);
    assert.equal(card.payment?.text, "AMEX ···· 1234");
    // Zero fees / zero tip are omitted rather than printed as $0.00 noise.
    assert.deepEqual(
      card.rows.map((r) => r.label),
      ["Subtotal", "Tax"],
    );
  });

  check("a cart with no readable total still renders a card, and says 'unknown'", () => {
    const card = orderCard("b7q", { ...NORMAL, charges: {} }, ["no total"], null);
    assert.equal(card.total.value, "unknown");
    const html = renderApprovalCardHtml(card);
    assert.ok(html.includes("unknown"));
  });

  console.log(`\norder gate tests passed: ${passed}`);
}

main();
