import { calendar_v3, google } from "googleapis";

import { mapWithConcurrency } from "../core/concurrency";
import { warn } from "../core/log";
import { accountFor, googleAccounts, oauth2For, primaryLabel } from "./accounts";
import {
  CAL_FANOUT_CONCURRENCY,
  type CalendarRef,
  type CalendarTarget,
  fanoutSearch,
  searchTargets,
} from "./calendarFanout";
import { resolveOwnerTz } from "../location/timezone";
import { recordSelfChange } from "./self-changes";

/**
 * Shared Google Calendar core. Used by the mcp__calendar__* tools and (later)
 * by the daily-briefing cron. Reuses the same OAuth refresh token as Gmail — the
 * token just needs the calendar scope (re-run `npm run auth:google`).
 *
 * Reads FAN OUT across every calendar of every account (see calendarFanout.ts).
 * Only writes still default to "primary" — an unqualified create belongs on their own
 * calendar, but an unqualified read must not silently be scoped to it.
 */

/**
 * The zone calendar times are rendered in: wherever the OWNER physically is, same source
 * the rest of the clock uses (`resolveOwnerTz`, off the last Find My fix). Not the mini's
 * zone — the mini stays in one place for months while they don't — and deliberately not
 * the Google calendar's own zone, which is whatever the account was last set to.
 *
 * Location-following is the right behavior: when they type "3pm" they mean 3pm where they
 * are standing. It is NOT, however, what makes a rendered time safe to read — see
 * `toCalTz` below. `AGENT_TZ` pins it for tests.
 */
export function calTz(): string {
  return process.env.AGENT_TZ || resolveOwnerTz();
}

/** How long an account's calendar list is trusted before re-enumerating (ms). */
const CAL_LIST_TTL_MS = Number(process.env.CAL_LIST_TTL_MS || 5 * 60 * 1000);

const clients = new Map<string, calendar_v3.Calendar>();

export function calendarClient(account?: string): calendar_v3.Calendar {
  const label = accountFor(account).label;
  let c = clients.get(label);
  if (!c) {
    c = google.calendar({ version: "v3", auth: oauth2For(label) });
    clients.set(label, c);
  }
  return c;
}

export interface EventSummary {
  id: string;
  calendarId: string; // WHICH calendar it came from — needed to get/update/delete it
  account: string; // which Google account this event lives in
  /** True when calendarId is that account's own (primary) calendar. */
  primaryCalendar?: boolean;
  /** Cross-calendar identity, used to dedupe mirrored copies of one event. */
  iCalUID?: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  attendees: string[];
  status: string;
  htmlLink: string;
  hangoutLink?: string;
}

/**
 * Google returns `dateTime` in the CALENDAR's own timezone, which is not necessarily
 * the owner's. (Real case: the account timezone was left on America/Los_Angeles after a
 * summer away, so Boulder 9:05am classes came back as `08:05:00-07:00` — the instant was
 * right, the digits were an hour off for where the owner actually is.) A reader skims the
 * digits and drops the offset, so the offset is not a safe place to keep the truth.
 *
 * Every time is therefore re-rendered into the owner's CURRENT zone before it leaves this
 * module (same instant, still ISO-parseable), and `fmtEvent` prints the zone LABEL next to
 * it. The label is the actual fix: location-following alone would still have rendered that
 * Boulder class as 8:05 while the owner stood in California. `08:05 PDT` is the version a
 * reader catches, because the zone is stated instead of inferred.
 */
