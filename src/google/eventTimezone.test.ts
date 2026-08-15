import assert from "node:assert/strict";

/**
 * Google returns an event's `dateTime` in the CALENDAR's timezone, which is not
 * necessarily the owner's. The real failure: the account timezone was left on
 * America/Los_Angeles after a summer away, so a Boulder class that actually meets at
 * 9:05am MT came back as `2026-08-24T08:05:00-07:00`. The instant was correct — the
 * offset says so — but a reader skims the digits and drops the offset, so "8:05am" got
 * reported, written into the semester plan, and used to justify a schedule change.
 *
 * The lesson generalizes past this one bug: an offset is not a safe place to keep the
 * truth, because it is the part that gets ignored. So every time is re-rendered into
 * the owner's CURRENT zone before it leaves the module, and the tool line spells the zone
 * out — the label being the part that actually catches this, since location-following alone
 * would still render a Boulder class as 8:05 while the owner is standing in California.
 *
 * What's locked down:
 *   1. A time in a foreign zone is converted, not passed through — the DIGITS move.
 *   2. The instant is preserved exactly (this is a re-render, never a shift).
 *   3. The zone label names the RENDER zone, not the calendar's.
 *   4. All-day events keep their bare date and never acquire a time.
 */

// AGENT_TZ pins the render zone; without it this follows the owner's live location.
process.env.AGENT_TZ = "America/Denver";

let failures = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

async function main(): Promise<void> {
  const { summarizeForTest, tzLabel } = await import("./calendar");

  check("a Pacific-rendered event is re-rendered into the owner's zone", () => {
    // The exact payload that caused the miss: ASTR 1010, really 9:05am MT.
    const e = summarizeForTest({
      summary: "ASTR 1010-100",
      start: { dateTime: "2026-08-24T08:05:00-07:00" },
      end: { dateTime: "2026-08-24T08:55:00-07:00" },
    });
    assert.equal(e.start, "2026-08-24T09:05:00-06:00");
    assert.equal(e.end, "2026-08-24T09:55:00-06:00");
    assert.ok(!e.start.includes("T08:05"), "the 8:05 digits must not survive the conversion");
  });

  check("the conversion preserves the instant exactly", () => {
    const raw = "2026-08-24T08:05:00-07:00";
    const e = summarizeForTest({ summary: "x", start: { dateTime: raw } });
    assert.equal(new Date(e.start).getTime(), new Date(raw).getTime());
  });

  check("a UTC-rendered event lands in the agent's zone too", () => {
    const e = summarizeForTest({ summary: "x", start: { dateTime: "2026-08-24T15:05:00Z" } });
    assert.equal(e.start, "2026-08-24T09:05:00-06:00");
  });

  check("a conversion that crosses midnight moves the DATE, not just the clock", () => {
    // 00:30 Pacific is still the previous evening in Denver... no — it is 01:30 the same
    // day. The real crossing case is the other direction: late Denver evening in UTC.
    const e = summarizeForTest({ summary: "x", start: { dateTime: "2026-08-25T02:30:00Z" } });
    assert.equal(e.start, "2026-08-24T20:30:00-06:00");
  });

  check("the zone label names the render zone, not the calendar's", () => {
    assert.equal(tzLabel("2026-08-24T08:05:00-07:00"), "MDT");
    // Standard time, to prove the label is computed per-instant rather than hardcoded.
    assert.equal(tzLabel("2026-12-24T08:05:00-08:00"), "MST");
  });

  check("an all-day event keeps its bare date and gains no time", () => {
    const e = summarizeForTest({ summary: "Move-out day", start: { date: "2026-08-09" } });
    assert.equal(e.start, "2026-08-09");
    assert.equal(e.allDay, true);
  });

  check("an unparseable dateTime passes through rather than throwing", () => {
    const e = summarizeForTest({ summary: "x", start: { dateTime: "not-a-date" } });
    assert.equal(e.start, "not-a-date");
  });

  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

void main();
