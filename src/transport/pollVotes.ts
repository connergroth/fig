/**
 * Native-poll vote detection.
 *
 * An Apple Messages poll VOTE is not a normal message and not a tapback — it's a
 * balloon-plugin update row in chat.db (`balloon_bundle_id` = …Polls, and
 * `associated_message_type` = 4000) that the `imsg watch` stream doesn't surface. So we
 * poll chat.db directly for new vote rows and turn each into an InboundMessage the agent
 * reads, closing the loop on a poll fig sent (approve/hold, pick-an-angle, a/b wording).
 *
 * Everything needed is already in the db — no send-time bookkeeping:
 *  - the vote row's payload embeds a `data:,<base64-json>` blob → the chosen option
 *    UUID(s) + the voter's handle
 *  - the vote's `associated_message_guid` joins to the ORIGINAL poll row, whose payload
 *    embeds the poll title + every option's UUID→text — so a vote's UUID resolves to the
 *    human option text with one self-join.
 *
 * We only surface votes on polls fig itself created (parent `is_from_me = 1`).
 */

import { spawn } from "node:child_process";

const US = "\x1f"; // field separator
const RS = "\x1e"; // record separator

/** Pull the first `data:,<base64>` JSON blob out of a hex-encoded bplist payload. */
function decodePayloadJson<T>(hexPayload: string): T | null {
  if (!hexPayload) return null;
  let latin1: string;
  try {
    latin1 = Buffer.from(hexPayload, "hex").toString("latin1");
  } catch {
    return null;
  }
  const m = latin1.match(/data:,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

interface VotePayload {
  item?: { votes?: Array<{ voteOptionIdentifier?: string; participantHandle?: string }> };
}
interface PollDefPayload {
  item?: { title?: string; orderedPollOptions?: Array<{ optionIdentifier?: string; text?: string }> };
}

export interface PollVote {
  /** guid of the vote row — used as the InboundMessage id (dedup). */
  guid: string;
  /** Voter handle (E.164 / email). */
  from: string;
  /** The poll's question. */
  question: string;
  /** Human text of the option(s) the voter currently has selected (empty = cleared). */
  chosen: string[];
  rowId: number;
}

/**
 * Run a read-only sqlite3 query. Returns the raw stdout on success, or `null` on any
 * failure (spawn error, non-zero exit, timeout-kill). Returning null — distinct from an
 * empty string — lets callers tell a genuinely-empty result apart from a read that never
 * completed, which is the whole reason poll-vote seeding used to silently wedge. On failure
 * we log via `onErr` instead of swallowing it, so a broken sweep is never invisible again.
 */
function runSqlite(
  dbPath: string,
  sql: string,
  onErr?: (msg: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "/usr/bin/sqlite3",
        ["-readonly", "-noheader", "-separator", US, "-newline", RS, dbPath, sql],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      onErr?.(`sqlite3 spawn threw: ${e}`);
      resolve(null);
      return;
    }
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, 8000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      onErr?.(`sqlite3 error: ${e}`);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        onErr?.("sqlite3 timed out (8s) — chat.db busy/locked");
        resolve(null);
      } else if (code !== 0) {
        onErr?.(`sqlite3 exit ${code}: ${err.trim().slice(0, 200) || "(no stderr)"}`);
        resolve(null);
      } else {
        resolve(out);
      }
    });
  });
}

/**
 * Current MAX(ROWID) of the message table. Returns `null` if the read failed (so the caller
 * can retry rather than mistaking a failure for an empty db).
 */
export async function currentMaxRowId(
  dbPath: string,
  onErr?: (msg: string) => void,
): Promise<number | null> {
  const raw = await runSqlite(dbPath, "SELECT COALESCE(MAX(ROWID),0) FROM message;", onErr);
  if (raw === null) return null;
  return Number(raw.trim()) || 0;
}

/**
 * New poll votes with ROWID > `sinceRowId`, on polls fig created, resolved to option text.
 * Returns rows in ascending ROWID order; the caller advances its cursor to the last rowId.
 */
