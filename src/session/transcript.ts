import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { warn } from "../core/log";
import { scheduleEmbedPending } from "../memory/brainIndex";
import { CONVERSATIONS_RELDIR, indexConversationFile } from "../memory/conversationSource";
import { resolveOwnerTz } from "../location/timezone";
import { toWellFormedUnicode } from "../core/unicode";

/**
 * Append-only conversation log. Every inbound and outbound message is written to a
 * dated file under the vault's System/Conversations/ directory. This is the raw recall
 * layer (the Poke chat-index equivalent): when the owner references something from
 * earlier that isn't in the agent's current session context, it searches this log
 * with the `recall_conversations` tool (hybrid keyword + vector) to resolve it —
 * NOT with grep, which a PreToolUse hook denies here. Curated, durable facts are a
 * separate layer the agent promotes into the owner.md / topic notes by judgment.
 *
 * The daemon writes here (mechanical, must happen every message); the agent only
 * ever reads it, via its normal file tools.
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Wall-clock components of an instant in the owner's timezone (derived from Find
 * My). The log is the owner's recall, so every line must be stamped in THEIR local
 * time — otherwise a box one zone east writes "[00:03]" for a message they sent at
 * 11:03pm, and a future read of the transcript lands an hour off.
 * Falls back to the machine zone when there's no location fix.
 */
function ownerParts(d: Date): { dateStr: string; timeLabel: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveOwnerTz(),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // hour12:false emits "24" at midnight in some environments
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    timeLabel: `${pad(hour)}:${get("minute")}`,
  };
}

function dayFilePath(d: Date): string {
  // Dated logs live in monthly subfolders (System/Conversations/YYYY-MM/YYYY-MM-DD.md)
  // so it doesn't grow unbounded flat. mkdirSync in append() creates the month dir.
  const { dateStr } = ownerParts(d);
  const month = dateStr.slice(0, 7); // YYYY-MM
  return path.join(config.brainDir, CONVERSATIONS_RELDIR, month, `${dateStr}.md`);
}

function timeLabel(d: Date): string {
  return ownerParts(d).timeLabel;
}

/**
 * Keep the brain index (src/memory/brainIndex) in step with the file we just
 * appended to, so `recall_conversations` can find a message the moment it lands
 * instead of only after the next full rebuild.
 *
 * Deliberately swallows everything: the index is a rebuildable cache, and a broken
 * one must never break message delivery. Worst case it goes stale and
 * `npm run index:brain` fixes it.
 *
 * The keyword half is SYNCHRONOUS and stays that way — it's ~20ms and it's what makes
 * a message findable the instant it lands. Embedding the new chunk is ~300ms of ONNX,
 * so it's kicked off in the background instead of being awaited here: the write path
 * doesn't get a third of a second slower to populate something nobody is reading yet.
 * The vector shows up a moment later; until it does, that one message is findable by
 * keyword but not by paraphrase.
 */
function indexAppended(file: string): void {
  try {
    indexConversationFile(file);
    scheduleEmbedPending();
  } catch (e) {
    warn(`conversation index update failed for ${path.basename(file)}: ${e instanceof Error ? e.message : e}`);
  }
}

function append(speaker: string, text: string, bg = false): void {
  const clean = toWellFormedUnicode(text)
    .replace(/\s*\n+\s*/g, " ")
    // Neutralize wikilink syntax so fig's internal delivery tokens
    // ([[split]]/[[poll:…]]/[[draft:…]]/[[email:…]]) and any user-typed [[…]]
    // don't land in the vault as Obsidian wikilinks and pollute the graph.
    // Wrap in inline code rather than strip: Obsidian ignores [[…]] inside
    // backticks, so the backlink dies while the literal token text is preserved
    // (these lines are often *about* the tokens, not just leaked noise).
    .replace(/(?<!`)\[\[([^\]]*?)\]\](?!`)/g, "`[[$1]]`")
    .trim();
  if (!clean) return;

  const now = new Date();
  const file = dayFilePath(now);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = fs.existsSync(file)
      ? ""
      : `# ${path.basename(file, ".md")}\n\n`;
    // A `/bg` (ephemeral-branch) turn tags its speaker with a `[bg]` suffix —
    // "<owner>[bg]" / "<agent>[bg]" — so the directional reseed filter (recentHistory)
    // can keep these out of the MAIN context while a bg run still sees them. The
    // lines stay in the same dated file (greppable, nothing lost), just marked.
    const label = bg ? `${speaker}[bg]` : speaker;
    fs.appendFileSync(file, `${header}[${timeLabel(now)}] ${label}: ${clean}\n`);
    indexAppended(file);
  } catch {
    // Logging must never break the message loop.
  }
}

function ownerLabel(): string {
  return process.env.OWNER_NAME?.trim() || "owner";
}

export function logInbound(text: string, opts?: { bg?: boolean }): void {
  append(ownerLabel(), text, opts?.bg);
}

export function logOutbound(text: string, opts?: { bg?: boolean }): void {
  append(config.agentName, text, opts?.bg);
}

/**
 * A VOICE CALL transcript line (the FaceTime call lane, src/call/). Speaker is
 * tagged `…[call]` — "<owner>[call]" / "<agent>[call]" — so the log says how the
 * exchange happened. Unlike `[bg]`, call lines are NOT filtered out of a main
 * reseed: a call is a real owner↔agent conversation and the next text turn should
 * remember it. Written live as each line lands (so a crashed session still leaves
 * its partial transcript), with a digest line at call end via logCallDigest.
 */
