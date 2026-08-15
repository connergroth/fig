import assert from "node:assert/strict";

import {
  approvalBody,
  approvalIdIn,
  APPROVAL_TIMEOUT_MS,
  clockTime,
  expiryNotice,
  lateDecisionNotice,
  matchExpired,
  nextApprovalId,
  noteExpired,
  resetApprovalPromptState,
} from "./approvalPrompt";

/**
 * The three ways the conversation around a 🔐 breaks, pinned. None of them is the gate's
 * verdict: a window too short to hit from a locked phone, a 👍 that lands late and is never
 * acknowledged, and byte-identical prompt bubbles with no way to tell which one is being
 * answered.
 */

let passed = 0;
function check(name: string, fn: () => void): void {
  resetApprovalPromptState();
  fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function main(): void {
  console.log("approval prompt UX");

  // --- bug 1: the window is iMessage-shaped, not terminal-shaped ------------

  check("the approval window is long enough for a phone in a pocket", () => {
    // A realistic round trip: notification, unlock, read, tap — three minutes is ordinary.
    // A window that doesn't cover it turns a real 👍 into a silent no-op.
    const LATE_THUMB_MS = 188_000;
    assert.ok(
      APPROVAL_TIMEOUT_MS > LATE_THUMB_MS,
      `window ${APPROVAL_TIMEOUT_MS}ms would still drop a 👍 that arrives at ${LATE_THUMB_MS}ms`,
    );
    assert.ok(APPROVAL_TIMEOUT_MS >= 10 * 60 * 1000, "10 min is the floor for an iMessage round trip");
  });

  // --- bug 3: stacked prompts have to be tellable apart ---------------------

  check("each prompt gets its own id", () => {
    const ids = new Set(Array.from({ length: 500 }, () => nextApprovalId()));
    assert.equal(ids.size, 500, `two prompts shared a tag — that IS the bug: ${ids.size}/500 unique`);
    for (const id of ids) assert.match(id, /^[0-9a-z]{3}$/);
  });

  check("the id LEADS the body, so a truncated tapback quote still carries it", () => {
    // iMessage quotes only the opening ~80 chars back to us in `[Reacted 👍 to "…"]`.
    // An id at the end of the bubble is invisible by the time their answer arrives.
    const body = approvalBody('Confirm browser action: "Send email button"?', "a3f");
    const quoted = body.slice(0, 80);
    assert.equal(approvalIdIn(quoted), "a3f", `id lost in the quote: ${quoted}`);
  });

  check("the body still reads like the old prompt — question first, one tapback target", () => {
    const body = approvalBody('Confirm browser action: "Place your order button"?', "b12");
    assert.ok(body.startsWith("🔐 #b12 · Confirm browser action:"), body);
    assert.ok(body.includes("👍 this to approve, 👎 to deny"), body);
    assert.ok(body.includes("expires"), "they should be able to see the clock, not guess at it");
    assert.ok(body.split("\n").length <= 3, `keep it phone-sized:\n${body}`);
  });

  check("three retries of the SAME action produce three distinguishable bubbles", () => {
    const q = 'Confirm browser action: ""Send email" button on GrubHub login-code page"?';
    const bodies = [approvalBody(q, nextApprovalId()), approvalBody(q, nextApprovalId()), approvalBody(q, nextApprovalId())];
    assert.equal(new Set(bodies).size, 3, "byte-identical bubbles are the bug");
  });

  check("an expired prompt is marked dead in the thread, and says the action did not run", () => {
    const notice = expiryNotice('Confirm browser action: "Send email button"?', "a3f");
    assert.ok(notice.includes("#a3f"), notice);
    assert.ok(/did NOT run/.test(notice), notice);
    assert.ok(/expired/i.test(notice), notice);
  });

  // --- bug 2: a late 👍 gets an answer instead of silence -------------------

  check("a late 👍 on an expired prompt is recognised from the tapback quote", () => {
    const question = 'Confirm browser action: "Send email button"?';
    const body = approvalBody(question, "a3f");
    noteExpired({ id: "a3f", question, expiredAt: Date.now() - 67_000 });

    // Exactly the shape iMessage delivers, truncated exactly the way it truncates.
    const tapback = `[Reacted 👍 to "${body.slice(0, 80)}"]`;
    const dead = matchExpired(tapback);
    assert.ok(dead, "the late 👍 wasn't matched to the prompt it was aimed at");
    assert.equal(dead.id, "a3f");

    const reply = lateDecisionNotice(dead, true);
    assert.ok(/expired/i.test(reply), reply);
    assert.ok(/did NOT run/.test(reply), reply);
    assert.ok(reply.includes(question), "tell them WHICH action, not just that one died");
  });

  check("a late 👎 is answered too — a denial that vanishes is the same silence", () => {
    noteExpired({ id: "c7c", question: "Confirm browser action: \"Place your order\"?", expiredAt: Date.now() });
    const reply = lateDecisionNotice(matchExpired("[Reacted 👎 to \"🔐 #c7c · Confirm\"]")!, false);
    assert.ok(reply.includes("👎"), reply);
    assert.ok(/did NOT run/.test(reply), reply);
  });

  check("an ordinary yes/no isn't hijacked — no id, no match", () => {
    noteExpired({ id: "a3f", question: "Confirm browser action: \"Send email button\"?", expiredAt: Date.now() });
    for (const text of ["yes", "go", "👍", "sure do it", "[Reacted 👍 to \"want me to re-run it?\"]"]) {
      assert.equal(matchExpired(text), null, `hijacked a normal message: ${text}`);
    }
  });

  check("an id we don't remember doesn't match anything", () => {
    noteExpired({ id: "a3f", question: "q", expiredAt: Date.now() });
    assert.equal(matchExpired("[Reacted 👍 to \"🔐 #zzz · Confirm\"]"), null);
  });

  check("stale prompts age out instead of accumulating forever", () => {
    noteExpired({ id: "old", question: "q", expiredAt: Date.now() - 3 * 60 * 60 * 1000 });
    assert.equal(matchExpired("[Reacted 👍 to \"🔐 #old · Confirm\"]"), null, "a 3h-old prompt is not still answerable");
  });

  check("clock time renders phone-terse", () => {
    assert.equal(clockTime(new Date("2026-07-29T02:41:00Z").getTime(), "America/Denver"), "8:41pm");
    assert.equal(clockTime(new Date("2026-07-29T06:05:00Z").getTime(), "America/Denver"), "12:05am");
  });

  // The failure this pins: the mini stays put, the owner spends months a timezone away, and the
  // 🔐's "expires …" prints the MACHINE's clock — an hour off from the phone they're holding.
  // The zone is a PARAMETER (defaulting to the Find-My-derived one) precisely so this can be
  // pinned without writing to the real location cache — a test that clobbers live state to
  // prove a point is its own bug.
  check("expiry renders in whatever timezone the owner is in, never the machine's", () => {
    const at = new Date("2026-07-30T02:24:00Z").getTime(); // 8:24pm MT / 7:24pm PT
    assert.equal(clockTime(at, "America/Denver"), "8:24pm", "at home it reads mountain time");
    assert.equal(clockTime(at, "America/Los_Angeles"), "7:24pm", "a zone away it follows THEM, not the box");
  });

  console.log(`\napproval prompt tests passed: ${passed}`);
}

main();