function toCalTz(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: calTz(),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d)) {
    p[part.type] = part.value;
  }
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${tzOffset(d)}`;
}

/** The numeric UTC offset of `calTz()` at that instant, as `+HH:MM` / `-HH:MM`. */
function tzOffset(d: Date): string {
  const local = new Date(d.toLocaleString("en-US", { timeZone: calTz() }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const mins = Math.round((local.getTime() - utc.getTime()) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Short zone label (`MDT`, `PDT`) for that instant, so a rendered time names its zone. */
export function tzLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: calTz(), timeZoneName: "short" }).formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

function fmtWhen(d: calendar_v3.Schema$EventDateTime | undefined): string {
  if (d?.dateTime) return toCalTz(d.dateTime);
  return d?.date ?? "";
}

/** Test seam: the raw Google → EventSummary mapping, without a live API call. */
export function summarizeForTest(e: calendar_v3.Schema$Event): EventSummary {
  return summarize(e, "primary");
}

function summarize(
  e: calendar_v3.Schema$Event,
  calendarId: string,
  account = primaryLabel(),
  primaryCalendar = calendarId === "primary",
): EventSummary {
  return {
    id: e.id ?? "",
    calendarId,
    account,
    primaryCalendar,
    iCalUID: e.iCalUID ?? undefined,
    summary: e.summary ?? "(no title)",
    start: fmtWhen(e.start),
    end: fmtWhen(e.end),
    allDay: !!e.start?.date,
    location: e.location ?? "",
    attendees: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
    status: e.status ?? "",
    htmlLink: e.htmlLink ?? "",
    hangoutLink: e.hangoutLink ?? undefined,
  };
}

/**
 * Per-account calendar list, cached for CAL_LIST_TTL_MS. Every fanned-out search
 * needs this list, and it changes about once a year — re-enumerating on each query
 * would add an API round-trip to every single lookup.
 *
 * A refresh failure falls back to the last good list (however stale) rather than
 * propagating: losing the list means losing every secondary calendar, which is
 * exactly the blindness being fixed.
 */
const calListCache = new Map<string, { at: number; cals: CalendarRef[] }>();

export function clearCalendarListCache(account?: string): void {
  if (account) calListCache.delete(accountFor(account).label);
  else calListCache.clear();
}

export async function listCalendars(account?: string, opts: { refresh?: boolean } = {}): Promise<CalendarRef[]> {
  const label = accountFor(account).label;
  const hit = calListCache.get(label);
  if (!opts.refresh && hit && Date.now() - hit.at < CAL_LIST_TTL_MS) return hit.cals;
  try {
    // showHidden: a calendar the owner unchecked in the Google UI still holds real events,
    // and "hidden from my view" is not "irrelevant to a search for it".
    const res = await calendarClient(label).calendarList.list({ maxResults: 250, showHidden: true });
    if (res.data.nextPageToken) warn(`calendar list [${label}] has more than 250 calendars — only the first page is searched`);
    const cals: CalendarRef[] = (res.data.items ?? []).map((c) => ({
      id: c.id ?? "",
      // summaryOverride is the name the owner sees in every calendar UI once they rename a
      // subscribed feed; c.summary is the raw name the feed publishes about itself. Reporting
      // the raw one hands them a calendar name that exists nowhere on their screen.
      summary: c.summaryOverride ?? c.summary ?? "",
      primary: !!c.primary,
      accessRole: c.accessRole ?? undefined,
      deleted: c.deleted ?? undefined,
    }));
    calListCache.set(label, { at: Date.now(), cals });
    return cals;
  } catch (e) {
    if (hit) {
      warn(`calendar list refresh failed [${label}], using cached list: ${e}`);
      return hit.cals;
    }
    throw e;
  }
}

/** Events from ONE calendar (defaults to the account's primary). The raw single call. */
export async function listEvents(opts: {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  max?: number;
  account?: string;
  /** Internal: whether calendarId is that account's primary, for dedupe preference. */
  primaryCalendar?: boolean;
}): Promise<EventSummary[]> {
  const calendarId = opts.calendarId || "primary";
  const label = accountFor(opts.account).label;
  const res = await calendarClient(label).events.list({
    calendarId,
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    q: opts.q,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: opts.max ?? 20,
  });
  return (res.data.items ?? []).map((e) =>
    summarize(e, calendarId, label, opts.primaryCalendar ?? calendarId === "primary"),
  );
}

/** Injectable seam so the fan-out is testable without a live Google session. */
export interface SearchDeps {
  calendarsFor: (account: string) => Promise<CalendarRef[]>;
  fetchEvents: (args: { account: string; calendar: CalendarTarget; opts: SearchOptions }) => Promise<EventSummary[]>;
}

export interface SearchOptions {
  timeMin?: string;
  timeMax?: string;
  q?: string;
  max?: number;
  /** Restrict to one account label; omit to search every configured account. */
  account?: string;
  /** Restrict to one calendar id; omit to search every calendar. */
  calendarId?: string;
}

const liveSearchDeps: SearchDeps = {
  calendarsFor: (account) => listCalendars(account),
  fetchEvents: ({ account, calendar, opts }) =>
    listEvents({ ...opts, account, calendarId: calendar.id, primaryCalendar: calendar.primary }),
};

/**
 * The read path for "what's on my calendar" and "find the event about X".
 *
 * Spans every calendar of every account unless told otherwise, because the previous
 * behavior (primary only) produced a confident "you're completely free" over an event
 * sitting on the Meetings calendar. One calendar failing is tolerated and logged;
 * duplicates of one event across calendars collapse to the copy worth reporting.
 */
export async function searchEvents(opts: SearchOptions = {}, deps: SearchDeps = liveSearchDeps): Promise<EventSummary[]> {
  if (opts.calendarId) {
    // An explicitly named calendar means the caller already knows where to look.
    return deps.fetchEvents({
      account: accountFor(opts.account).label,
      calendar: { id: opts.calendarId, primary: opts.calendarId === "primary", summary: opts.calendarId },
      opts,
    });
  }
  const accounts = opts.account ? [accountFor(opts.account).label] : googleAccounts().map((a) => a.label);
  if (!accounts.length) return [];
  return fanoutSearch<EventSummary>({
    accounts,
    max: opts.max,
    calendarsFor: deps.calendarsFor,
    fetchEvents: ({ account, calendar }) => deps.fetchEvents({ account, calendar, opts }),
    onError: (ctx, e) =>
      warn(`calendar search skipped [${ctx.account}${ctx.calendarId ? `/${ctx.calendarId}` : ""}]: ${e}`),
  });
}

/** List events across ALL accounts and ALL their calendars, merged by start time. */
export async function listEventsAll(opts: SearchOptions = {}): Promise<EventSummary[]> {
  return searchEvents(opts);
}

/** List calendars across all accounts, each tagged with its account label. */
export async function listCalendarsAll(): Promise<(CalendarRef & { account: string })[]> {
  const per = await Promise.all(
    googleAccounts().map(async (a) =>
      (await listCalendars(a.label).catch(() => [] as CalendarRef[])).map((c) => ({ ...c, account: a.label })),
    ),
  );
  return per.flat();
}

/**
 * Fetch one event, reporting WHERE it was found. When no calendarId is given, a miss
 * on the primary calendar falls back to searching the account's other calendars (and
 * every account, if none was named) — the search now surfaces events that live on
 * secondary calendars, so a bare get of one of those would otherwise 404.
 */
export async function getEventLocated(
  eventId: string,
  calendarId?: string,
  account?: string,
): Promise<{ event: calendar_v3.Schema$Event; calendarId: string; account: string }> {
  const label = accountFor(account).label;
  const first = calendarId || "primary";
  try {
    const res = await calendarClient(label).events.get({ calendarId: first, eventId });
    return { event: res.data, calendarId: first, account: label };
  } catch (e) {
    if (calendarId) throw e; // caller named a calendar; don't second-guess it
    const found = await findEvent(eventId, account ? [label] : googleAccounts().map((a) => a.label), first);
    if (found) return found;
    throw e;
  }
}

export async function getEvent(
  eventId: string,
  calendarId?: string,
  account?: string,
): Promise<calendar_v3.Schema$Event> {
  return (await getEventLocated(eventId, calendarId, account)).event;
}

/** Hunt one event id across every calendar of the given accounts. Failures are skips. */
async function findEvent(
  eventId: string,
  accounts: string[],
  skipCalendarId?: string,
): Promise<{ event: calendar_v3.Schema$Event; calendarId: string; account: string } | null> {
  const targets: { account: string; calendarId: string }[] = [];
  for (const label of accounts) {
    const cals = await listCalendars(label).catch(() => [] as CalendarRef[]);
    for (const t of searchTargets(cals)) {
      // Don't re-try the calendar that already missed. "primary" is an alias for the
      // primary calendar's real id, so skip that too rather than paying for it twice.
      const alreadyTried = label === accounts[0] && (t.id === skipCalendarId || (skipCalendarId === "primary" && t.primary));
      if (alreadyTried) continue;
      targets.push({ account: label, calendarId: t.id });
    }
  }
  const hits = await mapWithConcurrency(targets, CAL_FANOUT_CONCURRENCY, async (t) => {
    try {
      const res = await calendarClient(t.account).events.get({ calendarId: t.calendarId, eventId });
      return res.data.id ? { event: res.data, calendarId: t.calendarId, account: t.account } : null;
    } catch {
      return null; // a 404 here is the normal case — it's not on this calendar
    }
  });
  return hits.find(Boolean) ?? null;
}

/**
 * Busy blocks for scheduling. Defaults to EVERY calendar on EVERY account, for the
 * same reason search does: "that slot is free" computed from the primary calendar
 * alone would happily book over a hearing sitting on Meetings.
 */
export async function freeBusy(opts: {
  timeMin: string;
  timeMax: string;
  calendarIds?: string[];
  account?: string;
}): Promise<{ calendarId: string; account: string; busy: { start: string; end: string }[] }[]> {
  const accounts = opts.account ? [accountFor(opts.account).label] : googleAccounts().map((a) => a.label);
  const per = await mapWithConcurrency(accounts, CAL_FANOUT_CONCURRENCY, async (label) => {
    let ids = opts.calendarIds?.length ? opts.calendarIds : [];
    if (!ids.length) {
      const cals = await listCalendars(label).catch((e) => {
        warn(`freebusy calendar list failed [${label}]: ${e}`);
        return [] as CalendarRef[];
      });
      ids = searchTargets(cals).map((t) => t.id);
    }
    // freebusy.query caps at 50 items per request; say so rather than silently truncating.
    if (ids.length > 50) {
      warn(`freebusy [${label}]: ${ids.length} calendars, querying the first 50`);
      ids = ids.slice(0, 50);
    }
    try {
      const res = await calendarClient(label).freebusy.query({
        requestBody: { timeMin: opts.timeMin, timeMax: opts.timeMax, items: ids.map((id) => ({ id })) },
      });
      return Object.entries(res.data.calendars ?? {}).map(([calendarId, v]) => {
        if (v.errors?.length) warn(`freebusy [${label}/${calendarId}]: ${v.errors.map((x) => x.reason).join(", ")}`);
        return {
          calendarId,
          account: label,
          busy: (v.busy ?? []).map((b) => ({ start: b.start ?? "", end: b.end ?? "" })),
        };
      });
    } catch (e) {
      warn(`freebusy failed [${label}]: ${e}`);
      return [];
    }
  });
  return per.flat();
}

export interface EventInput {
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD if allDay
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  recurrence?: string; // a single RRULE line, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO"
  addMeet?: boolean;
  calendarId?: string;
  notifyAttendees?: boolean;
  account?: string;
}

function whenFrom(value: string, allDay: boolean): calendar_v3.Schema$EventDateTime {
  return allDay ? { date: value.slice(0, 10) } : { dateTime: value, timeZone: calTz() };
}

function buildBody(input: Partial<EventInput>): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {};
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.location !== undefined) body.location = input.location;
  if (input.description !== undefined) body.description = input.description;
  if (input.start !== undefined) body.start = whenFrom(input.start, !!input.allDay);
  if (input.end !== undefined) body.end = whenFrom(input.end, !!input.allDay);
  if (input.attendees !== undefined) body.attendees = input.attendees.map((email) => ({ email }));
  if (input.recurrence !== undefined && input.recurrence) body.recurrence = [input.recurrence];
  if (input.addMeet) {
    body.conferenceData = {
      createRequest: { requestId: `meet-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }
  return body;
}

