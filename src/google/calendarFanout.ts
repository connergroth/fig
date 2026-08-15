import { mapWithConcurrency } from "../core/concurrency";

/**
 * Calendar fan-out: the logic that makes a lookup see EVERY calendar, not just each
 * account's primary one.
 *
 * The bug this exists for (VERIFIED 2026-07-29): `events.list` was only ever called
 * with calendarId "primary", so every secondary calendar was invisible to any
 * time-range or free-text lookup — including "Meetings", where every 1:1, coffee chat
 * and hearing lives. Asked what was on tomorrow, the tool answered "completely free,
 * empty across all connected accounts" over an honor-code hearing. A confident empty
 * result, which is the worst failure a calendar can have.
 *
 * Kept in its own module (and free of googleapis) so the merge/dedupe/failure rules
 * are testable without a network or a live session — the same reason the fix couldn't
 * be verified by "it looked right in the tool output" the first time.
 */

/** How many (account, calendar) event queries may be in flight at once. */
export const CAL_FANOUT_CONCURRENCY = 6;

/**
 * Google's own generated feeds. These are the only calendars we exclude from a
 * search, because they're the only ones identifiable with certainty: the ids are
 * minted by Google, not by a user, so the suffix match can't collide with one of
 * The owner's calendars. Everything else is included — a false negative is the bug
 * we're fixing, so "probably noise" is not good enough to skip.
 */
export const NOISE_CALENDAR_SUFFIXES = [
  "#holiday@group.v.calendar.google.com", // "Holidays in United States"
  "#contacts@group.v.calendar.google.com", // "Birthdays" (from contacts)
  "#weeknum@group.v.calendar.google.com", // week numbers
] as const;

export function isNoiseCalendar(id: string): boolean {
  const lower = id.toLowerCase();
  return NOISE_CALENDAR_SUFFIXES.some((s) => lower.endsWith(s));
}

/** A calendarList entry, trimmed to what the fan-out decides on. */
export interface CalendarRef {
  id: string;
  summary: string;
  primary: boolean;
  /** calendarList access role: owner | writer | reader | freeBusyReader. */
  accessRole?: string;
  /** Set on entries the owner has removed; only appears in sync responses. */
  deleted?: boolean;
}

export interface CalendarTarget {
  id: string;
  primary: boolean;
  summary: string;
}

/** The API alias for an account's own calendar, valid without enumerating anything. */
export const PRIMARY_ALIAS: CalendarTarget = { id: "primary", primary: true, summary: "primary" };

/**
 * Which calendar ids a SEARCH should hit for one account, primary first.
 *
 * An empty list means enumeration failed or returned nothing, and the answer is the
 * "primary" alias — i.e. degrade to the old behavior rather than returning zero
 * events, which would turn a calendarList hiccup into the same confident-empty lie.
 */
export function searchTargets(calendars: CalendarRef[]): CalendarTarget[] {
  const usable = calendars.filter((c) => c.id && !c.deleted && !isNoiseCalendar(c.id));
  if (!usable.length) return [PRIMARY_ALIAS];
  // Stable sort: primary first (so its copy wins dedupe), then enumeration order.
  return [...usable]
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((c) => ({ id: c.id, primary: !!c.primary, summary: c.summary }));
}

/**
 * Which calendars the change POLLER should watch. Stricter than search on purpose:
 * search must never miss an event, but pinging the owner about edits to a calendar they
 * merely subscribes to (a class feed, someone else's shared calendar) is noise they
 * can't act on. Owner/writer access is the robust line — their own secondary calendars
 * ("Meetings") are owner, subscriptions are reader/freeBusyReader.
 *
 * Access role is absent on an unknown/partial entry; treat that as watchable rather
 * than silently dropping a calendar whose invites would then never ping.
 */
export function watchTargets(calendars: CalendarRef[]): CalendarTarget[] {
  return searchTargets(calendars).filter((t) => {
    if (t.id === PRIMARY_ALIAS.id) return true;
    const role = calendars.find((c) => c.id === t.id)?.accessRole;
    return !role || role === "owner" || role === "writer";
  });
}

