import fs from "node:fs";
import path from "node:path";

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../core/config";
import { readOpenSection } from "../core/openSection";
import { getCachedAgenda } from "../google/agenda";
import { FIX_STALE_MS, getCachedLocation, humanizeAge } from "../location/store";
import { resolveOwnerTz } from "../location/timezone";

/**
 * Prompt and agent-config builder for the chat session. The live session machinery
 * lives in session.ts; this module just assembles the static system prompt, the
 * per-message dynamic preamble, and the specialist subagent definitions.
 *
 * The session is long-lived (streaming input), so its system prompt is frozen at
 * session start. Anything that needs to stay fresh (date, Pending.md, the email
 * taxonomy) is delivered per-message (messagePreamble) or read live by the agent,
 * not baked into the frozen prompt.
 */

// --- Session id persistence (survives daemon restarts) ---

function sessionFile(): string {
  return path.join(config.stateDir, "session.json");
}
/**
 * Bump when an SDK transcript created by an older build is unsafe to resume.
 *
 * Version 1 retires sessions created before lone-surrogate sanitization. Those
 * transcripts may already contain malformed reaction text; sanitizing the new
 * prompt cannot repair history the Claude SDK replays internally from `resume`.
 */
const SESSION_RECORD_VERSION = 1;
export const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h idle → fresh start

// Resuming an SDK session replays its ENTIRE transcript every turn, so an active
// day's session grows unbounded (one long day was measured at ~282k tokens). The
// 6h age check only bounds idle gaps, not size — so we ALSO roll over to a fresh
// session once the live context crosses this cap. The fresh session is reseeded
// with recentHistory()'s bounded combo, and the dropped tail stays grep-able under
// Conversations/. This caps per-turn cost (every turn after the 5-min cache TTL
// lapses re-bills the full context at 1.25x) without losing useful continuity.
export const SESSION_MAX_CONTEXT_TOKENS = Number(process.env.SESSION_MAX_CONTEXT_TOKENS || 150_000);

export interface PersistedSession {
  /** Compatibility gate for the SDK-owned transcript referenced by sessionId. */
  version: number;
  sessionId: string;
  /** When the record was last written (ms epoch) — i.e. the end of the most recent turn. */
  updatedAt: number;
  /**
   * The API's OWN reported input-context total for the most recent turn
   * (input + cache_creation + cache_read). The only real, non-estimated measure of how big
   * the live context actually is — everything else anyone computes about context size is a
   * heuristic. `core/contextReport.ts` reports it as the ground-truth anchor.
   */
  contextTokens: number;
}

/**
 * The persisted session record, as written by setSession(). Returns null when there's no
 * session file yet or it's unparseable — never throws, and applies no age/size policy (that's
 * loadSession's job below; the report wants the raw numbers even when they're stale).
 */
export function readSessionRecord(): PersistedSession | null {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
    if (!raw?.sessionId || !raw?.updatedAt) return null;
    return {
      version: typeof raw.version === "number" ? raw.version : 0,
      sessionId: String(raw.sessionId),
      updatedAt: Number(raw.updatedAt),
      contextTokens: typeof raw.contextTokens === "number" ? raw.contextTokens : 0,
    };
  } catch {
    return null;
  }
}

export function loadSession(): string | undefined {
  const rec = readSessionRecord();
  if (!rec) return undefined;
  // A stale SDK transcript cannot be sanitized from this process: `resume` makes
  // the SDK replay it before our new prompt boundary. Start fresh and reseed from
  // the bounded, sanitized Conversations log instead.
  if (rec.version !== SESSION_RECORD_VERSION) return undefined;
  if (Date.now() - rec.updatedAt >= SESSION_MAX_AGE_MS) return undefined; // idle too long
  if (rec.contextTokens >= SESSION_MAX_CONTEXT_TOKENS) {
    return undefined; // grown too big → roll over to a fresh, reseeded session
  }
  return rec.sessionId;
}

/**
 * Persist the live session id, its last-seen updated time, and the most recent
 * turn's total input-context size (input + cache-creation + cache-read), which
 * loadSession uses to decide a size rollover. contextTokens is preserved across
 * calls for the SAME id when omitted, and reset to 0 when the id changes (a new
 * session starts empty).
 */
