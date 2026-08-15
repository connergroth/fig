import assert from "node:assert/strict";

/**
 * Regression tests for the 2026-07-29 VERIFIED calendar defect: every event lookup only
 * ever called `events.list` with calendarId "primary", so all secondary calendars were
 * invisible — including "Meetings", where every 1:1, coffee chat and hearing lives. Asked
 * what was on the next day, the tool answered "completely free, empty across all connected
 * accounts" while an honor-code hearing sat on Meetings. A confident empty result.
 *
 * What's actually worth locking down:
 *   1. An event that ONLY exists on a secondary calendar must come back. That's the bug.
 *      Both when searching every account and when scoped to one (same blindness, one layer
 *      down — the account-scoped path used to go straight to "primary" too).
 *   2. One real event that's mirrored onto two calendars comes back ONCE, and the surviving
 *      copy is the one whose calendarId/account the agent can act on.
 *   3. Dedupe must not over-collapse. Recurring instances can share an iCalUID, so start
 *      time is part of the key — collapsing a weekly 1:1 to one instance would be a NEW
 *      false negative, which is the exact class of bug being fixed.
 *   4. Failure is per calendar, never global. One 403 must not empty the search, and a
 *      calendarList failure must degrade to "primary" rather than returning nothing.
 *   5. Bounded fan-out. ~10 calendars × N accounts must not become a burst of parallel
 *      requests on every single lookup.
 *   6. Poller watch scope is narrower than search scope on purpose, and its old
 *      one-token-per-account state migrates instead of re-priming.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

// The owner's real shape: personal calendar + the Meetings calendar the search couldn't see,
// plus the Google-generated feeds and a subscribed read-only one.
const MEETINGS_ID = "b80263ed68187138a8144cee5129833d5d85636c2380f1e85ebf3d503526c1a0@group.calendar.google.com";
const CALS = {
  primary: { id: "owner@example.com", summary: "owner@example.com", primary: true, accessRole: "owner" },
  meetings: { id: MEETINGS_ID, summary: "Meetings", primary: false, accessRole: "owner" },
  shared: { id: "team@example.com", summary: "Team (subscribed)", primary: false, accessRole: "reader" },
  holidays: { id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays in United States", primary: false, accessRole: "reader" },
  birthdays: { id: "addressbook#contacts@group.v.calendar.google.com", summary: "Birthdays", primary: false, accessRole: "reader" },
  weeknum: { id: "e_2_en#weeknum@group.v.calendar.google.com", summary: "Week Numbers", primary: false, accessRole: "reader" },
  removed: { id: "old@group.calendar.google.com", summary: "Old", primary: false, accessRole: "owner", deleted: true },
};

interface FakeEvent {
  id: string;
  calendarId: string;
  account: string;
  start: string;
  summary: string;
  iCalUID?: string;
  primaryCalendar?: boolean;
}

function ev(over: Partial<FakeEvent> & { id: string; start: string }): FakeEvent {
  return {
    calendarId: "primary",
    account: "personal",
    summary: over.summary ?? over.id,
    primaryCalendar: over.calendarId === undefined || over.calendarId === "primary",
    ...over,
  };
}

async function main(): Promise<void> {
  const {
    CAL_FANOUT_CONCURRENCY,
    dedupeEvents,
    dedupeKeyFor,
    fanoutSearch,
    isNoiseCalendar,
    mergeEvents,
    searchTargets,
    watchTargets,
  } = await import("./calendarFanout");

  console.log("calendar fan-out: which calendars get queried");

  await check("every real calendar is queried, primary first", () => {
    const targets = searchTargets([CALS.shared, CALS.meetings, CALS.primary]);
    assert.deepEqual(
      targets.map((t) => t.id),
      [CALS.primary.id, CALS.shared.id, CALS.meetings.id],
      "primary must be first (its copy wins dedupe); the rest keep enumeration order",
    );
  });

  await check("the Meetings calendar is never dropped", () => {
    const ids = searchTargets(Object.values(CALS)).map((t) => t.id);
    assert.ok(ids.includes(MEETINGS_ID), "this is the calendar the whole bug was about");
  });

  await check("only Google's own generated feeds are excluded, by exact id suffix", () => {
    const ids = searchTargets(Object.values(CALS)).map((t) => t.id);
    for (const noisy of [CALS.holidays, CALS.birthdays, CALS.weeknum]) {
      assert.ok(!ids.includes(noisy.id), `${noisy.summary} should not be searched`);
      assert.equal(isNoiseCalendar(noisy.id), true);
    }
    assert.ok(ids.includes(CALS.shared.id), "a subscribed calendar is real; a false negative is the bug");
    assert.equal(isNoiseCalendar(MEETINGS_ID), false, "a user calendar must never match the noise rule");
    assert.equal(isNoiseCalendar("holiday@group.calendar.google.com"), false, "match the suffix, not the word");
  });

  await check("a removed calendarList entry is skipped", () => {
    const ids = searchTargets([CALS.primary, CALS.removed]).map((t) => t.id);
    assert.deepEqual(ids, [CALS.primary.id]);
  });

  await check("an empty calendar list degrades to the primary alias, never to nothing", () => {
    // Enumeration failing must not turn into "you have no calendars, so you're free".
    assert.deepEqual(searchTargets([]), [{ id: "primary", primary: true, summary: "primary" }]);
    assert.deepEqual(searchTargets([CALS.holidays]).map((t) => t.id), ["primary"]);
  });

  console.log("calendar fan-out: the search (the actual defect)");

  /** Fan out over two accounts, with events only where the fake says they are. */
  async function search(
    byCalendar: Record<string, FakeEvent[]>,
    opts: {
      calendars?: Record<string, typeof CALS.primary[]>;
      accounts?: string[];
      max?: number;
      fail?: (account: string, calendarId: string) => boolean;
      listFail?: (account: string) => boolean;
      concurrency?: number;
    } = {},
  ) {
    const errors: { account: string; calendarId?: string }[] = [];
    const asked: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const events = await fanoutSearch<FakeEvent>({
      accounts: opts.accounts ?? ["personal", "school"],
      max: opts.max,
      concurrency: opts.concurrency,
      calendarsFor: async (account) => {
        if (opts.listFail?.(account)) throw new Error("403 calendarList");
        return (opts.calendars?.[account] as any) ?? [CALS.primary, CALS.meetings];
      },
      fetchEvents: async ({ account, calendar }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 5));
          asked.push(`${account}/${calendar.id}`);
          if (opts.fail?.(account, calendar.id)) throw new Error("403 forbidden");
          return (byCalendar[`${account}/${calendar.id}`] ?? []).map((e) => ({
            ...e,
            account,
            calendarId: calendar.id,
            primaryCalendar: calendar.primary,
          }));
        } finally {
          inFlight -= 1;
        }
      },
      onError: (ctx) => errors.push(ctx),
    });
    return { events, errors, asked, peak };
  }

  await check("an event that ONLY exists on a secondary calendar is found", async () => {
    const hearing = ev({ id: "sccr1", start: "2026-07-30T12:45:00-07:00", summary: "SCCR honor code hearing" });
    const { events, asked } = await search({ [`personal/${MEETINGS_ID}`]: [hearing] });
    assert.equal(events.length, 1, 'this is the "tomorrow is completely free" answer — it must not be empty');
    assert.equal(events[0].summary, "SCCR honor code hearing");
    assert.equal(events[0].calendarId, MEETINGS_ID, "the calendar it came from must survive, or get/delete can't reach it");
    assert.equal(events[0].primaryCalendar, false);
    assert.ok(asked.includes(`personal/${MEETINGS_ID}`), "the Meetings calendar was actually queried");
    assert.ok(asked.includes("school/" + MEETINGS_ID) || asked.some((a) => a.startsWith("school/")), "other accounts too");
  });

  await check("scoping to ONE account still spans that account's calendars", async () => {
    const hearing = ev({ id: "sccr1", start: "2026-07-30T12:45:00-07:00", summary: "SCCR honor code hearing" });
    const { events, asked } = await search({ [`personal/${MEETINGS_ID}`]: [hearing] }, { accounts: ["personal"] });
    assert.equal(events.length, 1, "the account-scoped path had the same primary-only blindness");
    assert.deepEqual(asked.sort(), [`personal/${CALS.primary.id}`, `personal/${MEETINGS_ID}`].sort());
  });

  await check("results from all calendars merge in start order, and max applies after merge", async () => {
    const { events } = await search(
      {
        [`personal/${CALS.primary.id}`]: [ev({ id: "b", start: "2026-07-30T15:00:00-07:00" })],
        [`personal/${MEETINGS_ID}`]: [
          ev({ id: "a", start: "2026-07-30T09:00:00-07:00" }),
          ev({ id: "c", start: "2026-07-30T18:00:00-07:00" }),
        ],
      },
      { max: 2 },
    );
    assert.deepEqual(events.map((e) => e.id), ["a", "b"], "earliest two overall, not the first calendar's two");
  });

  console.log("calendar fan-out: dedupe");

  await check("an event mirrored onto two calendars comes back once, primary copy kept", async () => {
    const uid = "abc123@google.com";
    const { events } = await search({
      [`personal/${CALS.primary.id}`]: [ev({ id: "e1", start: "2026-07-30T17:00:00Z", iCalUID: uid, summary: "1:1 with Hillary" })],
      [`personal/${MEETINGS_ID}`]: [ev({ id: "e1", start: "2026-07-30T17:00:00Z", iCalUID: uid, summary: "1:1 with Hillary" })],
    });
    assert.equal(events.length, 1, "the same meeting must not be reported twice");
    assert.equal(events[0].calendarId, CALS.primary.id, "prefer the copy whose calendarId/account reads sensibly");
  });

  await check("the same invite on two ACCOUNTS collapses to the primary account's copy", async () => {
    const uid = "cross@google.com";
    const { events } = await search({
      [`school/${MEETINGS_ID}`]: [ev({ id: "x", start: "2026-08-01T16:00:00Z", iCalUID: uid })],
      [`personal/${MEETINGS_ID}`]: [ev({ id: "x", start: "2026-08-01T16:00:00Z", iCalUID: uid })],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].account, "personal", "accounts[0] is the primary account and wins ties");
  });

  await check("recurring instances sharing an iCalUID are NOT collapsed", () => {
    const uid = "weekly@google.com";
    const instances = [
      ev({ id: "w_20260730", start: "2026-07-30T17:00:00Z", iCalUID: uid }),
      ev({ id: "w_20260806", start: "2026-08-06T17:00:00Z", iCalUID: uid }),
      ev({ id: "w_20260813", start: "2026-08-13T17:00:00Z", iCalUID: uid }),
    ];
    assert.equal(dedupeEvents(instances).length, 3, "collapsing a weekly 1:1 to one instance would be a new false negative");
    assert.notEqual(dedupeKeyFor(instances[0]), dedupeKeyFor(instances[1]));
  });

  await check("no iCalUID falls back to id + start", () => {
    const a = ev({ id: "same", start: "2026-07-30T17:00:00Z" });
    const b = ev({ id: "same", start: "2026-07-30T17:00:00Z", calendarId: MEETINGS_ID, primaryCalendar: false });
    const c = ev({ id: "same", start: "2026-08-06T17:00:00Z" });
    assert.equal(dedupeEvents([a, b]).length, 1, "same id + same start on two calendars is one event");
    assert.equal(dedupeEvents([a, c]).length, 2, "same id, different start is a different instance");
    assert.equal(dedupeEvents([b, a])[0].calendarId, "primary", "the primary copy wins regardless of arrival order");
  });

  await check("distinct events that merely start together are both kept", () => {
    const a = ev({ id: "one", start: "2026-07-30T17:00:00Z", iCalUID: "u1@google.com" });
    const b = ev({ id: "two", start: "2026-07-30T17:00:00Z", iCalUID: "u2@google.com" });
    assert.equal(mergeEvents([a, b]).length, 2);
  });

  console.log("calendar fan-out: failure is per calendar, not global");

  await check("one calendar 403-ing does not empty the search, and is reported", async () => {
    const { events, errors } = await search(
      {
        [`personal/${MEETINGS_ID}`]: [ev({ id: "keep", start: "2026-07-30T12:45:00-07:00" })],
        [`personal/${CALS.primary.id}`]: [ev({ id: "boom", start: "2026-07-30T09:00:00-07:00" })],
      },
      { fail: (account, id) => account === "personal" && id === CALS.primary.id },
    );
    assert.deepEqual(events.map((e) => e.id), ["keep"], "the healthy calendars still answer");
    assert.equal(errors.length, 1, "nothing is swallowed silently");
    assert.equal(errors[0].calendarId, CALS.primary.id);
  });

  await check("a calendarList failure degrades that account to primary, others unaffected", async () => {
    const { events, errors, asked } = await search(
      {
        "school/primary": [ev({ id: "fallback", start: "2026-07-30T09:00:00-07:00", account: "school" })],
        [`personal/${MEETINGS_ID}`]: [ev({ id: "meetings", start: "2026-07-30T12:45:00-07:00" })],
      },
      { listFail: (account) => account === "school" },
    );
    assert.deepEqual(events.map((e) => e.id).sort(), ["fallback", "meetings"]);
    assert.ok(asked.includes("school/primary"), "degrade to the old behavior rather than returning nothing");
    assert.equal(errors.filter((e) => !e.calendarId).length, 1, "the enumeration failure is reported too");
  });

  await check("every calendar failing returns empty WITHOUT throwing", async () => {
    const { events, errors } = await search({}, { fail: () => true });
    assert.deepEqual(events, [], "a throw here would cost the whole calendar turn");
    assert.equal(errors.length, 4, "one report per skipped calendar");
  });

  console.log("calendar fan-out: bounded");

  await check("the fan-out never exceeds its concurrency limit", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `cal${i}@group.calendar.google.com`,
      summary: `cal${i}`,
      primary: i === 0,
      accessRole: "owner",
    }));
    const { peak } = await search({}, { calendars: { personal: many as any, school: many as any }, concurrency: 3 });
    assert.ok(peak <= 3, `expected ≤3 in flight, saw ${peak}`);
    assert.ok(peak > 1, "…but it must still be parallel, or a 10-calendar search gets slow");
  });

  await check("the default limit is a sane small number", () => {
    assert.ok(CAL_FANOUT_CONCURRENCY >= 4 && CAL_FANOUT_CONCURRENCY <= 8, "5-6ish: parallel, not a burst");
  });

  console.log("calendar fan-out: the poller watches less than search reads");

  await check("watch covers their own calendars, not read-only subscriptions", () => {
    const ids = watchTargets(Object.values(CALS)).map((t) => t.id);
    assert.ok(ids.includes(MEETINGS_ID), "an invite landing on Meetings must be able to ping — it couldn't before");
    assert.ok(ids.includes(CALS.primary.id));
    assert.ok(!ids.includes(CALS.shared.id), "edits on a calendar they only subscribe to aren't actionable");
    assert.ok(!ids.includes(CALS.holidays.id));
  });

  await check("an entry with no accessRole is still watched", () => {
    const partial = { id: "x@group.calendar.google.com", summary: "X", primary: false };
    assert.ok(watchTargets([CALS.primary, partial]).some((t) => t.id === partial.id), "unknown must not mean dropped");
  });

  const { calSyncSlot } = await import("./calendar-poller");

  await check("the old one-token-per-account sync state migrates instead of re-priming", () => {
    const state: any = { personal: { syncToken: "OLD" }, school: { syncToken: "OLD2" } };
    assert.equal(calSyncSlot(state, "personal", "primary").syncToken, "OLD", "the existing cursor is still valid for that calendar");
    assert.equal(state.personal.syncToken, undefined, "and it doesn't linger in the old shape");
    assert.equal(calSyncSlot(state, "personal", MEETINGS_ID).syncToken, undefined, "a newly watched calendar primes fresh");
    calSyncSlot(state, "personal", MEETINGS_ID).syncToken = "NEW";
    assert.equal(calSyncSlot(state, "personal", MEETINGS_ID).syncToken, "NEW", "slots persist by reference");
    assert.equal(calSyncSlot(state, "personal", "primary").syncToken, "OLD", "…without disturbing the migrated one");
    assert.equal(calSyncSlot(state, "school", "primary").syncToken, "OLD2");
    assert.equal(calSyncSlot(state, "new-account", "primary").syncToken, undefined, "an unknown account is created empty");
  });

  console.log("calendar fan-out: the real searchEvents() wiring");

  process.env.GOOGLE_ACCOUNTS = "personal,school";
  process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "test-token";
  process.env.GOOGLE_REFRESH_TOKEN_SCHOOL = "test-token";
  const calendar = await import("./calendar");

  /** Drive the real exported search with fake transport deps (no network, no session). */
  function fakeDeps(hits: Record<string, { id: string; start: string; summary: string }[]>) {
    const asked: string[] = [];
    const deps = {
      calendarsFor: async () => [CALS.primary, CALS.meetings, CALS.holidays],
      fetchEvents: async ({ account, calendar: c }: any) => {
        asked.push(`${account}/${c.id}`);
        return (hits[`${account}/${c.id}`] ?? []).map((e) => ({
          ...e,
          calendarId: c.id,
          account,
          primaryCalendar: c.primary,
          end: e.start,
          allDay: false,
          location: "",
          attendees: [],
          status: "confirmed",
          htmlLink: "",
        }));
      },
    };
    return { deps, asked };
  }

  await check("searchEvents spans both accounts and both real calendars, skipping the holiday feed", async () => {
    const { deps, asked } = fakeDeps({
      [`personal/${MEETINGS_ID}`]: [{ id: "sccr", start: "2026-07-30T12:45:00-07:00", summary: "SCCR hearing" }],
    });
    const events = await calendar.searchEvents({ q: "hearing" }, deps as any);
    assert.deepEqual(events.map((e) => e.summary), ["SCCR hearing"], "a q= search must reach secondary calendars");
    assert.deepEqual(asked.sort(), [
      `personal/${CALS.primary.id}`,
      `personal/${MEETINGS_ID}`,
      `school/${CALS.primary.id}`,
      `school/${MEETINGS_ID}`,
    ].sort());
  });

  await check("listEventsAll routes through the same fan-out", async () => {
    const { deps, asked } = fakeDeps({
      [`school/${MEETINGS_ID}`]: [{ id: "x", start: "2026-07-30T10:00:00-07:00", summary: "advisor" }],
    });
    // agenda.ts calls listEventsAll — the ambient week view had the same blind spot.
    const events = await calendar.searchEvents({ timeMin: "2026-07-30T00:00:00Z" }, deps as any);
    assert.equal(events.length, 1);
    assert.equal(asked.length, 4);
  });

  await check("an explicitly named calendar_id is honored without any fan-out", async () => {
    const { deps, asked } = fakeDeps({
      [`personal/${MEETINGS_ID}`]: [{ id: "sccr", start: "2026-07-30T12:45:00-07:00", summary: "SCCR hearing" }],
    });
    const events = await calendar.searchEvents({ calendarId: MEETINGS_ID }, deps as any);
    assert.deepEqual(asked, [`personal/${MEETINGS_ID}`], "one calendar asked for, one calendar queried");
    assert.equal(events.length, 1);
  });

  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

void main();
