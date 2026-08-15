import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { getBrainIndex, type IngestDocument, type SourceAdapter, type SearchResult } from "./brainIndex";

/**
 * Ingest adapter for the iMessage conversation log
 * (`Conversations/YYYY-MM/YYYY-MM-DD.md`), plus the thin conversation-flavored view
 * of the generic index that `recall_conversations` renders.
 *
 * Everything conversation-specific lives here on purpose. The core index
 * (src/memory/brainIndex.ts) knows about documents and chunks and nothing else, so
 * the next corpus — email, Daily/, Meetings/, People/ — is a new file next to this
 * one rather than an edit to the core.
 *
 * The mapping call: ONE DOCUMENT PER MESSAGE, not per day file. Speaker and date
 * then become `documents.author` / `documents.created_at`, which are real columns
 * the search pre-filters on — so "what did the owner say about X in July" needs no
 * conversation-specific column bolted onto the generic tables. A per-file document
 * would have forced exactly that.
 */

export const CONVERSATION_SOURCE_TYPE = "conversation";

/** Where the transcripts live inside the vault. One owner for this path. */
export const CONVERSATIONS_RELDIR = "System/Conversations";

/** The two speakers of record, canonically. `documents.author` is written with these. */
export type Speaker = "owner" | "agent";

export interface ParsedMessage {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  ts: number; // unix seconds
  speaker: Speaker;
  text: string;
  lineno: number; // 1-based line in the source file
  ord: number; // 0-based position within the file — the stable half of source_id
}

const LOG_TZ = "America/Los_Angeles";

const HEADER_RE = /^#\s/;

/**
 * The lowercased label the transcript writer stamps on each side — the owner is
 * OWNER_NAME (generic "owner" when unset, matching transcript.ts's ownerLabel()),
 * the agent is AGENT_NAME. Read lazily, not at module load, so the vocabulary
 * tracks the live env (and tests can vary it without reloading the module).
 */
function ownerNameLc(): string {
  return (process.env.OWNER_NAME || "").trim().toLowerCase() || "owner";
}

function agentNameLc(): string {
  return config.agentName.trim().toLowerCase() || "bot";
}

/**
 * Every label that names a speaker of record, mapped onto the canonical pair.
 * Deliberately wider than the two labels the writer emits today: older transcripts
 * use the generic "owner" and "bot", and the live labels come from config — a
 * vocabulary that didn't track OWNER_NAME would silently eat every owner message
 * the moment someone ran this with their own name. Same two speakers either way,
 * so everything normalizes rather than getting dropped on the floor.
 */
function speakerAliases(): Record<string, Speaker> {
  return {
    owner: "owner",
    agent: "agent",
    bot: "agent",
    [ownerNameLc()]: "owner",
    [agentNameLc()]: "agent",
  };
}

/** The labels the recall speaker filter accepts: canonical pair + configured names. */
export function speakerFilterValues(): [string, ...string[]] {
  return Object.keys(speakerAliases()) as [string, ...string[]];
}

/** Canonicalize a speaker label ("owner"/"agent"/the configured names); undefined if unknown. */
export function resolveSpeaker(label: string): Speaker | undefined {
  return speakerAliases()[label.trim().toLowerCase()];
}

/**
 * Every `documents.author` value that can mean this speaker. New rows are written
 * with the canonical label, but rows indexed before the canonicalization store the
 * configured name that was live at write time — so reads accept both vocabularies
 * and an existing on-disk index keeps working without a rebuild.
 */
export function authorValues(speaker: Speaker): string[] {
  return [...new Set(speaker === "owner" ? ["owner", ownerNameLc()] : ["agent", "bot", agentNameLc()])];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A message line: `[HH:MM] speaker: text`, `[bg]` suffix marking ephemeral-branch
 * turns. The speaker alternation is built from speakerAliases() — see there for why
 * it is wider than the two labels the writer emits.
 */
function messageRe(): RegExp {
  const labels = Object.keys(speakerAliases()).map(escapeRe).join("|");
  return new RegExp(String.raw`^\[(\d{2}:\d{2})\]\s+(${labels})(\[bg\])?:\s?(.*)$`, "i");
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Local-minus-UTC offset in ms for `tz` at instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUTC - utcMs;
}

/** Wall-clock date+time in `tz` -> unix seconds. Refines once across DST boundaries. */
export function zonedToEpochSeconds(date: string, time: string, tz: string = LOG_TZ): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return 0;
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMs(guess, tz);
  let ms = guess - off1;
  const off2 = tzOffsetMs(ms, tz);
  if (off2 !== off1) ms = guess - off2;
  return Math.floor(ms / 1000);
}