/** The minimum an event needs for merge + dedupe. */
export interface MergeableEvent {
  id: string;
  calendarId: string;
  account: string;
  start: string;
  iCalUID?: string;
  /** Whether `calendarId` is the account's primary calendar. */
  primaryCalendar?: boolean;
}

/**
 * Dedupe key. iCalUID is the cross-calendar identity (an invite mirrored onto two
 * calendars, or onto two of their accounts, carries the same one) — but the START is
 * part of the key on purpose: instances of a recurring series can share an iCalUID,
 * and collapsing a weekly 1:1 down to one instance would be a NEW false negative,
 * i.e. the same class of bug this whole change is fixing. Falls back to the event id
 * when there's no iCalUID (quickAdd results, partial responses).
 */
export function dedupeKeyFor(e: MergeableEvent): string {
  const uid = e.iCalUID?.trim();
  return `${uid ? `uid:${uid}` : `id:${e.id}`}|${e.start}`;
}

/** Higher wins: the primary calendar's copy, then the primary account's. */
function rank(e: MergeableEvent, primaryAccount?: string): number {
  return (e.primaryCalendar ? 2 : 0) + (primaryAccount && e.account === primaryAccount ? 1 : 0);
}

/**
 * One copy per real event, keeping the copy whose calendarId/account is most useful
 * to report back (the agent uses those to get/update/delete it). Ties keep the first
 * seen, so the caller's ordering decides.
 */
export function dedupeEvents<T extends MergeableEvent>(events: T[], primaryAccount?: string): T[] {
  const best = new Map<string, T>();
  for (const e of events) {
    const key = dedupeKeyFor(e);
    const held = best.get(key);
    if (!held || rank(e, primaryAccount) > rank(held, primaryAccount)) best.set(key, e);
  }
  return [...best.values()];
}

/** Dedupe, then order by start time, then apply `max` — what every caller wants. */
export function mergeEvents<T extends MergeableEvent>(
  events: T[],
  opts: { max?: number; primaryAccount?: string } = {},
): T[] {
  const merged = dedupeEvents(events, opts.primaryAccount);
  merged.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
  return typeof opts.max === "number" ? merged.slice(0, opts.max) : merged;
}

export interface FanoutSearchOptions<T extends MergeableEvent> {
  /** Account labels to search, in priority order (first is treated as primary). */
  accounts: string[];
  /** Enumerate one account's calendars. May throw — that degrades to the primary alias. */
  calendarsFor: (account: string) => Promise<CalendarRef[]>;
  /** Fetch events from one calendar. May throw — that calendar is skipped. */
  fetchEvents: (target: { account: string; calendar: CalendarTarget }) => Promise<T[]>;
  max?: number;
  concurrency?: number;
  /** Called for every tolerated failure. Nothing is swallowed silently. */
  onError?: (ctx: { account: string; calendarId?: string }, err: unknown) => void;
}

/**
 * Search every calendar of every given account, tolerating per-calendar failures.
 *
 * Failure policy is the whole point: one calendar 403-ing (a shared calendar whose
 * access was revoked, a freeBusyReader feed) must not take down the search, or the
 * fix trades a silent miss for a loud one. Every skip is reported through `onError`.
 */
export async function fanoutSearch<T extends MergeableEvent>(opts: FanoutSearchOptions<T>): Promise<T[]> {
  const limit = opts.concurrency ?? CAL_FANOUT_CONCURRENCY;
  const primaryAccount = opts.accounts[0];

  const perAccount = await mapWithConcurrency(opts.accounts, limit, async (account) => {
    try {
      return { account, calendars: searchTargets(await opts.calendarsFor(account)) };
    } catch (e) {
      opts.onError?.({ account }, e);
      return { account, calendars: [PRIMARY_ALIAS] }; // degrade, never return nothing
    }
  });

  const targets = perAccount.flatMap((a) => a.calendars.map((calendar) => ({ account: a.account, calendar })));

  const perCalendar = await mapWithConcurrency(targets, limit, async (t) => {
    try {
      return await opts.fetchEvents(t);
    } catch (e) {
      opts.onError?.({ account: t.account, calendarId: t.calendar.id }, e);
      return [] as T[];
    }
  });

  return mergeEvents(perCalendar.flat(), { max: opts.max, primaryAccount });
}
