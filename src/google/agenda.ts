import { log, warn } from "../core/log";
import { googleAccounts } from "./accounts";
import { calTz, type EventSummary, listEventsAll } from "./calendar";
import { ensureNotesFile, notesForEvent } from "./calendar-notes";

/**
 * The week-ahead agenda, kept warm in a cache so it can be injected into the system
 * prompt as ambient context WITHOUT an API call on every turn. A background refresh
 * (interval + triggered by the calendar poller on any change) keeps it current; the
 * prompt just reads getCachedAgenda() synchronously.
 *
 * It's grounding, not a to-do list — the prompt tells the agent not to recite it.
 */

const REFRESH_MS = Number(process.env.AGENDA_REFRESH_MS || 15 * 60 * 1000);
const HORIZON_DAYS = 7;
const MAX_CHARS = 1800;

let cache: string | null = null;

export function getCachedAgenda(): string | null {
  return cache;
}

/** YYYY-MM-DD for a date in the agent's timezone (stable day-grouping key). */
function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: calTz() }); // en-CA → YYYY-MM-DD
}

function dayLabel(d: Date, todayKey: string, tomorrowKey: string): string {
  const k = dayKey(d);
  if (k === todayKey) return "Today";
  if (k === tomorrowKey) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: calTz() });
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: calTz() });
  } catch {
    return "";
  }
}

/** Group events under each day and render a compact, human week view. */
function render(events: EventSummary[], now: Date, multiAccount: boolean): string {
  const todayKey = dayKey(now);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowKey = dayKey(tomorrow);

  // Bucket events by their start day key.
  const byDay = new Map<string, string[]>();
  for (const e of events) {
    if (e.status === "cancelled") continue;
    const allDay = e.allDay || /^\d{4}-\d{2}-\d{2}$/.test(e.start);
    const key = allDay ? e.start.slice(0, 10) : dayKey(new Date(e.start));
    const time = allDay ? "all day" : fmtTime(e.start);
    const tag = multiAccount ? ` [${e.account}]` : "";
    const notes = notesForEvent(e.summary, e.location);
    const noteStr = notes.length ? ` — note: ${notes.join("; ")}` : "";
    const line = `${time} ${e.summary}${e.location ? ` @ ${e.location}` : ""}${tag}${noteStr}`.trim();
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(line);
  }

  const lines: string[] = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    const items = byDay.get(key) ?? [];
    // Always show today + tomorrow (even if clear); later days only when they have events.
    if (!items.length && i > 1) continue;
    const label = dayLabel(d, todayKey, tomorrowKey);
    lines.push(items.length ? `- ${label}: ${items.join("; ")}` : `- ${label}: clear`);
  }

  const body = lines.join("\n");
  return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS).trimEnd()}\n- …(more)` : body;
}

/** Refetch the week ahead across all accounts and rebuild the cached view. */
export async function refreshAgenda(): Promise<void> {
  if (!googleAccounts().length) return;
  const now = new Date();
  const timeMax = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);
  try {
    const events = await listEventsAll({ timeMin: now.toISOString(), timeMax: timeMax.toISOString(), max: 150 });
    cache = render(events, now, googleAccounts().length > 1);
  } catch (e) {
    warn(`agenda refresh failed: ${e}`);
  }
}

export function startAgendaRefresh(): void {
  if (!googleAccounts().length) return;
  ensureNotesFile(); // create System/Reference/calendar-event-notes.md (with its format header) if missing
  void refreshAgenda();
  setInterval(() => void refreshAgenda(), REFRESH_MS);
  log(`agenda cache started (week ahead, refresh ${Math.round(REFRESH_MS / 60000)}m)`);
}