/**
 * `documents.created_at` for a log line: full ISO-8601 with the zone offset, e.g.
 * `2026-07-01T09:15:00-07:00`.
 *
 * The offset matters because the log stamps wall-clock time only, and a bare
 * `2026-07-01T09:15` is a different instant in June than in December. Carrying the
 * offset makes created_at a real timestamp that sorts correctly against the future
 * email corpus (whose dates are RFC-822 with offsets), while the first ten chars are
 * still exactly the date — so date range filters stay plain indexed string compares.
 */
export function toCreatedAt(date: string, time: string, tz: string = LOG_TZ): string {
  const ts = zonedToEpochSeconds(date, time);
  if (!ts) return `${date}T${time}:00`;
  const offMin = Math.round(tzOffsetMs(ts * 1000, tz) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T${time}:00${sign}${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse one dated conversation file into messages.
 *
 * A new message starts on a messageRe() line. Any other non-header, non-blank line is
 * a continuation and gets appended to the message in progress with a newline. (The
 * live writer collapses newlines so continuations don't occur in practice today, but
 * these files are hand-editable and a stray wrapped line shouldn't vanish.)
 *
 * The date comes from the FILENAME, not the `# YYYY-MM-DD` header — the header is
 * cosmetic and the filename is what the writer keys off.
 */
export function parseConversationFile(filePath: string, content: string): ParsedMessage[] {
  const base = path.basename(filePath, ".md");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(base) ? base : "";
  if (!date) return [];

  const out: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;
  const lines = content.split("\n");
  const re = messageRe();
  const aliases = speakerAliases();

  const flush = () => {
    if (!current) return;
    current.text = current.text.trim();
    if (current.text) {
      current.ord = out.length;
      out.push(current); // skip empty messages
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = re.exec(line);
    if (m) {
      flush();
      const speaker = aliases[m[2].toLowerCase()];
      const time = m[1];
      current = {
        date,
        time,
        ts: zonedToEpochSeconds(date, time),
        speaker,
        text: m[4] ?? "",
        lineno: i + 1,
        ord: -1,
      };
      continue;
    }
    if (!current) continue; // preamble / header before any message
    if (HEADER_RE.test(line)) continue; // `# 2026-07-27` headers are not content
    current.text += `\n${line}`;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ConversationSourceOptions {
  conversationsDir?: string;
  /** Root the source_id/thread_id relpaths are computed against. Defaults to the
   *  parent of `conversationsDir`, which is right for a temp vault in tests. */
  vaultRoot?: string;
}

export interface ConversationSource extends SourceAdapter {
  readonly conversationsDir: string;
}

export function createConversationSource(opts: ConversationSourceOptions = {}): ConversationSource {
  const conversationsDir = opts.conversationsDir ?? path.join(config.brainDir, CONVERSATIONS_RELDIR);
  // thread_id has to be openable, so it is relative to the VAULT ROOT — not to the
  // folder holding the transcripts, which lives under System/.
  // A custom conversationsDir (tests) keeps the old parent-of behavior.
  const vaultRoot = opts.vaultRoot ?? (opts.conversationsDir ? path.dirname(opts.conversationsDir) : config.brainDir);

  /** Vault-relative path, POSIX separators — the stable half of source_id/thread_id. */
  const relpath = (filePath: string): string => path.relative(vaultRoot, filePath).split(path.sep).join("/");

  return {
    sourceType: CONVERSATION_SOURCE_TYPE,
    conversationsDir,

    /** Every dated conversation file, oldest first. */
    listFiles(): string[] {
      if (!fs.existsSync(conversationsDir)) return [];
      const out: string[] = [];
      for (const month of fs.readdirSync(conversationsDir).sort()) {
        const dir = path.join(conversationsDir, month);
        let st: fs.Stats;
        try {
          st = fs.statSync(dir);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          for (const f of fs.readdirSync(dir).sort()) {
            if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) out.push(path.join(dir, f));
          }
        } else if (/^\d{4}-\d{2}-\d{2}\.md$/.test(month)) {
          out.push(dir); // tolerate a flat layout
        }
      }
      return out;
    },

    owns(filePath: string): boolean {
      const rel = path.relative(conversationsDir, filePath);
      return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(filePath));
    },

    parseFile(filePath: string, content: string): IngestDocument[] {
      const rel = relpath(filePath);
      return parseConversationFile(filePath, content).map((m) => ({
        sourceId: `${rel}#${m.ord}`,
        uri: filePath,
        title: null,
        author: m.speaker,
        recipients: null,
        threadId: rel,
        labels: null,
        createdAt: toCreatedAt(m.date, m.time),
        text: m.text,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Conversation-flavored view over the generic index
// ---------------------------------------------------------------------------

export interface ConversationHit {
  date: string;
  time: string;
  speaker: string;
  snippet: string;
}

export interface ConversationSearchOptions {
  query: string;
  speaker?: Speaker;
  since?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
  limit?: number; // default 15, hard max 50
}

export interface ConversationSearchResult {
  results: ConversationHit[];
  totalHits: number;
  shown: number;
  droppedForBudget: number;
  matchQuery: string;
  /** "bm25" means the vector layer wasn't available and this is keyword-only. */
  retrieval?: "bm25" | "hybrid";
}

/**
 * Render an author value under the CURRENT names — the column carries whichever
 * vocabulary was live when the row was written (canonical now, the configured
 * names before), and one conversation shouldn't display under two labels.
 */
function displaySpeaker(author: string): string {
  const canon = speakerAliases()[author.toLowerCase()];
  if (!canon) return author;
  return canon === "owner" ? ownerNameLc() : agentNameLc();
}

function toConversationHits(res: SearchResult): ConversationSearchResult {
  return {
    results: res.results.map((h) => ({
      date: h.created_at?.slice(0, 10) ?? "",
      time: h.created_at?.slice(11, 16) ?? "",
      speaker: h.author ? displaySpeaker(h.author) : "",
      snippet: h.snippet,
    })),
    totalHits: res.totalHits,
    shown: res.shown,
    droppedForBudget: res.droppedForBudget,
    matchQuery: res.matchQuery,
    retrieval: res.retrieval,
  };
}

/**
 * Ranked, snippeted, budget-capped HYBRID search over the conversation log only.
 *
 * Async because the query has to be embedded before the vector half can run. That's
 * the only reason — the index itself is synchronous. If the embedding layer is
 * unavailable this still resolves, with keyword-only results and
 * `retrieval === "bm25"`; it does not reject.
 */
export async function searchConversationsDetailed(
  opts: ConversationSearchOptions,
): Promise<ConversationSearchResult> {
  return toConversationHits(
    await getBrainIndex().searchHybrid({
      query: opts.query,
      sourceTypes: [CONVERSATION_SOURCE_TYPE],
      author: opts.speaker ? authorValues(opts.speaker) : undefined,
      dateFrom: opts.since,
      dateTo: opts.until,
      k: opts.limit,
    }),
  );
}

export async function searchConversations(opts: ConversationSearchOptions): Promise<ConversationHit[]> {
  return (await searchConversationsDetailed(opts)).results;
}

/** Keyword-only search. Synchronous — no model, no await. Used by tests and tooling. */
export function searchConversationsKeyword(opts: ConversationSearchOptions): ConversationSearchResult {
  return toConversationHits(
    getBrainIndex().search({
      query: opts.query,
      sourceTypes: [CONVERSATION_SOURCE_TYPE],
      author: opts.speaker ? authorValues(opts.speaker) : undefined,
      dateFrom: opts.since,
      dateTo: opts.until,
      k: opts.limit,
    }),
  );
}

export interface RecallStats {
  messages: number;
  files: number;
  firstDate: string | null;
  lastDate: string | null;
  dbBytes: number;
  dbPath: string;
}

export function recallStats(): RecallStats {
  const s = getBrainIndex().stats();
  const c = s.bySourceType[CONVERSATION_SOURCE_TYPE];
  return {
    messages: c?.documents ?? 0,
    files: c?.files ?? 0,
    firstDate: c?.firstDate ?? null,
    lastDate: c?.lastDate ?? null,
    dbBytes: s.dbBytes,
    dbPath: s.dbPath,
  };
}

/** Incrementally index a single conversation file (used by the transcript writer). */
export function indexConversationFile(filePath: string): number {
  return getBrainIndex().indexFile(filePath);
}
