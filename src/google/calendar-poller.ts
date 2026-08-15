import fs from "node:fs";
import path from "node:path";

import { calendar_v3 } from "googleapis";

import { config } from "../core/config";
import { log, warn } from "../core/log";
import { deliverProactive, inQuietHours, voiceProactive, PROACTIVE_SKIP } from "../scheduling/proactive";
import type { Transport } from "../transport";
import { googleAccounts, primaryLabel } from "./accounts";
import { refreshAgenda } from "./agenda";
import { calTz, calendarClient, listCalendars } from "./calendar";
import { watchTargets } from "./calendarFanout";
import { isSelfChange } from "./self-changes";

/**
 * Calendar change notifications via incremental sync (no webhook / public endpoint),
 * across ALL configured Google accounts AND all of their watchable calendars. Each
 * tick, per (account, calendar), events.list(syncToken) returns only what changed —
 * empty and cheap when nothing moved. New invites, time/location changes, and
 * cancellations get voiced + delivered; routine solo events and changes the agent just
 * made are filtered out. Multi-account: per-account self-email, per-calendar syncToken,
 * and non-primary changes are tagged so the owner knows which account/calendar.
 *
 * Watching only "primary" was the poller's half of the 2026-07-29 blindness: an invite
 * landing on the Meetings calendar changed nothing the poller could see, so it never
 * pinged. Search fans out to EVERY calendar; the poller is deliberately stricter
 * (owner/writer only — see watchTargets) because edits on a calendar they merely
 * subscribes to are noise they can't act on.
 */

/** Set CAL_CALENDAR_ID to pin the poller to one calendar (opts out of the fan-out). */
const CALENDAR_ID = process.env.CAL_CALENDAR_ID?.trim() || "";
const POLL_MS = Number(process.env.CAL_POLL_MS || 60_000);
const SYNC_STATE = path.join(config.stateDir, "calendar-sync.json");

/** The account's own calendar is watched under the API alias, so pre-fan-out tokens stay valid. */
const PRIMARY_KEY = "primary";

interface CalSync {
  syncToken?: string;
}
/** account label -> calendar id (or "primary") -> sync cursor. */
type SyncState = Record<string, { syncToken?: string; calendars?: Record<string, CalSync> }>;

/**
 * The per-calendar cursor, migrating the old shape in place. Before the fan-out, state
 * was `{ [label]: { syncToken } }` — one token per account, minted against calendarId
 * "primary". That token is still valid for that calendar, so it moves under the
 * "primary" key instead of being thrown away (which would re-prime and, worse, could
 * re-announce). Exported for the regression test.
 */
export function calSyncSlot(state: SyncState, label: string, calendarId: string): CalSync {
  const acct = (state[label] ??= {});
  if (!acct.calendars) {
    acct.calendars = {};
    if (acct.syncToken) acct.calendars[PRIMARY_KEY] = { syncToken: acct.syncToken };
    delete acct.syncToken;
  }
  return (acct.calendars[calendarId] ??= {});
}