export async function fetchNewPollVotes(
  dbPath: string,
  sinceRowId: number,
  onErr?: (msg: string) => void,
): Promise<PollVote[] | null> {
  const sql =
    "SELECT v.guid, hex(v.payload_data), hex(p.payload_data), COALESCE(h.id,''), v.ROWID " +
    "FROM message v " +
    "JOIN message p ON p.guid = v.associated_message_guid AND p.is_from_me = 1 " +
    "LEFT JOIN handle h ON h.ROWID = v.handle_id " +
    "WHERE v.balloon_bundle_id LIKE '%Polls%' " +
    "AND v.associated_message_type = 4000 AND v.is_from_me = 0 " +
    `AND v.ROWID > ${Math.floor(sinceRowId)} ` +
    "ORDER BY v.ROWID ASC;";
  const raw = await runSqlite(dbPath, sql, onErr);
  if (raw === null) return null; // read failed — caller must not treat as "no votes"
  if (!raw.trim()) return [];

  const votes: PollVote[] = [];
  for (const rec of raw.split(RS)) {
    if (!rec) continue;
    const [guid, vhex, phex, handle, rowId] = rec.split(US);
    if (!guid) continue;
    const votePay = decodePayloadJson<VotePayload>(vhex);
    const pollDef = decodePayloadJson<PollDefPayload>(phex);
    if (!votePay || !pollDef) continue;

    const optMap = new Map<string, string>();
    for (const o of pollDef.item?.orderedPollOptions ?? []) {
      if (o.optionIdentifier) optMap.set(o.optionIdentifier, o.text ?? "");
    }
    const rows = votePay.item?.votes ?? [];
    const from = (handle || rows[0]?.participantHandle || "").trim();
    const chosen = rows
      .map((r) => (r.voteOptionIdentifier ? optMap.get(r.voteOptionIdentifier) : undefined))
      .filter((t): t is string => !!t);

    votes.push({
      guid,
      from,
      question: pollDef.item?.title ?? "",
      chosen,
      rowId: Number(rowId) || 0,
    });
  }
  return votes;
}

/**
 * Extract the plain text from a `streamtyped` NSAttributedString blob — chat.db's
 * `attributedBody` column. On modern macOS the `message.text` column is NULL for essentially
 * all sent messages and the real body lives only here, so resolving reply context off an old
 * message requires decoding this blob.
 *
 * Minimal + defensive by design: it anchors on the `NSString`/`NSMutableString` class token,
 * finds the `+` (0x2b) marker that introduces the string payload, reads the typedstream
 * variable-length count (single byte, or 0x81/0x82 → 2/4-byte LE follow-up), and slices out
 * that many UTF-8 bytes. ANY parse failure (bad hex, missing anchor, length past end) returns
 * "" and it never throws — a weird blob just degrades to "no reply text", never a crash.
 *
 * @param hex hex-encoded blob (from sqlite `hex(attributedBody)`), or "" when the column was NULL.
 */
export function decodeAttributedBody(hex: string): string {
  if (!hex) return "";
  try {
    const buf = Buffer.from(hex, "hex");
    if (!buf.length) return "";
    // Anchor on the class token that precedes the body text. NSMutableString first (mutable
    // messages), then NSString. Neither is a substring of the NSAttributedString wrapper
    // class name, so this finds the actual string object, not the archive header.
    let anchor = buf.indexOf("NSMutableString", 0, "latin1");
    if (anchor === -1) anchor = buf.indexOf("NSString", 0, "latin1");
    if (anchor === -1) return "";
    // The string payload is introduced by a `+` (0x2b) marker after the class name.
    const plus = buf.indexOf(0x2b, anchor);
    if (plus === -1 || plus + 1 >= buf.length) return "";
    // typedstream length: one byte, or a 0x81/0x82 tag → 2/4-byte little-endian follow-up.
    let len = buf[plus + 1];
    let textStart = plus + 2;
    if (len === 0x81) {
      if (textStart + 2 > buf.length) return "";
      len = buf.readUInt16LE(textStart);
      textStart += 2;
    } else if (len === 0x82) {
      if (textStart + 4 > buf.length) return "";
      len = buf.readUInt32LE(textStart);
      textStart += 4;
    }
    if (len <= 0 || textStart + len > buf.length) return "";
    return buf.toString("utf8", textStart, textStart + len);
  } catch {
    return "";
  }
}

