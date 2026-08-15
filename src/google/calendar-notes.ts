import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";

/**
 * Fig's own internal notes about calendar events — context it keeps so it reads
 * confusing/recurring/auto-created events correctly ("that DEN→SAN flight is my
 * brother visiting, I'm not traveling"; "that product review I usually skip").
 *
 * These live ONLY in the vault, never on the real Google Calendar — the auto email→
 * calendar events get regenerated, so a description written there would be wiped, and
 * we don't want bot notes cluttering the actual calendar. Notes are KEYWORD-matched
 * against the event title/location (not by id), so one note covers a whole recurring
 * series and survives auto-events being re-synced under a new id.
 *
 * The agent maintains the file as plain markdown; the parser reads `- <match> :: <note>`
 * lines under the "## notes" heading. Merged inline wherever events are shown (the
 * ambient week agenda + the calendar tools).
 */

const NOTES_PATH = path.join(config.brainDir, "System", "Reference", "calendar-event-notes.md");

const SEED = `# Calendar event notes

Fig's internal context about confusing, recurring, or auto-created calendar events,
so it reads them correctly. These live ONLY here — they never touch the real Google
Calendar (and so can't be overwritten when auto events re-sync).

Format: under "## notes", one per line:  \`- <match> :: <note>\`
- <match> = distinctive text Fig looks for in the event's title or location
  (case-insensitive substring). Use a route, a flight number, or the event title.
- <note>  = the context Fig should know.
Example (not a real entry): "- Denver to Seattle :: a friend flying in to visit, I'm not traveling"

## notes
`;

interface CalNote {
  match: string; // lowercased substring to find in the event title/location
  note: string;
}

let cache: { mtimeMs: number; notes: CalNote[] } | null = null;

/** Create the notes file (with a documented header) if it doesn't exist yet. */
export function ensureNotesFile(): void {
  try {
    if (!fs.existsSync(NOTES_PATH)) {
      fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
      fs.writeFileSync(NOTES_PATH, SEED);
    }
  } catch {
    /* best-effort */
  }
}

function loadNotes(): CalNote[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(NOTES_PATH);
  } catch {
    return []; // no file yet
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.notes;

  const notes: CalNote[] = [];
  try {
    const lines = fs.readFileSync(NOTES_PATH, "utf8").split("\n");
    let inNotes = false;
    for (const raw of lines) {
      if (/^##\s+notes\b/i.test(raw.trim())) {
        inNotes = true;
        continue;
      }
      if (!inNotes) continue;
      // `- <match> :: <note>` — split on the FIRST " :: " so notes can contain colons.
      const m = raw.match(/^\s*-\s*(.+?)\s*::\s*(.+?)\s*$/);
      if (m && m[1] && m[2]) notes.push({ match: m[1].toLowerCase(), note: m[2].trim() });
    }
  } catch {
    /* ignore parse errors — just return what we have */
  }
  cache = { mtimeMs: stat.mtimeMs, notes };
  return notes;
}

/** Notes whose keyword appears in this event's title/location. */
export function notesForEvent(summary?: string | null, location?: string | null): string[] {
  const hay = `${summary ?? ""} ${location ?? ""}`.toLowerCase();
  if (!hay.trim()) return [];
  return loadNotes()
    .filter((n) => n.match && hay.includes(n.match))
    .map((n) => n.note);
}