function loadState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: SyncState): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(SYNC_STATE, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

const selfEmail = new Map<string, string>(); // label -> primary calendar address

async function resolveSelfEmail(label: string): Promise<string> {
  const hit = selfEmail.get(label);
  if (hit) return hit;
  try {
    const res = await calendarClient(label).calendarList.list();
    const primary = (res.data.items ?? []).find((c) => c.primary);
    const email = (primary?.id ?? "").toLowerCase();
    if (email) selfEmail.set(label, email);
    return email;
  } catch {
    return "";
  }
}

function whenText(dt: calendar_v3.Schema$EventDateTime | undefined): string {
  if (!dt) return "";
  if (dt.date) return dt.date;
  if (!dt.dateTime) return "";
  try {
    return new Date(dt.dateTime).toLocaleString("en-US", {
      timeZone: calTz(),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return dt.dateTime;
  }
}

function peopleInfo(e: calendar_v3.Schema$Event, self: string): { others: string[]; needsResponse: boolean } {
  const others: string[] = [];
  let needsResponse = false;
  for (const a of e.attendees ?? []) {
    const email = (a.email ?? "").toLowerCase();
    if (!email) continue;
    if (email === self || a.self) {
      if (a.responseStatus === "needsAction") needsResponse = true;
    } else {
      others.push(a.displayName || a.email || "");
    }
  }
  const organizerOther = !!e.organizer?.email && e.organizer.email.toLowerCase() !== self;
  if (organizerOther && e.organizer?.email && !others.includes(e.organizer.email)) {
    others.push(e.organizer.displayName || e.organizer.email);
  }
  return { others, needsResponse };
}

/** Decide whether a changed event is worth pinging the owner, and build the facts brief. */
function briefFor(
  e: calendar_v3.Schema$Event,
  label: string,
  self: string,
  calendarName = "",
): string | null {
  if (isSelfChange(e.id, label)) return null; // they (or the agent for them) just made this

  // Name the account AND (when it isn't their own) the calendar — with the fan-out, "a new
  // invite" can now come from Meetings or a shared calendar, and which one is the story.
  const parts = [label !== primaryLabel() ? `${label} account` : "", calendarName ? `${calendarName} calendar` : ""].filter(Boolean);
  const tag = parts.length ? `inbox: ${parts.join(", ")}` : "";

  if (e.status === "cancelled") {
    if (!e.summary) return null; // bare cancellation record with no title — not nameable
    return [
      "A calendar event was CANCELLED.",
      `title: ${e.summary}`,
      whenText(e.start) ? `was: ${whenText(e.start)}` : "",
      tag,
      e.htmlLink ? `links:\n📅 ${e.htmlLink}` : "",
    ].filter(Boolean).join("\n");
  }

  const { others, needsResponse } = peopleInfo(e, self);
  if (!others.length && !needsResponse) return null; // solo personal event they manage themselves

  const created = e.created ? Date.parse(e.created) : 0;
  const updated = e.updated ? Date.parse(e.updated) : 0;
  const isNew = created && updated && Math.abs(updated - created) < 5000;
  const verb = needsResponse ? "A new calendar INVITE" : isNew ? "A new calendar event" : "A calendar event changed";

  return [
    `${verb}${needsResponse ? " (needs your RSVP)" : ""}.`,
    `title: ${e.summary || "(no title)"}`,
    whenText(e.start) ? `when: ${whenText(e.start)}` : "",
    e.location ? `where: ${e.location}` : "",
    others.length ? `with: ${others.join(", ")}` : "",
    tag,
    e.htmlLink ? `links:\n📅 ${e.htmlLink}` : "",
  ].filter(Boolean).join("\n");
}

async function listPage(
  label: string,
  params: calendar_v3.Params$Resource$Events$List,
): Promise<{ items: calendar_v3.Schema$Event[]; nextSyncToken?: string }> {
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const res = await calendarClient(label).events.list({ ...params, pageToken });
    items.push(...(res.data.items ?? []));
    nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return { items, nextSyncToken };
}

async function prime(label: string, calendarId: string, slot: CalSync, state: SyncState): Promise<void> {
  const { nextSyncToken } = await listPage(label, {
    calendarId,
    singleEvents: true,
    timeMin: new Date().toISOString(),
    maxResults: 250,
  });
  if (nextSyncToken) {
    slot.syncToken = nextSyncToken;
    saveState(state);
    log(`calendar sync primed [${label}/${calendarId}]`);
  }
}

/**
 * Which (calendar id, display name) pairs to watch for one account. CAL_CALENDAR_ID
 * pins it to one; otherwise every owner/writer calendar, with the account's own one
 * kept under the "primary" alias so its existing syncToken survives this change.
 */
async function watchList(label: string): Promise<{ id: string; name: string }[]> {
  if (CALENDAR_ID) return [{ id: CALENDAR_ID, name: "" }];
  try {
    return watchTargets(await listCalendars(label)).map((t) => ({
      id: t.primary ? PRIMARY_KEY : t.id,
      name: t.primary ? "" : t.summary,
    }));
  } catch (e) {
    warn(`calendar watch list failed [${label}], watching primary only: ${e}`);
    return [{ id: PRIMARY_KEY, name: "" }];
  }
}

async function tickCalendar(
  label: string,
  cal: { id: string; name: string },
  state: SyncState,
  self: string,
  transport: Transport,
  owner: string,
): Promise<void> {
  const slot = calSyncSlot(state, label, cal.id);
  if (!slot.syncToken) {
    // First sight of this calendar: take a cursor and announce nothing. A calendar
    // joining the watch list must not replay its existing events as "new".
    await prime(label, cal.id, slot, state);
    return;
  }

  let page: { items: calendar_v3.Schema$Event[]; nextSyncToken?: string };
  try {
    // Incremental request must match the initial sync's params (singleEvents) and must
    // NOT re-pass timeMin/orderBy — Google rejects those alongside a syncToken.
    page = await listPage(label, { calendarId: cal.id, singleEvents: true, syncToken: slot.syncToken });
  } catch (e: any) {
    if (e?.code === 410 || e?.response?.status === 410) {
      warn(`calendar syncToken expired [${label}/${cal.id}] — full resync`);
      slot.syncToken = undefined;
      saveState(state);
      return;
    }
    throw e;
  }

  if (page.nextSyncToken) {
    slot.syncToken = page.nextSyncToken;
    saveState(state);
  }

  // Any change this tick (including ones the agent made, which don't ping) means the
  // cached week-ahead agenda is stale — refresh it so the prompt context stays current.
  if (page.items.length) void refreshAgenda();

  for (const e of page.items) {
    if (inQuietHours()) break; // overnight changes fall to the morning brief
    const brief = briefFor(e, label, self, cal.name);
    if (!brief) continue;
    try {
      const note = await voiceProactive(brief, "calendar");
      if (note === PROACTIVE_SKIP) {
        log(`calendar: suppressed by context [${label}/${cal.id}] ${e.id}`);
        continue;
      }
      await deliverProactive(transport, owner, note);
      log(`calendar: notified [${label}/${cal.id}] ${e.id}`);
    } catch (err) {
      warn(`calendar notify failed [${label}/${cal.id}] ${e.id}: ${err}`);
    }
  }
}

async function tickAccount(
  label: string,
  state: SyncState,
  transport: Transport,
  owner: string,
): Promise<void> {
  const self = await resolveSelfEmail(label);
  // Sequential across calendars: this runs every 60s forever, so a burst of parallel
  // requests buys nothing and one calendar's failure must not abort the others.
  for (const cal of await watchList(label)) {
    try {
      await tickCalendar(label, cal, state, self, transport, owner);
    } catch (e) {
      warn(`calendar poller tick [${label}/${cal.id}]: ${e}`);
    }
  }
}

export function startCalendarPoller(transport: Transport, owner: string): void {
  const accounts = googleAccounts();
  if (!accounts.length) {
    log("calendar poller off (no accounts)");
    return;
  }
  const state = loadState();

  void (async function loop() {
    for (;;) {
      for (const a of accounts) {
        try {
          await tickAccount(a.label, state, transport, owner);
        } catch (e) {
          warn(`calendar poller tick [${a.label}]: ${e}`);
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();

  log(
    `calendar poller started (${accounts.length} account(s), ${CALENDAR_ID ? `calendar ${CALENDAR_ID}` : "all owner/writer calendars"}, every ${Math.round(POLL_MS / 1000)}s, sync)`,
  );
}