export function setSession(id: string | undefined, contextTokens?: number): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    const file = sessionFile();
    if (!id) {
      fs.rmSync(file, { force: true });
      return;
    }
    let prevTokens = 0;
    if (contextTokens === undefined) {
      try {
        const prev = JSON.parse(fs.readFileSync(file, "utf8"));
        if (prev.sessionId === id && typeof prev.contextTokens === "number") prevTokens = prev.contextTokens;
      } catch {
        /* no prior state */
      }
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: SESSION_RECORD_VERSION,
        sessionId: id,
        updatedAt: Date.now(),
        contextTokens: contextTokens ?? prevTokens,
      }),
    );
  } catch {
    /* best-effort */
  }
}

// --- Static system prompt pieces ---

const HARNESS_RULES = [
  "operating facts for this channel:",
  "",
  "put [[split]] on its own line to start a new imessage; blank lines stay inside one bubble. default to one bubble, use short dashed lists inside it, and split only at a natural conversational beat. a bare url on its own line becomes its own bubble.",
  "",
  "there is no markdown renderer on this surface: [text](url) links, **bold**, # headers and tables arrive as literal characters. a link that matters goes bare on its own line; otherwise name the source in plain words.",
  "",
  "to show a gmail draft, put [[draft:<account>:<id>]] on its own line. it renders the saved draft exactly; never reconstruct it yourself.",
  "",
  "bare gmail urls are rewritten to open-email.cc; use [[email:<url>]] to force that for any email url. keep email links inline with their surrounding text.",
  "",
  "for a real multiple-choice decision, put [[poll: question | option one | option two]] on its own line. the owner sees options, not the question: explain the choice first and make every option self-explanatory. use normal text for yes/no or open questions.",
  "",
  "reactions arrive as [Reacted …] and threaded replies as [replying to …]. use ack({tapback: \"…\"}) for any emoji reaction, optionally with text; a lone mapped emoji final also becomes a tapback. emoji at the start of a sentence remains text.",
  "",
  "the owner sees only the final reply; intermediate narration and tool work are dropped. ack is the only early opener. use it only when a real wait warrants a brief natural beat; it may include a tapback, text, or both.",
  "",
  "put ((effectname)) in a bubble to send an effect. screen: confetti, fireworks, lasers, balloons, love, hearts, celebration, spotlight, echo. bubble: slam, loud, gentle, invisibleink.",
  "",
  "you run persistently on the owner's always-on mac mini. its shell, filesystem, and tools are yours; heartbeats and background work can run while they are away.",
  "",
  "edits to this repo's src/ hot-reload: the process auto-restarts to pick them up the moment the current turn finishes — never say a change is 'staged' or that the owner must restart anything. say 'done, goes live when this turn ends.' only env vars, mcp server config, and non-src config files need a real process restart. you cannot test the new code in the same turn that wrote it — 'can't verify til it restarts' is honest.",
  "",
  "the vault is your memory. read before assuming; file durable notes by judgment. System/Feedback/ records corrections, but behavior changes must also reach SOUL.md because it is not loaded.",
  "",
  "when the owner references an earlier conversation, search System/Conversations/ with recall_conversations before claiming not to remember. never grep it for recall; read a specific dated transcript only when you need that transcript.",
  "",
  "the Open sections of three lists load every turn: Pending is a passive watch, Todos is the owner's work, and Tasks is your work. route every live loop immediately. clear resolved Pending items, check off (never delete) Todos, and finish Tasks into Done with an outcome and report. park wanted-but-not-now items; delete dead ones.",
  "",
  "when the owner explains a confusing calendar event, add its one-line internal note to System/Reference/calendar-event-notes.md; it never changes their real calendar.",
  "",
  "attached files arrive as local paths. read them to inspect images, PDFs, and documents.",
  "",
  "ordinary filesystem and shell work is pre-approved; sensitive outward actions require approval. never handle employer-confidential, private-company, or work-account material unless the owner explicitly provides it for this task. career materials are normal territory.",
  "",
  "a direct image URL alone sends an inline photo. an existing local path alone sends that file as an attachment. use the direct file URL, never a containing webpage or a [file: …] transcript marker.",
  "",
  "apple maps links alone open in Maps: https://maps.apple.com/?daddr=<destination>&dirflg=d for directions (add &saddr=<origin> when needed), or https://maps.apple.com/?q=<search>. URL-encode inputs; use the location tool for a fresh or precise location.",
  "",
  "weather: use wttr.in (quick: ?format=3&u; forecast: ?u), defaulting to where they are. traffic/ETA uses mcp__maps__route. control Govee lights with mcp__lights__control. web exports use mcp__web_export__pull; capture a logged-in browser session if it asks. use mcp__pangram__detect only as evidence, never proof, and never send private Apple/work text to it.",
  "",
  "automation skills are absent from the visible skill list. to run one on request, read .claude/skills/<name>/SKILL.md and follow it.",
].join("\n");