/** The resolved threaded-reply target for one inbound message. */
export interface ReplyTarget {
  /** guid of the earlier message this one replied to. */
  originator: string;
  /**
   * Plain text of that replied-to message, resolved from chat.db. Because the `text` column
   * is NULL for essentially all sent messages on modern macOS, this is resolved as
   * `decode(attributedBody) || text` — the streamtyped blob is preferred and the `text`
   * column is the fallback. May still be null when neither yields text (e.g. an
   * attachment-only bubble); callers can layer their own decoded cache on top of this.
   */
  text: string | null;
  /** True when the replied-to message was sent by us (is_from_me = 1). */
  fromMe: boolean;
}

/**
 * Read the TRUE threaded-reply target for a batch of message guids straight from chat.db.
 *
 * When the owner sends an iMessage inline reply, chat.db stamps that message's
 * `thread_originator_guid` with the GUID of the message they replied to; a normal (non-reply)
 * message leaves it NULL. That column is the only clean signal — the `imsg watch` stream
 * carries no reply field at all, and imsg's own `reply_to_guid` is fabricated (stamped on
 * nearly every row), so we go to the db directly, mirroring the poll-vote reader's exact
 * sqlite access path (same `runSqlite` helper, same read-only driver). A self-join onto the
 * originator row also pulls its text + is_from_me so callers can render "what they replied to".
 *
 * Returns a Map of inbound-guid → {originator, text, fromMe} for ONLY the rows that are
 * genuine replies (NULL/empty originators are omitted). Returns `null` if the read failed (so
 * the caller can treat "lookup unavailable" distinctly and just fall back to non-reply
 * routing) and an empty Map when none of the guids were replies. Never throws.
 */
export async function fetchReplyTargets(
  dbPath: string,
  guids: string[],
  onErr?: (msg: string) => void,
): Promise<Map<string, ReplyTarget> | null> {
  // Only UUID-shaped guids are ever real message guids; filtering here doubles as an
  // injection guard since we inline the list into the SQL (sqlite3 CLI can't bind params).
  const safe = [...new Set(guids)].filter((g) => /^[A-Za-z0-9-]{8,}$/.test(g));
  if (!safe.length) return new Map();
  const inList = safe.map((g) => `'${g}'`).join(",");
  // Pull `hex(o.attributedBody)` in the SAME query as the text column: on modern macOS the
  // `text` column is NULL for essentially all sent messages, so the reply text has to be
  // decoded from the streamtyped blob — one query, no second round-trip.
  const sql =
    "SELECT m.guid, m.thread_originator_guid, COALESCE(o.text,''), COALESCE(hex(o.attributedBody),''), COALESCE(o.is_from_me,0) " +
    "FROM message m LEFT JOIN message o ON o.guid = m.thread_originator_guid " +
    `WHERE m.guid IN (${inList}) ` +
    "AND m.thread_originator_guid IS NOT NULL AND m.thread_originator_guid != '';";
  const raw = await runSqlite(dbPath, sql, onErr);
  if (raw === null) return null; // read failed — caller must not treat as "no replies"
  const out = new Map<string, ReplyTarget>();
  if (!raw.trim()) return out;
  for (const rec of raw.split(RS)) {
    if (!rec) continue;
    const [guid, originator, text, attrHex, fromMe] = rec.split(US);
    if (!guid || !originator) continue;
    // Prefer the decoded attributedBody (the real source on modern macOS), fall back to the
    // `text` column for older rows that still populate it.
    const resolved = decodeAttributedBody(attrHex) || text || "";
    out.set(guid, { originator, text: resolved || null, fromMe: fromMe === "1" });
  }
  return out;
}

/** Render a vote as the bracketed line the agent reads (mirrors the [Reacted …] shape). */
export function renderVote(v: PollVote): string {
  const q = v.question.replace(/\s+/g, " ").trim().slice(0, 100);
  if (!v.chosen.length) return `[Cleared their vote on your poll "${q}"]`;
  const picks = v.chosen.map((c) => `"${c}"`).join(" + ");
  return `[Voted ${picks} on your poll "${q}"]`;
}
