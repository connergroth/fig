import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import * as cal from "./calendar";
import { notesForEvent } from "./calendar-notes";

function fmtEvent(e: cal.EventSummary): string {
  const who = e.attendees.length ? ` | with ${e.attendees.join(", ")}` : "";
  const where = e.location ? ` @ ${e.location}` : "";
  const meet = e.hangoutLink ? ` | meet: ${e.hangoutLink}` : "";
  const notes = notesForEvent(e.summary, e.location);
  const note = notes.length ? ` | note: ${notes.join("; ")}` : "";
  // Events on a SECONDARY calendar (e.g. Meetings) carry their calendar id, because
  // get/update/delete/rsvp against "primary" would 404 on them.
  const calTag = e.primaryCalendar === false && e.calendarId !== "primary" ? ` | cal: ${e.calendarId}` : "";
  // Times are already normalized to the owner's current zone in calendar.ts. The label is
  // spelled out so the zone is READ, not inferred from an offset that's easy to skim past.
  const zone = e.allDay ? "" : ` ${cal.tzLabel(e.start)}`;
  const when = e.allDay ? `${e.start} (all day)` : `${e.start} → ${e.end}${zone}`;
  return `[${e.account}] ${e.id} | ${when} | ${e.summary}${where}${who}${meet}${note}${calTag} | ${e.htmlLink}`;
}

/**
 * Google Calendar, as mcp__calendar__*. `delete` and notify-attendees writes route a 🔐
 * to the owner in permissions.ts — by TOOL NAME, so the gate holds wherever these are mounted.
 *
 * fig calls these HERSELF. They used to live behind a one-tool `mcp__calendar__ask`
 * specialist that opened a whole sub-query per question; that bought nothing ToolSearch
 * doesn't already buy (a deferred tool costs its name, not its schema) and cost an extra
 * LLM run plus the thing that actually hurt — fig saw the subagent's PROSE instead of the
 * tool's output, and a summary can't be re-examined when it's wrong.
 *
 * Reads span every account AND every calendar (calendarFanout.ts). The descriptions
 * say so explicitly because the previous primary-only behavior was invisible from the
 * outside — the tool returned "No events." and the agent relayed it as fact.
 */