const OPERATING = [
  "how you work:",
  "",
  "use tools and matching skills instead of guessing. inspect before editing, make targeted changes, and parallelize independent work.",
  "",
  "for links, use fetch_url for source content and WebFetch for a quick gist; use browse for X and pages that are blocked, javascript-rendered, login-walled, or thin after fetching. don't call a link unavailable before trying browse.",
  "",
  "mail and calendar are YOUR tools, not a delegation: mcp__mailsearch__find to find a message in any account or folder, mcp__gmail__* / mcp__outlook__* to read, draft or send, mcp__calendar__* to read or change the schedule. route authenticated UI/desktop work to browse. delegate coding to code by default; use codex only for an independent review. browse, code, and codex are async in live turns: do not report a handle as a result; scheduled runs block. check the job board before starting background work.",
  "",
  "a finished background job is a report you owe the owner — a new message from them landing in the same turn does not discharge it. they cannot see the job board; a result you quietly absorb is a result they never got.",
  "",
  "use mcp__image__generate for image generation or edits. use mcp__voice__call for business calls, sharing only minimum identity and never taking binding action. route signups and purchases through browse; never use the owner's money or mail. act decisively within the approval boundary.",
].join("\n");

function loadPersonality(): string {
  try {
    return fs.readFileSync(path.join(config.brainDir, "SOUL.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Specialist system prompts live in THIS repo (src/specialists/prompts/), not the vault.
 * They're live runtime config, not memory: each one describes the exact tool surface its
 * specialist is handed, so it has to change in the same commit as the tools. Split across two
 * repos, they drift: the tools change here while the brief still describes the old surface, and
 * the specialist is told about a capability it doesn't have.
 *
 * Resolved off config.repoRoot (same pattern as the fig-tools MCP command in tools/stdio.ts)
 * rather than __dirname or cwd: the daemon runs `tsx src/index.ts` from the repo root today,
 * but repoRoot survives both a cwd change and a hypothetical tsc build into dist/, where a
 * __dirname-relative path would look for .md files the compiler never copied.
 */
function readSpecialistPrompt(file: string): string {
  try {
    return fs.readFileSync(path.join(config.repoRoot, "src", "specialists", "prompts", file), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The actionable items under a list file's `## Open` heading. Reader lives in
 * core/openSection.ts — shared with the call surface, and the place where tombstone
 * comments and header prose get stripped so they can't tax every turn.
 */
const loadOpenSection = (relPath: string): string => readOpenSection(relPath);

/** Live grounding: current date/time + where it's working. Rebuilt into the prompt each turn. */
function envBlock(): string {
  const now = new Date();
  const tz = resolveOwnerTz();
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  const ownerName = process.env.OWNER_NAME?.trim() || "the owner";
  const lines = [
    "right now:",
    `- it's ${date}, ${time} (${tz}) where ${ownerName} is.`,
  ];
  // Ambient location (Find My, kept warm by the poller). Use it as the origin for
  // directions and "near me" without having to ask or fetch.
  const loc = getCachedLocation();
  if (loc) {
    const where = loc.address || `${loc.lat}, ${loc.lng}`;
    // Age off the DEVICE fix time (fixAt), not our poll time (at). If the phone stops
    // pushing, `at` stays fresh while `fixAt` freezes — reporting `at` is the exact lie
    // that presented a 3-day-old fix as "now". Fall back to `at` only if fixAt is absent.
    const fixMs = loc.fixAt ? new Date(loc.fixAt).getTime() : new Date(loc.at).getTime();
    const ageMs = Date.now() - fixMs;
    if (loc.fixAt && ageMs > FIX_STALE_MS) {
      lines.push(`- ${ownerName}'s last Find My fix was near ${where}, but it is ${humanizeAge(ageMs)} OLD — their phone likely stopped sharing, so do NOT treat this as where they are now. Re-check with the location tool before using it, and tell them if the feed's gone stale.`);
    } else {
      lines.push(`- ${ownerName} is currently near ${where} (Find My, ${humanizeAge(ageMs)} ago). use this as the origin for directions/"near me". for a fresh or precise fix, or someone else, use the location tool.`);
    }
  }
  // Ambient week-ahead calendar (kept warm by the agenda cache). It's grounding so you
  // already know their week without fetching — NOT something to recite or bring up. Only
  // mention an event if it's genuinely relevant to what they're asking; otherwise stay quiet
  // about it. For anything beyond this week, or to add/change events, use mcp__calendar__*.
  const agenda = getCachedAgenda();
  if (agenda) {
    lines.push(
      "",
      `${ownerName}'s week ahead — AMBIENT CONTEXT ONLY, read carefully how to use it:`,
      agenda,
      `this is here so you're not caught flat-footed if they ask about their schedule — it is NOT a prompt to talk about their calendar. do NOT surface, mention, or tack on upcoming events on your own, especially ones days out. it is wrong to end a message with "and you've got X thursday" when they didn't ask and it has nothing to do with what you were talking about — that's exactly the noise to avoid. only bring up an event when (a) they directly ask about their schedule, or (b) it's genuinely relevant to THIS conversation right now (e.g. they're making a plan that collides with it). otherwise stay completely silent about it. when in doubt, say nothing about the calendar.`,
    );
  }
  return lines.join("\n");
}

/**
 * A named piece of the composed prompt.
 *
 * The prompt is BUILT from these rather than the other way round: `buildStaticSystemPrompt()`
 * and `buildMessagePreamble()` are joins over the segment lists below, so anything that reaches
 * the model through them necessarily carries a label. That's what makes the context accounting
 * (`core/contextReport.ts`) a derivation instead of a second, hand-kept copy of the
 * composition — a new segment that nobody labels fails the equivalence test in
 * `core/contextReport.test.ts` rather than silently going unmeasured.
 */
export interface PromptSegment {
  label: string;
  text: string;
}

/**
 * How segments are joined into a prompt: one blank line between them. Preserved exactly as the
 * old inline `parts.push("", x)` / `join("\n")` composition produced it.
 */
const SEGMENT_JOIN = "\n\n";

/** Join labelled segments back into the prompt text they compose. */
export function joinSegments(segments: readonly PromptSegment[]): string {
  return segments.map((s) => s.text).join(SEGMENT_JOIN);
}

/**
 * The static, globally-cacheable prefix — identity line + SOUL.md voice + OPERATING +
 * HARNESS_RULES — as labelled segments. Byte-stable across turns within a session (SOUL is
 * re-read live, so an edit just re-caches from then on). In the WARM streaming session this is
 * the frozen system prompt, set once at session start; the per-turn grounding rides in
 * dynamicSegments() instead. In the cold one-shot path it's the cacheable prefix of
 * buildSystemPrompt().
 */
export function staticSegments(): PromptSegment[] {
  const ownerName = process.env.OWNER_NAME?.trim() || "the owner";
  const segments: PromptSegment[] = [
    {
      label: "identity line",
      text: `you are ${config.agentName}, ${ownerName}'s personal agent: a sharp, funny friend that lives in their phone, reached over imessage. everything below is who you actually are and how you work. there's no separate "assistant" underneath to fall back on, and no default helpful-bot tone to revert to. this is the whole thing.`,
    },
  ];
  const stableEnvironment = [`you're working in ${ownerName}'s vault at ${config.brainDir}. it's your memory and your home.`];
  if (config.agentmailAddress) {
    stableEnvironment.push(
      `your own email address is ${config.agentmailAddress} (AgentMail) — your persistent inbox; burner signups use fresh throwaway inboxes through browse.`,
    );
  }
  segments.push({ label: "stable environment", text: stableEnvironment.join("\n") });
  const personality = loadPersonality();
  if (personality) segments.push({ label: "SOUL.md (personality)", text: personality });
  segments.push({ label: "OPERATING", text: OPERATING });
  segments.push({ label: "HARNESS_RULES", text: HARNESS_RULES });
  return segments;
}

/** The static prefix as one string — exactly `staticSegments()` joined. */
export function buildStaticSystemPrompt(): string {
  return joinSegments(staticSegments());
}

/**
 * CLAUDE.md plus its recursive @imports, matching the project-instruction files the Claude
 * SDK loads from the vault. Codex does not understand CLAUDE.md, so its main-agent runtime
 * uses this same loader to keep Fig's owner/context contract provider-independent.
 */
export interface ProjectInstructionFile {
  rel: string;
  text: string;
}

const PROJECT_IMPORT_RE = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

export function loadProjectInstructions(): ProjectInstructionFile[] {
  const out: ProjectInstructionFile[] = [];
  const seen = new Set<string>();

  const visit = (file: string): void => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    out.push({ rel: path.relative(config.brainDir, abs) || path.basename(abs), text });
    for (const match of text.matchAll(PROJECT_IMPORT_RE)) {
      const target = match[1].replace(/\\ /g, " ").replace(/[.,;:)\]]+$/, "");
      const resolved = path.resolve(path.dirname(abs), target);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) visit(resolved);
    }
  };

  visit(path.join(config.brainDir, "CLAUDE.md"));
  return out;
}

/** Fig's complete provider-neutral main-agent instructions for the Codex runtime. */
export function buildCodexMainInstructions(): string {
  const project = loadProjectInstructions().map(
    ({ rel, text }) => `[project instructions: ${rel}]\n${text}`,
  );
  return [buildStaticSystemPrompt(), ...project, buildMessagePreamble()].filter(Boolean).join(SEGMENT_JOIN);
}

/**
 * The per-message dynamic grounding, as labelled segments — live date/time/location/agenda
 * (envBlock) plus the Open sections of the three running lists (Pending / Todos / Tasks). This
 * changes every turn (the clock alone), so it's NOT cached.
 *
 * Two delivery sites, same content: (1) the cold one-shot path puts it after the
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY as the uncacheable system-prompt suffix; (2) the warm
 * streaming session — whose system prompt is frozen at session start — prepends it to each
 * turn's user message so the grounding stays fresh across the long-lived session. Without
 * this, a warm session would answer with the date/location/agenda from whenever it booted.
 */
export function dynamicSegments(): PromptSegment[] {
  const ownerName = process.env.OWNER_NAME?.trim() || "the owner";
  const segments: PromptSegment[] = [{ label: "live grounding (date/location/agenda)", text: envBlock() }];
  const pending = loadOpenSection("Pending.md");
  if (pending) {
    segments.push({
      label: "Pending.md (Open)",
      text: `things you're currently tracking for ${ownerName} (Pending.md — your passive watch loops, nothing to DO, clear when resolved):\n${pending}`,
    });
  }
  const todos = loadOpenSection("Lists/Todos.md");
  if (todos) {
    segments.push({
      label: "Lists/Todos.md (Open)",
      text: `${ownerName}'s own todos (Lists/Todos.md — things THEY do; check off [x] when done, don't delete their items):\n${todos}`,
    });
  }
  const tasks = loadOpenSection("Tasks.md");
  if (tasks) {
    segments.push({
      label: "Tasks.md (Open)",
      text: `jobs ${ownerName} assigned YOU (Tasks.md — execute on your own cycles, then move to ## Done w/ outcome + report back):\n${tasks}`,
    });
  }
  return segments;
}

/** The per-message grounding as one string — exactly `dynamicSegments()` joined. */
export function buildMessagePreamble(): string {
  return joinSegments(dynamicSegments());
}

/**
 * The full system prompt for the COLD one-shot path (and the /btw background lane),
 * returned as a [static, BOUNDARY, dynamic] array so the SDK can prompt-cache the big
 * static prefix across turns. Composed from the two helpers above so the warm path (static
 * frozen + per-message preamble) and the cold path can never drift.
 */
export function buildSystemPrompt(): string[] {
  return [buildStaticSystemPrompt(), SYSTEM_PROMPT_DYNAMIC_BOUNDARY, buildMessagePreamble()];
}

// --- Mail triage subagents (src/mail/triage.ts, src/google/triage.ts) ---
//
// fig calls the mail tools herself now — the `mcp__email__ask` specialist that used to wrap
// them is gone. What still runs as its own scoped sub-query is TRIAGE: a bulk sweep whose
// raw output (hundreds of messages) has no business in the main context, and which never
// went through the specialist anyway. These two exports are its surface and its brief.

export const EMAIL_AGENT_TOOLS = [
  "mcp__gmail__accounts",
  "mcp__gmail__list",
  "mcp__gmail__get",
  "mcp__gmail__labels",
  "mcp__gmail__label",
  "mcp__gmail__archive",
  "mcp__gmail__mark_read",
  "mcp__gmail__save_attachments",
  "mcp__gmail__create_label",
  "mcp__gmail__rename_label",
  "mcp__gmail__delete_label",
  "mcp__gmail__trash",
  "mcp__gmail__draft",
  "mcp__gmail__send",
  "Read",
  "Write",
  "Edit",
  "Grep",
];

/**
 * The mail triage sub-query's system prompt. Just the base instructions — it reads
 * email-labels.md and notify-rules.md live (those files are the source of truth),
 * so editing them takes effect without restarting the (frozen) chat session.
 */
export function emailSystemPrompt(): string {
  return readSpecialistPrompt("email-agent.md");
}

// --- Specialist prompts (each specialist runs as its own scoped sub-query; see src/specialists/) ---

export function browserSystemPrompt(): string {
  return readSpecialistPrompt("browser-agent.md");
}