export function logCallLine(speaker: "owner" | "fig", text: string): void {
  append(speaker === "owner" ? `${ownerLabel()}[call]` : `${config.agentName}[call]`, text);
}

/** One mechanical end-of-call summary line from fig ("voice call ended — 2m14s, 8 turns"). */
export function logCallDigest(text: string): void {
  append(config.agentName, text);
}

/**
 * True when a log line is a `/bg` branch turn — its speaker segment is tagged
 * "…[bg]" (e.g. "[13:04] <owner>[bg]: …" / "[13:04] <agent>[bg]: …"). Matches the
 * speaker between the "] " and the first ": " and checks for the `[bg]` marker,
 * so a bare timestamp/speaker line never false-positives.
 */
function isBgLine(line: string): boolean {
  const m = line.match(/^\[\d{2}:\d{2}\]\s+([^:]+):/);
  return !!m && /\[bg\]\s*$/.test(m[1]);
}

// Seed policy for a fresh session (see recentHistory). The combo: always keep at
// least FLOOR most-recent messages, plus everything within the last WINDOW_H
// hours, capped at CEIL. So a quiet stretch still restarts warm, a busy day
// doesn't dump the whole thing back, and the rolled-off tail stays recoverable by
// grepping Conversations/ (that's the durable recall layer — we drop here, we
// don't summarize).
const SEED_FLOOR = Number(process.env.SESSION_SEED_FLOOR || 30);
const SEED_WINDOW_H = Number(process.env.SESSION_SEED_WINDOW_H || 12);
const SEED_CEIL = Number(process.env.SESSION_SEED_CEIL || 120);

/**
 * A bounded slice of the conversation log as plain "[HH:MM] speaker: text" lines,
 * used to seed a fresh agent session so it isn't starting cold after a restart, an
 * idle gap, or a size-driven rollover. Combo policy: at least SEED_FLOOR messages,
 * plus all messages within the last SEED_WINDOW_H hours, capped at SEED_CEIL.
 * Skips date headers and blanks. Anything older is still on disk under
 * Conversations/ for the agent to grep on demand.
 *
 * The `[bg]` filter is DIRECTIONAL. By default (`includeBg` falsy — what the MAIN
 * loop uses) every `/bg` branch line is stripped BEFORE the FLOOR/WINDOW/CEIL seed
 * math runs, so main's floor is a floor of REAL messages and the ephemeral branch
 * never bleeds back into main context on a reseed. A `/bg` run passes
 * `includeBg: true` so it inherits full main context AND prior bg turns — the
 * branch stays continuable across turns.
 */
export function recentHistory(opts?: { includeBg?: boolean }): string {
  const includeBg = opts?.includeBg ?? false;
  // Read enough day-files to cover the window (+1 for the across-midnight case).
  const days = Math.ceil(SEED_WINDOW_H / 24) + 1;
  const msgs: { ts: number; line: string }[] = [];
  for (let off = days - 1; off >= 0; off--) {
    const d = new Date();
    d.setDate(d.getDate() - off);
    let text: string;
    try {
      text = fs.readFileSync(dayFilePath(d), "utf8");
    } catch {
      continue;
    }
    for (const ln of text.split("\n")) {
      const t = ln.trim();
      if (!t || t.startsWith("# ")) continue;
      // Strip /bg branch turns from a MAIN reseed (before the window math, so the
      // floor isn't diluted by dropped lines). A bg run keeps them (includeBg).
      if (!includeBg && isBgLine(t)) continue;
      // Lines are "[HH:MM] speaker: text"; combine the time with the file's date
      // for a real timestamp so we can window by age.
      const m = t.match(/^\[(\d{2}):(\d{2})\]/);
      const dt = new Date(d);
      if (m) dt.setHours(Number(m[1]), Number(m[2]), 0, 0);
      msgs.push({ ts: dt.getTime(), line: t });
    }
  }
  if (!msgs.length) return "";
  const cutoff = Date.now() - SEED_WINDOW_H * 3_600_000;
  const withinWindow = msgs.filter((m) => m.ts >= cutoff).length;
  const count = Math.min(Math.max(withinWindow, SEED_FLOOR), SEED_CEIL, msgs.length);
  return msgs.slice(-count).map((m) => m.line).join("\n");
}

/**
 * The last `maxLines` conversation lines ("[HH:MM] speaker: text"), newest at the
 * bottom. A tight, cheap tail — used to give a one-shot proactive voicing pass just
 * enough live context to recognize "this email is the expected result of something
 * we just did" (a reset we triggered, a receipt for a purchase we made) so it can
 * suppress or contextualize the ping. Deliberately smaller than recentHistory() so
 * we don't pour the whole session into a per-email voicing on every notify.
 */
export function recentTail(maxLines = 16): string {
  const msgs: string[] = [];
  for (let off = 1; off >= 0; off--) {
    const d = new Date();
    d.setDate(d.getDate() - off);
    let text: string;
    try {
      text = fs.readFileSync(dayFilePath(d), "utf8");
    } catch {
      continue;
    }
    for (const ln of text.split("\n")) {
      const t = ln.trim();
      if (!t || t.startsWith("# ")) continue;
      msgs.push(t);
    }
  }
  return msgs.slice(-maxLines).join("\n");
}