export const calendarServerDef = defineServer({
  key: "calendar",
  kind: "direct",
  purpose: "the owner's Google Calendar across every account: read, find open slots, create/reschedule/delete, RSVP",
  exposure: "both",
  capabilities: [
    {
      name: "calendars",
      purpose: "list every calendar on every account",
      mutates: "read",
      description:
        "List the user's calendars across all accounts (id, name, which is primary, account label). You rarely need this: list/freebusy already span every calendar. Google's own holiday/birthday/week-number feeds appear here but are excluded from search.",
      input: {},
      handler: async () => {
        const cals = await cal.listCalendarsAll();
        return cals.map((c) => `[${c.account}] ${c.id}${c.primary ? " (primary)" : ""} — ${c.summary}`).join("\n");
      },
    },
    {
      name: "list",
      purpose: "list/search events across every account and calendar",
      mutates: "read",
      description:
        "List or search events across ALL accounts AND ALL of their calendars by default — including secondary ones like Meetings, where 1:1s and coffee chats live. You don't need to know which account or calendar an event is on; this finds it, so \"No events.\" is a real answer rather than a blind spot. Pass ISO timeMin/timeMax to bound the range. Returns one line per event: [account] id | time | title | location | attendees | cal: <calendar id, only when it's NOT the primary calendar> | link. Pass BOTH that [account] and any cal: id to get/update/delete/rsvp.",
      input: {
        time_min: z.string().optional().describe("ISO datetime lower bound"),
        time_max: z.string().optional().describe("ISO datetime upper bound"),
        q: z.string().optional().describe("free-text search; searched on every calendar, not just the primary one"),
        calendar_id: z.string().optional().describe("restrict to ONE calendar id; omit to search every calendar (the default)"),
        max: z.number().optional(),
        account: z.string().optional().describe("restrict to one account label; omit to search ALL accounts (the default)"),
      },
      handler: async (args) => {
        const events = await cal.searchEvents({
          timeMin: args.time_min,
          timeMax: args.time_max,
          q: args.q,
          calendarId: args.calendar_id,
          max: args.max,
          account: args.account,
        });
        if (!events.length) return "No events.";
        return events.map(fmtEvent).join("\n");
      },
    },
    {
      name: "get",
      purpose: "full detail of one event, and which calendar it turned up on",
      mutates: "read",
      description:
        "Get full details of one event. Pass the account and, for events list tagged with a cal: id, that calendar_id. With neither, it looks on the primary calendar and then hunts the account's other calendars, and reports where it found it.",
      input: { id: z.string(), calendar_id: z.string().optional(), account: z.string().optional() },
      handler: async (args) => {
        const found = await cal.getEventLocated(args.id, args.calendar_id, args.account);
        const e = found.event;
        const notes = notesForEvent(e.summary, e.location);
        const where = `(on [${found.account}] calendar ${found.calendarId})\n\n`;
        const prefix = notes.length ? `Fig's notes on this event: ${notes.join("; ")}\n\n` : "";
        return where + prefix + JSON.stringify(e, null, 2).slice(0, 4000);
      },
    },
    {
      name: "freebusy",
      purpose: "busy blocks in a range, across every calendar, for finding an open slot",
      mutates: "read",
      description:
        "Get busy blocks in a time range, to find open slots before scheduling. Spans every calendar on every account by default (a slot is only free if it's free on ALL of them, including Meetings). Returns one line per calendar.",
      input: {
        time_min: z.string().describe("ISO datetime"),
        time_max: z.string().describe("ISO datetime"),
        calendar_ids: z.array(z.string()).optional().describe("restrict to specific calendar ids; omit for all of them"),
        account: z.string().optional().describe("restrict to one account; omit for all accounts"),
      },
      handler: async (args) => {
        const fb = await cal.freeBusy({ timeMin: args.time_min, timeMax: args.time_max, calendarIds: args.calendar_ids, account: args.account });
        if (!fb.length) return "No calendars answered — treat this as unknown, not free.";
        return fb
          .map((c) => `[${c.account}] ${c.calendarId}: ${c.busy.length ? c.busy.map((b) => `${b.start}→${b.end}`).join(", ") : "free"}`)
          .join("\n");
      },
    },
    {
      name: "create",
      purpose: "create an event",
      mutates: "write",
      description:
        "Create an event. start/end are ISO datetimes (or YYYY-MM-DD with all_day). Set notify_attendees only when the user explicitly wants invites emailed — that emails real people, so the owner is asked to approve it.",
      input: {
        summary: z.string(),
        start: z.string(),
        end: z.string(),
        all_day: z.boolean().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        recurrence: z.string().optional().describe('single RRULE line, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO"'),
        add_meet: z.boolean().optional(),
        calendar_id: z.string().optional(),
        notify_attendees: z.boolean().optional(),
        account: z.string().optional().describe("which account to create it in (default primary)"),
      },
      handler: async (args) => {
        const e = await cal.createEvent({
          summary: args.summary,
          start: args.start,
          end: args.end,
          allDay: args.all_day,
          location: args.location,
          description: args.description,
          attendees: args.attendees,
          recurrence: args.recurrence,
          addMeet: args.add_meet,
          calendarId: args.calendar_id,
          notifyAttendees: args.notify_attendees,
          account: args.account,
        });
        return `Created: ${fmtEvent(e)}`;
      },
    },
    {
      name: "update",
      purpose: "update or reschedule an existing event",
      mutates: "write",
      description:
        "Update/reschedule an event. Only pass the fields you're changing. Pass calendar_id when list showed a cal: id for it. Set notify_attendees to email attendees about the change (the owner is asked to approve that).",
      input: {
        id: z.string(),
        summary: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        all_day: z.boolean().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        calendar_id: z.string().optional().describe("from list's cal: tag; omit and it locates the event first"),
        notify_attendees: z.boolean().optional(),
        account: z.string().optional().describe("the account the event is in (from list's [account]); default primary"),
      },
      handler: async (args) => {
        const e = await cal.updateEvent(
          args.id,
          {
            summary: args.summary,
            start: args.start,
            end: args.end,
            allDay: args.all_day,
            location: args.location,
            description: args.description,
            attendees: args.attendees,
          },
          { calendarId: args.calendar_id, notifyAttendees: args.notify_attendees, account: args.account },
        );
        return `Updated: ${fmtEvent(e)}`;
      },
    },
    {
      name: "delete",
      purpose: "delete/cancel an event",
      mutates: "write",
      description:
        "Delete/cancel an event. Pass calendar_id when list showed a cal: id for it. Destructive, so the owner is asked to approve.",
      input: {
        id: z.string(),
        calendar_id: z.string().optional().describe("from list's cal: tag; omit and it locates the event first"),
        notify_attendees: z.boolean().optional(),
        account: z.string().optional(),
      },
      handler: async (args) => {
        await cal.deleteEvent(args.id, { calendarId: args.calendar_id, notifyAttendees: args.notify_attendees, account: args.account });
        return `Deleted ${args.id}.`;
      },
    },
    {
      name: "rsvp",
      purpose: "answer an invitation",
      mutates: "write",
      description:
        "Respond to an invitation: accepted, declined, or tentative. Pass the account shown by list ([account]), and calendar_id if list showed a cal: id.",
      input: {
        id: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
        calendar_id: z.string().optional().describe("from list's cal: tag; omit and it locates the event first"),
        account: z.string().optional(),
      },
      handler: async (args) => {
        await cal.rsvp(args.id, args.response, args.calendar_id, args.account);
        return `RSVP'd ${args.response} to ${args.id}.`;
      },
    },
    {
      name: "quick_add",
      purpose: "create an event from a natural-language phrase",
      mutates: "write",
      description:
        'Create an event from natural language, e.g. "lunch with Sam Friday 12pm". Good for fast one-offs. Defaults to the primary account.',
      input: { text: z.string(), calendar_id: z.string().optional(), account: z.string().optional() },
      handler: async (args) => {
        const e = await cal.quickAdd(args.text, args.calendar_id, args.account);
        return `Created: ${fmtEvent(e)}`;
      },
    },
  ],
});

export const calendarServer = toSdkServer(calendarServerDef);
