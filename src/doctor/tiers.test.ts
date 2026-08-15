import assert from "node:assert/strict";

import { type TierReport, evaluate, formatText, toJson } from "./tiers";

const ok = (name: string) => ({ name, ok: true });
const bad = (name: string, hint?: string) => ({ name, ok: false, hint });

function reports(fail: Record<number, ReturnType<typeof bad>[]> = {}): TierReport[] {
  return [0, 1, 2, 3].map((tier) => ({
    tier,
    label: `tier-${tier}`,
    checks: [ok(`t${tier}-a`), ok(`t${tier}-b`), ...(fail[tier] ?? [])],
  }));
}

// Everything green ⇒ top tier, nothing to reach.
{
  const v = evaluate(reports());
  assert.equal(v.tier, 3);
  assert.equal(v.next, null);
  assert.deepEqual(v.missing, []);
  const text = formatText(reports(), v);
  assert.ok(text.includes("you are at tier 3"));
  assert.ok(!text.includes("to reach"));
}

// Bare machine: tier 0 fails ⇒ tier -1, and the to-do list is tier 0's failures only.
{
  const r = reports({ 0: [bad("imsg CLI", "brew install steipete/tap/imsg")] });
  const v = evaluate(r);
  assert.equal(v.tier, -1);
  assert.equal(v.next?.tier, 0);
  assert.deepEqual(v.missing.map((c) => c.name), ["imsg CLI"]);
  const text = formatText(r, v);
  assert.ok(text.includes("you are not at tier 0 yet"));
  assert.ok(text.includes("to reach tier 0: imsg CLI (brew install steipete/tap/imsg)"));
}

// Only failing checks land in the missing list — passing ones never re-appear as to-dos.
{
  const r = reports({ 2: [bad("find-my dylib", "point FINDMY_DYLIB at it")] });
  const v = evaluate(r);
  assert.equal(v.tier, 1);
  assert.equal(v.next?.tier, 2);
  assert.deepEqual(v.missing.map((c) => c.name), ["find-my dylib"]);
}

// Tiers are cumulative: a green tier 2+3 can't skip a broken tier 1 — rich imsg and
// find-my ride the same injection, so "at tier 2 with a dead bridge" would be a lie.
{
  const v = evaluate(reports({ 1: [bad("SIP disabled")] }));
  assert.equal(v.tier, 0);
  assert.equal(v.next?.tier, 1);
  assert.deepEqual(v.missing.map((c) => c.name), ["SIP disabled"]);
}

// Evaluation is order-independent — collect() builds in order today, but nothing
// downstream should depend on that.
{
  const shuffled = reports({ 3: [bad("call binaries")] }).reverse();
  const v = evaluate(shuffled);
  assert.equal(v.tier, 2);
  assert.deepEqual(v.missing.map((c) => c.name), ["call binaries"]);
}

// Rendering: ✓/✗ per check, hint arrow only under failures, detail inline.
{
  const r: TierReport[] = [
    {
      tier: 0,
      label: "plain iMessage",
      checks: [
        { name: "imsg CLI", ok: true, detail: "imsg 0.13.5" },
        { name: "Full Disk Access", ok: false, detail: "chat.db unreadable (EPERM)", hint: "grant FDA" },
      ],
    },
  ];
  const text = formatText(r, evaluate(r));
  assert.ok(text.includes("✓ imsg CLI — imsg 0.13.5"));
  assert.ok(text.includes("✗ Full Disk Access — chat.db unreadable (EPERM)"));
  assert.ok(text.includes("→ grant FDA"));
}

// --json shape: verdict tier, next-tier to-do, tiers sorted ascending.
{
  const r = reports({ 1: [bad("bridge dylib", "set IMSG_DYLIB")] });
  const j = JSON.parse(toJson(r.reverse(), evaluate(r)));
  assert.equal(j.tier, 0);
  assert.equal(j.toReachNext.tier, 1);
  assert.deepEqual(j.toReachNext.missing.map((c: { name: string }) => c.name), ["bridge dylib"]);
  assert.deepEqual(j.tiers.map((t: { tier: number }) => t.tier), [0, 1, 2, 3]);
}

console.log("doctor tiers: all checks passed");