export async function createEvent(input: EventInput): Promise<EventSummary> {
  const calendarId = input.calendarId || "primary";
  const res = await calendarClient(input.account).events.insert({
    calendarId,
    requestBody: buildBody(input),
    sendUpdates: input.notifyAttendees ? "all" : "none",
    conferenceDataVersion: input.addMeet ? 1 : 0,
  });
  recordSelfChange(res.data.id, input.account); // don't let the sync poller ping about their own change
  return summarize(res.data, calendarId, input.account);
}

/**
 * Where a mutation should land. With an explicit calendarId this is a no-op; without
 * one it LOCATES the event first, because search now returns events from secondary
 * calendars and patching those against "primary" is a 404. One extra read on the
 * unqualified path, and it doubles as an existence check before a delete.
 */
async function mutationTarget(
  eventId: string,
  opts: { calendarId?: string; account?: string },
): Promise<{ calendarId: string; account: string }> {
  if (opts.calendarId) return { calendarId: opts.calendarId, account: accountFor(opts.account).label };
  const found = await getEventLocated(eventId, undefined, opts.account);
  return { calendarId: found.calendarId, account: found.account };
}

export async function updateEvent(
  eventId: string,
  patch: Partial<EventInput>,
  opts: { calendarId?: string; notifyAttendees?: boolean; account?: string } = {},
): Promise<EventSummary> {
  const { calendarId, account } = await mutationTarget(eventId, opts);
  const res = await calendarClient(account).events.patch({
    calendarId,
    eventId,
    requestBody: buildBody(patch),
    sendUpdates: opts.notifyAttendees ? "all" : "none",
  });
  recordSelfChange(eventId, account);
  return summarize(res.data, calendarId, account);
}

