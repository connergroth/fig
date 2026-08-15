import assert from "node:assert/strict";

/**
 * The 🔐 approval prompt for `calendar__delete` used to ask "Delete calendar event
 * dfv2p20gupa2idftt2iiskde10?" — a question the owner cannot actually answer, because
 * nothing in it says WHAT is about to be deleted. `eventLabel` is the fix: the gate
 * resolves the id to a title and a time before asking.
 *
 * What's worth locking down:
 *   1. A timed event renders its title AND when it is. That's the whole point.
 *   2. An all-day event does NOT slip to the previous day. Google gives all-day events a
 *      bare `date` (YYYY-MM-DD); `new Date("2026-08-09")` is UTC midnight, which is Aug 8
 *      evening anywhere west of Greenwich — so an approval prompt would name the wrong day
 *      on a deletion. The noon anchor is what prevents that, and it is invisible unless
 *      tested.
 *   3. A malformed or missing start still produces a usable question rather than throwing.
 *      The gate must degrade, never block: a formatter crash inside a permission check
 *      would take out the ask itself.
 */

// CAL_TZ is read once at module load, so the zone has to be set before the import.
process.env.AGENT_TZ = "America/Los_Angeles";

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
  const { eventLabel } = await import("./calendar");

  check("a timed event names itself and when it is", () => {
    const label = eventLabel({
      summary: "Flight to Denver (WN 3415)",
      start: { dateTime: "2026-08-09T11:00:00-07:00" },
    });
    assert.equal(label, '"Flight to Denver (WN 3415)" · Sun, Aug 9, 11:00 AM');
  });

  check("an all-day event keeps its own day instead of sliding back one", () => {
    // The bug this guards: UTC-midnight parsing renders Aug 9 as "Sat Aug 8" in Pacific.
    const label = eventLabel({ summary: "Move-out day", start: { date: "2026-08-09" } });
    assert.equal(label, '"Move-out day" · Sun, Aug 9 (all day)');
    assert.ok(!label.includes("Aug 8"), "an all-day event must not name the previous day");
  });

  check("an untitled event still asks a human question", () => {
    assert.equal(eventLabel({ start: { dateTime: "2026-08-09T11:00:00-07:00" } }), '"(untitled)" · Sun, Aug 9, 11:00 AM');
  });

  check("a missing start degrades to the title rather than throwing", () => {
    assert.equal(eventLabel({ summary: "Dentist" }), '"Dentist"');
  });

  check("an unparseable start degrades to the title rather than throwing", () => {
    assert.equal(eventLabel({ summary: "Dentist", start: { dateTime: "not-a-date" } }), '"Dentist"');
  });

  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

void main();