export async function deleteEvent(
  eventId: string,
  opts: { calendarId?: string; notifyAttendees?: boolean; account?: string } = {},
): Promise<void> {
  const { calendarId, account } = await mutationTarget(eventId, opts);
  await calendarClient(account).events.delete({
    calendarId,
    eventId,
    sendUpdates: opts.notifyAttendees ? "all" : "none",
  });
  recordSelfChange(eventId, account);
}

/**
 * One human line for an event id — `"Flight to Denver" · Sun Aug 9, 11:00 AM`.
 *
 * Exists for the 🔐 approval prompt. A raw event id tells the owner nothing about what
 * they are being asked to delete, so the gate resolves it to the title and time first.
 * Best-effort by design: returns null when the lookup fails, so a caller falls back to
 * the id rather than blocking the ask on a calendar round-trip.
 */
export async function describeEvent(
  eventId: string,
  calendarId?: string,
  account?: string,
): Promise<string | null> {
  try {
    return eventLabel(await getEvent(eventId, calendarId, account));
  } catch {
    return null;
  }
}

/** The pure half of `describeEvent` — formatting only, so it is testable without Google. */
export function eventLabel(e: calendar_v3.Schema$Event): string {
  const title = e.summary?.trim() || "(untitled)";
  // All-day events carry `date` (YYYY-MM-DD) with no zone. Parsing that bare string is
  // UTC midnight, which renders as the PREVIOUS day west of Greenwich — anchor at noon.
  const iso = e.start?.dateTime || (e.start?.date ? `${e.start.date}T12:00:00` : null);
  if (!iso) return `"${title}"`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `"${title}"`;
  const day = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: calTz(),
  });
  if (!e.start?.dateTime) return `"${title}" · ${day} (all day)`;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: calTz() });
  return `"${title}" · ${day}, ${time}`;
}

/** RSVP to an invite: set the user's own responseStatus on the event. */
export async function rsvp(
  eventId: string,
  response: "accepted" | "declined" | "tentative",
  calendarId?: string,
  account?: string,
): Promise<void> {
  const located = await getEventLocated(eventId, calendarId, account);
  const attendees = (located.event.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: response } : a));
  await calendarClient(located.account).events.patch({
    calendarId: located.calendarId,
    eventId,
    requestBody: { attendees },
    sendUpdates: "all",
  });
  recordSelfChange(eventId, located.account);
}

export async function quickAdd(text: string, calendarId = "primary", account?: string): Promise<EventSummary> {
  const res = await calendarClient(account).events.quickAdd({ calendarId, text, sendUpdates: "none" });
  recordSelfChange(res.data.id, account);
  return summarize(res.data, calendarId, account);
}
