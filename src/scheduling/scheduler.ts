import fs from "node:fs";
import path from "node:path";

import { buildSystemPrompt, setSession } from "../session/agent";
import {
  isQuietOutput,
  isQuietSentinel,
  isValidProactiveOutput,
  OUTPUT_CONTRACT,
  type ProactiveContract,
  proactiveCorrection,
  sleep,
  stripMarkdown,
  unwrapOutput,
} from "../render/chunking";
import { pacedSend } from "../render/deliver";
import { config } from "../core/config";
import { withHeadlessAgentPass } from "../core/agentPassContext";
import { log, warn } from "../core/log";
import { resolveOwnerTz } from "../location/timezone";
import { proactiveOwnerTarget } from "../core/owner";
import { makeCanUseTool } from "../runtimes/permissions";
import { SURFACE_HOOKS } from "../runtimes/hooks";
import { buildScheduledMcpServers, disallowedToolsForLane, unattendedLaneProvidesTool } from "./lane";
import { takeDueReminders } from "./reminders";
import {
  DEGRADED_ERROR,
  declaresEmptyRequiredTools,
  declaresRequiredTools,
  degradationCount,
  degradedAlert,
  frontmatterField,
  missingRequiredTools,
  parseRequiredTools,
  recordDegradation,
  splitMissingByReachability,
  uncalledToolNote,
} from "./requiredTools";
import { SKILLS_DIR, skillProcedureBlock } from "./skillBody";
import type { ClaudeRuntimeOptions } from "../runtimes/claude";
import { runBrainTextResult } from "../runtimes/brain";
import type { TextRuntimeResult } from "../runtimes/runtime";
import { logOutbound, recentHistory } from "../session/transcript";
import type { Transport } from "../transport";
import {
  isExpired,
  loadWatches,
  markWatchFired,
  removeWatch,
  type Watch,
} from "./watches";
import {
  isDetectorExpired,
  loadDetectors,
  markDetectorChecked,
  markDetectorFired,
  removeDetector,
  setDetectorError,
  setDetectorValue,
  type Detector,
} from "./detectors";
import { PROBES } from "./probes";
import {
  isGoalExpired,
  loadGoals,
  markGoalPass,
  removeGoal,
  type Goal,
} from "./goals";
import {
  dueScheduledTasks,
  removeScheduledTask,
  type ScheduledTask,
} from "./scheduledTasks";

/**
 * The proactive scheduler. Ticks on an interval and, each tick, fires whatever is
 * due across six registries:
 *   1. Reminders — fixed-text pings (texts the owner).
 *   2. Scheduled tasks — durable one-off prompts run as a full agent pass.
 *   3. Scheduled skills — any skill that declares a `schedule:` in its SKILL.md
 *      frontmatter (the "each proactive thing is just a skill" shape: add a skill
 *      with e.g. `schedule: daily 7:00` and the scheduler invokes it).
 *   4. Watches — runtime-created dedicated check loops that self-prune.
 *   5. Detectors — cheap browser probes that only wake an agent pass on a diff.
 *   6. Goals — long-running objectives that do work each pass until a finish line.
 *
 * Skill/task/watch/detector/goal passes produce a message as their output,
 * which gets texted to the owner.
 */

const TICK_MS = 30_000;
const STATE_FILE = path.join(config.stateDir, "scheduler.json");
const denyApprovals = async () => false;

function minutesEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Headless scheduler/proactive passes may legitimately block on browser harvests for
// an hour+. Keep this configurable so heavy scheduled skills can finish in one pass
// without changing the short default used by ordinary Claude text runs.
const HEADLESS_AGENT_PASS_TIMEOUT_MS = minutesEnv("FIG_HEADLESS_AGENT_PASS_TIMEOUT_MINUTES", 90) * 60 * 1000;

// Hard per-pass WALL-CLOCK cap — the durable "one hung skill can't freeze the tick" fix.
// Distinct from HEADLESS_AGENT_PASS_TIMEOUT_MS above: that one is an IDLE watchdog inside
// the Claude runtime, refreshed on every stream message, so a pass that's actively churning
// (browser calls, tool calls) never trips it no matter how long it runs — exactly the failure
// where x-queue sat busy-stuck on X for 63min and, because the tick awaits each skill
// sequentially, froze every automation queued behind it. This is an ABSOLUTE ceiling on a
// single scheduled pass regardless of activity: once a pass runs this long we abort it (the
// AbortSignal threads down and cancels the underlying query) and the tick moves on. Applied at
// the shared chokepoint below, so it covers EVERY scheduled pass at once — skills, one-off
// tasks, watches, detectors, goals. Generous default (well above any legitimate skill runtime,
// well below the hour+ hang range); bump the env if a real harvest ever needs longer.
const SCHEDULED_PASS_WALL_CLOCK_MS = minutesEnv("FIG_SCHEDULED_PASS_WALL_CLOCK_MINUTES", 30) * 60 * 1000;

interface Schedule {
  kind: "daily" | "weekdays" | "weekly" | "interval" | "times";
  hour?: number;
  minute?: number;
  dayOfWeek?: number; // 0=Sun..6=Sat, for "weekly"
  times?: number[]; // "times" only: fixed clock slots as minutes-of-day, sorted asc — fires once per slot per day
  intervalMs?: number;
  windowStart?: number; // interval only: minutes-of-day, inclusive — fire only inside [start,end]
  windowEnd?: number;
  weekdaysOnly?: boolean; // interval only: skip Sat/Sun (e.g. "weekdays every 30m 16:00-18:00")
}

/** Day-of-week words → JS getDay() index (Sun=0). */
const DAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseSchedule(raw: string): Schedule | null {
  const s = raw.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  // Multiple fixed clock times: "daily 10:00,13:00,18:00" (comma-separated, fires once per slot per day).
  if ((m = s.match(/^daily\s+(\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2})+)$/))) {
    const times = m[1]
      .split(",")
      .map((t) => {
        const [h, mi] = t.trim().split(":");
        return +h * 60 + +mi;
      })
      .sort((a, b) => a - b);
    return { kind: "times", times };
  }
  if ((m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/))) return { kind: "daily", hour: +m[1], minute: +m[2] };
  if ((m = s.match(/^weekdays\s+(\d{1,2}):(\d{2})$/))) return { kind: "weekdays", hour: +m[1], minute: +m[2] };
  // "weekly fri 3:00" or just "fri 3:00" (24h time).
  if ((m = s.match(/^(?:weekly\s+)?([a-z]+)\s+(\d{1,2}):(\d{2})$/))) {
    const dow = DAYS[m[1]];
    if (dow !== undefined) return { kind: "weekly", dayOfWeek: dow, hour: +m[2], minute: +m[3] };
  }
  // "every 45 min", "every 2 hours", optionally windowed: "every 45m 07:00-22:30".
  // Optional leading "weekdays " gates the interval to Mon–Fri (e.g.
  // "weekdays every 30m 16:00-18:00") — the body still runs, but only on weekdays.
  let weekdaysOnly = false;
  let core = s;
  if (/^weekdays\s+every\b/.test(s)) {
    weekdaysOnly = true;
    core = s.replace(/^weekdays\s+/, "");
  }
  if ((m = core.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours)(?:\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2}))?$/))) {
    const intervalMs = +m[1] * (/^h/.test(m[2]) ? 3_600_000 : 60_000);
    const sched: Schedule = { kind: "interval", intervalMs };
    if (weekdaysOnly) sched.weekdaysOnly = true;
    if (m[3] !== undefined) {
      sched.windowStart = +m[3] * 60 + +m[4];
      sched.windowEnd = +m[5] * 60 + +m[6];
    }
    return sched;
  }
  return null;
}

interface ScheduledSkill {
  name: string;
  /**
   * The skill's DIRECTORY name under SKILLS_DIR. Equal to `name` for every skill today (a
   * test asserts that), but it's the directory that actually locates SKILL.md, and runSkill
   * now reads that file to inline the procedure — so carry the real thing rather than
   * re-deriving it from a frontmatter field.
   */
  dir: string;
  schedule: Schedule;
  runPrompt?: string;
  /** Exact tool names this skill structurally depends on — see scheduling/requiredTools.ts. */
  requiredTools: string[];
}

function scanScheduledSkills(): ScheduledSkill[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  const out: ScheduledSkill[] = [];
  for (const d of dirs) {
    let txt: string;
    try {
      txt = fs.readFileSync(path.join(SKILLS_DIR, d, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const schedRaw = fm[1].match(/^schedule:\s*(.+)$/m)?.[1];
    if (!name || !schedRaw) continue;
    const schedule = parseSchedule(schedRaw);
    if (!schedule) continue;
    const requiredTools = parseRequiredTools(fm[1]);
    // A declaration that's present but unparseable would silently disarm the guard, which
    // is the same class of bug as the one this guard exists for. Say so at load time —
    // but `requiredTools: []` is a deliberate "this skill needs no tools", not a failure,
    // and warning on it drowns the real case in noise on every scheduler scan.
    if (declaresRequiredTools(fm[1]) && !declaresEmptyRequiredTools(fm[1]) && requiredTools.length === 0) {
      warn(`skill ${name} declares requiredTools but none parsed — the required-tool guard is OFF for it`);
    }
    out.push({ name, dir: d, schedule, runPrompt: frontmatterField(fm[1], "runPrompt"), requiredTools });
  }
  return out;
}

function loadState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(s: Record<string, string>): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

/**
 * Wall-clock components of an instant in a given IANA timezone. Schedules are
 * expressed in the owner's local time, so we read the hour/day/date from THEIR zone
 * (derived from Find My), not the machine's — otherwise a box one timezone east fires
 * the "7:00" brief at 6:00 their time.
 */
function partsInTz(at: Date, tz: string): { minsOfDay: number; dayOfWeek: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // hour12:false emits "24" at midnight in some environments
  const minute = parseInt(get("minute"), 10);
  const dayOfWeek = DAYS[get("weekday").toLowerCase()] ?? at.getDay();
  return { minsOfDay: hour * 60 + minute, dayOfWeek, dateStr: `${get("year")}-${get("month")}-${get("day")}` };
}

function shouldFire(sched: Schedule, lastFiredISO: string | undefined, now: Date, tz: string): boolean {
  const last = lastFiredISO ? new Date(lastFiredISO) : undefined;
  const nowP = partsInTz(now, tz);
  if (sched.kind === "interval") {
    if (sched.weekdaysOnly && (nowP.dayOfWeek === 0 || nowP.dayOfWeek === 6)) return false;
    if (sched.windowStart !== undefined && sched.windowEnd !== undefined) {
      const mins = nowP.minsOfDay;
      const inWindow =
        sched.windowStart <= sched.windowEnd
          ? mins >= sched.windowStart && mins <= sched.windowEnd
          : mins >= sched.windowStart || mins <= sched.windowEnd; // window wraps midnight
      if (!inWindow) return false;
    }
    return !last ? true : now.getTime() - last.getTime() >= (sched.intervalMs ?? 0);
  }
  if (sched.kind === "times") {
    const slots = sched.times ?? [];
    // The most recent slot reached today (largest slot <= now). Before the first slot: don't fire.
    const currentSlot = slots.filter((t) => t <= nowP.minsOfDay).pop();
    if (currentSlot === undefined) return false;
    // Already fired at or after this slot earlier today? Then this slot's done.
    if (last) {
      const lastP = partsInTz(last, tz);
      if (lastP.dateStr === nowP.dateStr && lastP.minsOfDay >= currentSlot) return false;
    }
    return true;
  }
  if (sched.kind === "weekdays" && (nowP.dayOfWeek === 0 || nowP.dayOfWeek === 6)) return false;
  if (sched.kind === "weekly" && nowP.dayOfWeek !== sched.dayOfWeek) return false;
  const targetMins = (sched.hour ?? 0) * 60 + (sched.minute ?? 0);
  if (nowP.minsOfDay < targetMins) return false; // target time not reached yet today (their tz)
  // Fire once per local day: if we already fired during today's local calendar day, we're done.
  if (last && partsInTz(last, tz).dateStr === nowP.dateStr) return false;
  return true;
}

export async function deliver(transport: Transport, owner: string, message: string): Promise<void> {
  // Pull the user-facing payload out of any <output>...</output> wrapper FIRST, so the
  // model's internal narration ("Pruned the queue and sent. Here's their brief:") never
  // reaches the thread. Reminders pass static text with no wrapper, so they fall through
  // unchanged. This is the single chokepoint for every proactive/scheduled delivery
  // (reminders, scheduled tasks, scheduled skills, watches, goals, reconcile).
  const clean = stripMarkdown(unwrapOutput(message));
  // Backstop: a pass can wrap its own quiet sentinel (`<output>NOTHING</output>`) instead
  // of leaving it bare like instructed. Every caller here already checks `isQuietOutput`
  // on the raw text before calling deliver() — but that check happened BEFORE unwrapping,
  // so this is the last chance to catch a sentinel that only becomes bare NOTHING once
  // unwrapped. This is the actual bug that shipped a literal "NOTHING" bubble once already
  // (checking raw text missed the wrapped form; nothing downstream re-checked the
  // unwrapped result before sending it) — see isQuietOutput's doc comment.
  if (!clean || isQuietSentinel(clean)) {
    log(`proactive deliver: suppressed quiet-sentinel payload (raw: ${message.slice(0, 80)})`);
    return;
  }
  logOutbound(clean);
  const target = proactiveOwnerTarget() || owner;
  await pacedSend(transport, target, clean, {
    onError: (e) => warn(`scheduler send failed: ${e}`),
  });
  // This proactive message (reminder / scheduled skill / watch / goal) just entered
  // the thread out of band. Reset the long-lived interactive session so the next time
  // The owner texts, fig rebuilds from the transcript — which now includes this message —
  // and actually SEES what it just said, instead of resuming a session that has no
  // record of this send. (The transcript is the shared memory; this re-syncs to it.)
  setSession(undefined);
}

/**
 * The provider options EVERY unattended pass runs with — scheduled skills, one-off
 * scheduled tasks, watches, detectors, goals.
 *
 * Exported (and built by a function rather than inlined) so the tool surface an
 * unattended pass actually gets is inspectable from outside: `scripts/dev/tool-surface.ts`
 * runs a real query with exactly this object and reports which tools land in the turn-1
 * prompt vs the deferred ToolSearch registry. When this was an object literal buried in
 * runAgentPassResult, "what can a scheduled pass reach" was unanswerable without reading
 * the file — which is how it drifted to a silent subset of the live lane's servers.
 */
export function scheduledPassOptions(): ClaudeRuntimeOptions {
  return {
    cwd: config.brainDir,
    mcpServers: buildScheduledMcpServers(),
    canUseTool: makeCanUseTool(denyApprovals),
    permissionMode: "default",
    // The unattended lane's built-in denylist, derived from the same table in lane.ts the
    // live lane resolves from — never a hand-written list here. A second copy drifts, and it
    // drifts in the worst direction: names denied to a turn the owner is watching, allowed to
    // a 3am pass they aren't. The reason for each name lives next to the server exclusions.
    //
    // NOTE: ToolSearch must never be added here. Every in-process MCP tool that isn't
    // `alwaysLoad`-pinned is reachable ONLY through it, so disallowing it would silently
    // amputate ~55 tools from this lane (the CLI logs "Tool search disabled: ToolSearchTool
    // is not available" and then loads nothing).
    disallowedTools: disallowedToolsForLane("unattended"),
    settingSources: ["project"],
    skills: "all",
    // Counters formatting orders baked into built-in tool descriptions that assume a
    // markdown surface (WebSearch's "close with markdown links"). See runtimes/hooks.ts.
    hooks: SURFACE_HOOKS,
    systemPrompt: buildSystemPrompt(),
  };
}

/**
 * Run one proactive agent pass with the given prompt; returns the raw final text
 * (trimmed) AND whether the pass actually completed (ok:false on abort/timeout/error).
 * Shared by scheduled skills AND dynamic watches — each caller applies its own
 * output-sentinel logic to the returned text, and the scheduler uses `ok` to avoid
 * burning a fire-once slot when the pass failed (e.g. a transient API outage).
 */
export async function runAgentPassResult(
  prompt: string,
  label: string,
  contract?: ProactiveContract,
  timeoutMs?: number,
  requiredTools: string[] = [],
): Promise<TextRuntimeResult> {
  // Seed the SAME bounded conversation history a fresh interactive turn gets, so a
  // background fig pass (scheduled skill, watch, goal, research callback) runs with the
  // real convo context — it knows what was just discussed and why it's running, instead
  // of starting cold. This is the deep fix that makes the research `intent` field largely
  // redundant: the "why" is right there in the transcript these passes can now read.
  const history = recentHistory();
  const fullPrompt = history
    ? `[earlier conversation, for context only, do not reply to it:]\n${history}\n[end]\n\n${prompt}`
    : prompt;
  // Hard wall-clock cap around the pass (see SCHEDULED_PASS_WALL_CLOCK_MS). We race the real
  // run against an absolute timer: on expiry we abort the run (the signal threads into the
  // Claude runtime and cancels the query) AND resolve the race with ok:false, so even if the
  // underlying promise is wedged in a non-cancellable call the tick still proceeds. ok:false
  // means the scheduler leaves the slot unfired and retries next tick — same as any transient
  // failure — so a reaped pass isn't silently lost. The finally clears the timer on a normal
  // finish so a completed pass never trips the abort.
  const abort = new AbortController();
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const wallClock = new Promise<TextRuntimeResult>((resolve) => {
    wallTimer = setTimeout(() => {
      warn(
        `agent pass "${label}" hit hard wall-clock cap (${Math.round(
          SCHEDULED_PASS_WALL_CLOCK_MS / 60_000,
        )}m) — aborting so it can't freeze the tick; slot left unfired to retry`,
      );
      abort.abort();
      resolve({ text: "", ok: false });
    }, SCHEDULED_PASS_WALL_CLOCK_MS);
  });

  const validation = contract
    ? {
        isValid: (t: string) => isValidProactiveOutput(t, contract),
        correction: proactiveCorrection(contract),
      }
    : undefined;
  const run = withHeadlessAgentPass(label, () =>
    runBrainTextResult({
      label: `agent pass "${label}"`,
      prompt: fullPrompt,
      signal: abort.signal,
      timeoutMs: timeoutMs ?? HEADLESS_AGENT_PASS_TIMEOUT_MS,
      options: scheduledPassOptions(),
      validateOutput: validation,
      requiredTools,
    }),
  );

  try {
    return await Promise.race([run, wallClock]);
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
  }
}

/** Text-only wrapper for callers (watches, goals, research) that don't need the ok flag. */
export async function runAgentPass(prompt: string, label: string, contract?: ProactiveContract): Promise<string> {
  return (await runAgentPassResult(prompt, label, contract)).text;
}

/**
 * The single durable fix for the recurring "automation narrates instead of executing"
 * failure. A headless pass has no human watching the tool calls, so the path of least
 * resistance is to DESCRIBE the deliverable (a carousel's slides, the paper's contents,
 * a staged post) and emit that description as the message — which looks done but produced
 * nothing: no PNG rendered, no file sent, no page delivered. This preamble is prepended
 * to every scheduled skill/task run so the mandate lands at the automation-run layer
 * (covering EVERY skill at once), composing with each skill's own failure-point guard.
 */
const EXECUTION_MANDATE = `This is a LIVE EXECUTION run, not a planning or preview run. The skill/task steps are actions to CARRY OUT with your tools right now — not a script to summarize.

The one failure mode that keeps happening, and that you must not repeat: producing a DESCRIPTION of the deliverable instead of the deliverable itself. When a step says render / composite / send / save / post / deliver, you must actually CALL that tool so the real side effect happens — the PNG exists on disk, the carousel is actually sent, the page is actually delivered. Writing out "here's what the post says" or "the 5 slides are…" or "paper's live and delivered" WITHOUT having fired the tools is a FAILURE: it reads as done while nothing shipped.

Before you emit your final output, verify the real side effects actually happened this run (files written, media sent via the send tool, not pasted as text/paths). If all you did was describe it, you have not done it — go back and execute.

Finally, be unambiguous about what your <output> block IS: it is the literal message the owner receives, word for word — not a status report, not a log of what you did, not "done / sent / delivered." There is no separate delivery step after it; emitting the <output> IS the delivery. So when this run's job is to send them something — a paper, a brief, a post, an answer — the <output> block must BE that thing, written exactly as they read it, not a description of it. A run whose deliverable is a message they read has FAILED if the <output> is a report about that message instead of the message itself.

`;

/**
 * Run a scheduled skill in its own agent pass. Returns whether the pass actually
 * completed (`ok`) and the message to send (or null for a quiet success). A failed
 * pass (ok:false) must NOT burn the day's slot — the scheduler retries it next tick.
 */
async function runSkill(
  name: string,
  dir: string,
  runPrompt?: string,
  requiredTools: string[] = [],
): Promise<{ ok: boolean; message: string | null; degraded?: boolean }> {
  // A scheduled skill can declare its own `runPrompt` in SKILL.md frontmatter — a direct,
  // natural-instruction-shaped task ("… then send me …"), authored per automation the way
  // The owner would prompt it live. That framing (a real imperative task, not a meta "it's the
  // scheduled time to run your skill" narration) is what keeps the pass from feeling detached
  // from an actual run and drifting into describe-instead-of-do. When absent, fall back to the
  // generic wrapper. Either way the EXECUTION_MANDATE + output contract wrap it.
  const instruction = runPrompt?.trim()
    ? runPrompt.trim()
    : `It's the scheduled time to run your "${name}" procedure. Run it now.`;
  // The procedure itself, INLINED — not "use your X skill" and a hope that the model calls
  // the Skill tool. Automation skills are `internal: true`, and the vault turns every one of
  // them OFF in skillOverrides, which removes them from the model's skill listing AND blocks
  // model invocation outright. So there is nothing to invoke: the body comes in the prompt.
  //
  // FAIL LOUD if it can't be read. Falling back to the old phrasing would produce a pass that
  // improvises something skill-shaped from the name and reports success — the exact class of
  // silent failure this whole path exists to end. A pass that can't read its own procedure
  // did not run, so it returns ok:false and the tick leaves the slot unfired to retry.
  let procedure: string;
  try {
    procedure = skillProcedureBlock(dir);
  } catch (e) {
    warn(
      `scheduled skill "${name}" could not load its procedure — NOT running it. ` +
        `${e instanceof Error ? e.message : e}`,
    );
    return { ok: false, message: null };
  }
  // Named, fully-qualified tool contract for skills that structurally depend on specific
  // tools. Goes BEFORE the execution mandate so it's the first thing read: the mandate says
  // "actually do the work", and this says which tools that work must go through — and that
  // hand-rolling a substitute is not an acceptable way to satisfy the mandate.
  const prompt = `${EXECUTION_MANDATE}${instruction}

${procedure}

When you're done, deliver the owner's message by wrapping the EXACT text they should receive in <output></output> tags, like:
<output>
your message to them here
</output>
ONLY what's inside the tags is sent — anything you write before or after the tags (your thinking, "done", "here's the brief") is dropped, so you can narrate freely outside them. Write the text inside the tags AS the text they read: straight to them in your normal voice, second person ("you"), lowercase, no markdown, no quotes, no preamble.

If after doing the work there's nothing worth sending them right now, output exactly: NOTHING (with no <output> tags).`;
  // Per-skill output contract. Most skills use the plain quiet contract (wrapped message
  // or a NOTHING no-op). The newspaper skill additionally requires the delivered tl;dr to
  // carry the paper link — otherwise a "done, paper sent" status line (no link) passes the
  // bare wrapper check and gets delivered instead of the paper. A link-less payload fails
  // validation and the existing re-prompt loop kicks in. A
  // no-news NOTHING day is still valid (newspaper contract is quiet-allowed).
  const contract =
    name.trim().toLowerCase() === "newspaper" ? OUTPUT_CONTRACT.newspaper : OUTPUT_CONTRACT.quiet;
  const { text, ok, toolsUsed } = await runAgentPassResult(
    prompt,
    `skill:${name}`,
    contract,
    undefined,
    requiredTools,
  );

  // FAIL LOUD. A pass that never called a tool it structurally depends on did NOT do the
  // job — it improvised around the gap, and the improvised result reads as a success. That
  // is precisely how people-ingest ran degraded for weeks: every night it wrote one
  // parenthetical into its own run log and stayed otherwise silent, so nothing surfaced.
  //
  // Checked only on a pass that actually completed: an aborted/errored run has its own
  // retry path and obviously called nothing. Skipped when the runtime can't report tool use
  // at all (toolsUsed undefined) rather than crying wolf on a lane that never populates it.
  let uncalledNote: string | null = null;
  if (ok && requiredTools.length > 0 && toolsUsed) {
    const missing = missingRequiredTools(requiredTools, toolsUsed);
    if (missing.length > 0) {
      // WHY it went uncalled decides the response. Asking the lane directly (rather than
      // inferring from toolsUsed) is what separates "we never wired it" from "it was right
      // there" — see splitMissingByReachability. Conflating them is what turned a mis-declared
      // requirement into a suppressed morning brief plus an alert that named the wrong cause.
      const { unreachable, uncalled } = splitMissingByReachability(missing, unattendedLaneProvidesTool);
      recordDegradation({ skill: name, at: new Date().toISOString(), missing, unreachable, uncalled, toolsUsed });
      if (unreachable.length > 0) {
        const count = degradationCount(name, "unreachable");
        warn(
          `${DEGRADED_ERROR}: scheduled skill "${name}" could not reach required tool(s) ` +
            `${unreachable.join(", ")} — they are not published by the unattended lane, so this ` +
            `run improvised around them and its output is not trustworthy. Tools it did call: ` +
            `${toolsUsed.join(", ") || "(none)"}. Wiring failures on record for this skill: ${count}.`,
        );
        // Override the skill's own quiet/NOTHING path outright. A wiring failure is never
        // silent — the whole failure mode being fixed is a broken run that says nothing.
        return { ok, message: degradedAlert(name, unreachable, count), degraded: true };
      }
      // Reachable, just not called. The run's output stands — this is a disagreement between
      // a skill's declaration and its own instructions, not a broken pass, and suppressing a
      // real brief over it is a worse outcome than the thing being guarded against.
      const streak = degradationCount(name, "uncalled");
      warn(
        `scheduled skill "${name}" did not call declared tool(s) ${uncalled.join(", ")}, but the ` +
          `unattended lane does publish them — treating the output as valid. Tools it did call: ` +
          `${toolsUsed.join(", ") || "(none)"}. Runs like this on record: ${streak}.`,
      );
      uncalledNote = uncalledToolNote(name, uncalled, streak);
    }
  }

  // ok:false = the pass aborted/errored (e.g. API outage at the fire-minute). Surface
  // that so the caller leaves the slot unfired and retries. ok:true with empty/NOTHING
  // text = ran fine, nothing worth saying — that legitimately consumes the slot.
  // isQuietOutput (not isQuietSentinel alone) so a `<output>NOTHING</output>` — the
  // sentinel wrapped instead of left bare — is caught here too, not just by deliver()'s
  // own backstop.
  if (!text || isQuietOutput(text)) return { ok, message: null };
  // A persistent skipped-tool streak rides along with the real output instead of replacing it.
  return { ok, message: uncalledNote ? `${text}\n\n${uncalledNote}` : text };
}

/**
 * Run one durable one-off scheduled task as its own agent pass — the in-house
 * replacement for the harness cron. Same retry/quiet semantics as runSkill: ok:false
 * (transient failure) leaves the task in the store to retry next tick; a quiet/empty
 * result is a successful run with nothing worth sending.
 */
async function runScheduledTask(task: ScheduledTask): Promise<{ ok: boolean; message: string | null }> {
  const prompt = `${EXECUTION_MANDATE}It's the scheduled time to run a one-off task you set earlier${
    task.label ? ` ("${task.label}")` : ""
  }. Do it now.

The task:
${task.prompt}

When you're done, deliver the owner's message by wrapping the EXACT text they should receive in <output></output> tags, like:
<output>
your message to them here
</output>
ONLY what's inside the tags is sent — anything you write before or after them (your thinking, "done") is dropped, so narrate freely outside them. Write the text inside AS the text they read: straight to them in your normal voice, second person ("you"), lowercase, no preamble.

If after doing the work there's nothing worth sending them right now, output exactly: NOTHING (with no <output> tags).`;
  const { text, ok } = await runAgentPassResult(prompt, `task:${task.label || task.id}`, OUTPUT_CONTRACT.quiet);
  if (!text || isQuietOutput(text)) return { ok, message: null };
  return { ok, message: text };
}

/**
 * Run one watch's focused check in its own agent pass. Returns the message to send
 * (or null to stay quiet) and whether the watch resolved (should self-terminate).
 */
async function runWatch(w: Watch): Promise<{ message: string | null; resolved: boolean }> {
  const prompt = `You're running a dedicated watch loop called "${w.label}". This is a focused, single-purpose check — do ONLY this, don't run a full proactive sweep.

Your task this cycle:
${w.prompt}

Output contract — follow EXACTLY. Any text the owner should receive goes wrapped in <output></output> tags; ONLY what's inside the tags is sent, so you can think/narrate outside them. Inside, speak straight to them in your normal voice, second person, lowercase, no preamble.
- If there's nothing to report yet (the thing you're watching hasn't happened or resolved), output exactly: NOTHING (no <output> tags)
- If the watch is now RESOLVED (the thing happened, or it's no longer worth watching), write their message inside <output></output>, then put RESOLVED alone on the final line AFTER the closing tag. This ENDS the watch — it will not run again.
- If there's an interim update worth sending but the watch should keep running, just write that text inside <output></output> (no RESOLVED line).`;
  const t = await runAgentPass(prompt, `watch:${w.id}`, OUTPUT_CONTRACT.watch);
  if (!t || isQuietOutput(t)) return { message: null, resolved: false };
  if (/(^|\s)RESOLVED\s*$/.test(t)) {
    const message = t.replace(/\s*RESOLVED\s*$/, "").trim();
    return { message: message || null, resolved: true };
  }
  return { message: t, resolved: false };
}

/**
 * Run one detector wake after the cheap probe has already observed a state diff.
 * The probe path itself is LLM-free; this pass only happens on a real changed
 * signal or a newly-observed probe error that the owner should know about.
 */
async function runDetectorWake(d: Detector, context: string): Promise<string | null> {
  const prompt = `You're running a detector wake called "${d.label}". A cheap browser probe already detected a changed signal; do ONLY this focused follow-up, don't run a full proactive sweep.

Your task:
${d.prompt}

[detector context: ${context}]

Output contract — follow EXACTLY. Any text the owner should receive goes wrapped in <output></output> tags; ONLY what's inside the tags is sent, so you can think/narrate outside them. Inside, speak straight to them in your normal voice, second person, lowercase, no preamble.
- If after checking there is nothing worth sending them, output exactly: NOTHING (no <output> tags)
- Do not output RESOLVED; detectors keep their own baseline and continue watching.`;
  const t = await runAgentPass(prompt, `detector:${d.id}`, OUTPUT_CONTRACT.watch);
  if (!t || isQuietOutput(t) || /^\s*RESOLVED\s*$/i.test(t)) return null;
  return t;
}

/**
 * Run one work-pass of a self-driving goal. Unlike a watch, this DOES work and
 * accumulates it into the goal's progress doc, then judges itself STRICTLY against
 * an explicit finish line. Returns the message to send (or null) and whether the
 * goal is done.
 *
 * `report` forces an interim update this pass (interval reporting). `lastPass`
 * tells the agent this is the backstop cap — wrap up and hand over whatever it has.
 */
async function runGoal(
  g: Goal,
  opts: { report: boolean; lastPass: boolean },
): Promise<{ message: string | null; done: boolean }> {
  const passNo = (g.passes ?? 0) + 1;
  const prompt = `You're running a long-running GOAL loop called "${g.label}". This is ONE work-pass of many — you are not expected to finish the whole goal in this single pass. Do the next solid increment, save your progress, and let the loop carry it forward.

THE GOAL:
${g.goal}

THE FINISH LINE (this is the ONLY thing that means "done" — judge against it literally, do NOT lower the bar to wrap up early):
${g.doneCriteria}

YOUR PROGRESS DOC: ${g.progressFile}
FIRST, read that file — it's everything prior passes accomplished. Build ON it; don't repeat work already done. (If it doesn't exist yet, create it with a header for this goal.)

This is pass ${passNo} of at most ${g.maxPasses}.

What to do this pass:
1. Read the progress doc to see where things stand against the finish line.
2. Do the next meaningful chunk of real work toward the goal.
3. Append what you did + what you found to the progress doc (concise, dated, building on prior entries). This is the durable record — write it well.
4. Honestly assess against THE FINISH LINE above.

Output contract — follow EXACTLY. Any text the owner should receive goes wrapped in <output></output> tags; ONLY what's inside is sent, so you can think/narrate outside them. Inside, speak straight to them in your normal voice, second person, lowercase, no preamble. The CONTINUE/DONE token always goes on the final line AFTER the closing tag.
- If the finish line is NOT yet objectively met: ${opts.report ? "write a short interim update for the owner on where the goal stands (this is a scheduled check-in) inside <output></output>, then put CONTINUE alone on the final line after the closing tag." : "output exactly CONTINUE (no other text, no <output> tags — you're running silently until done or a scheduled check-in)."}
- If the finish line IS objectively, fully met: write the finished deliverable for the owner — the actual result they wanted — inside <output></output>, then put DONE alone on the final line after the closing tag. This ENDS the goal.
${opts.lastPass ? "- NOTE: this is the final pass (hit the cap). Even if the finish line isn't fully met, wrap up: write the owner the best result you have so far plus what's still missing inside <output></output>, then put DONE on the final line after the closing tag." : ""}

Do NOT claim DONE unless the finish line is genuinely satisfied. Quitting early is the failure mode this loop exists to prevent.`;

  const t = await runAgentPass(prompt, `goal:${g.id}`, OUTPUT_CONTRACT.goal);
  if (!t) return { message: null, done: false };
  if (/(^|\s)DONE\s*$/.test(t)) {
    const message = t.replace(/\s*DONE\s*$/, "").trim();
    return { message: message || null, done: true };
  }
  // CONTINUE (or anything else): strip a trailing CONTINUE token; send remaining
  // prose only if this was a report pass (otherwise it should've been bare CONTINUE).
  const message = t.replace(/\s*CONTINUE\s*$/, "").trim();
  if (opts.report && message) return { message, done: false };
  return { message: null, done: false };
}

export function startScheduler(transport: Transport, owner: string): void {
  // Prime interval skills so they fire one interval from now, not immediately at boot.
  const primed = loadState();
  for (const { name, schedule } of scanScheduledSkills()) {
    if (schedule.kind === "interval" && !primed[name]) primed[name] = new Date().toISOString();
  }
  saveState(primed);

  async function tick(): Promise<void> {
    const now = new Date();
    const tz = resolveOwnerTz();
    for (const r of takeDueReminders()) {
      await deliver(transport, owner, r.text);
      log(`reminder fired: ${r.id}`);
    }

    // Durable one-off scheduled tasks — the in-house cron. `due` = fire-time reached
    // and still inside its lateness window (run as a full pass); `expired` = missed by
    // too long (drop without running, since a late wake/prep is useless). A task is
    // removed only on a successful run or expiry, so a transient API outage retries.
    const { due: dueTasks, expired: expiredTasks } = dueScheduledTasks(now);
    for (const t of expiredTasks) {
      removeScheduledTask(t.id);
      warn(
        `scheduled task ${t.id} ("${t.label}") expired — missed its window by >${Math.round(
          t.maxLateMs / 60_000,
        )}m, dropped without running`,
      );
    }
    for (const t of dueTasks) {
      log(`running scheduled task: ${t.id} (${t.label})`);
      const { ok, message } = await runScheduledTask(t);
      if (!ok) {
        warn(`scheduled task ${t.id} failed this pass — leaving in store to retry next tick`);
        continue;
      }
      removeScheduledTask(t.id);
      if (message) {
        await deliver(transport, owner, message);
        log(`scheduled task ${t.id} sent a message`);
      }
    }

    const state = loadState();
    for (const { name, dir, schedule, runPrompt, requiredTools } of scanScheduledSkills()) {
      if (!shouldFire(schedule, state[name], now, tz)) continue;
      log(`running scheduled skill: ${name}`);
      const { ok, message, degraded } = await runSkill(name, dir, runPrompt, requiredTools);
      if (!ok) {
        // The pass aborted/errored (transient API outage at the fire-minute, etc.).
        // Do NOT stamp the slot — leave lastFired untouched so shouldFire stays true
        // and the next tick retries, instead of silently eating the whole day's run.
        warn(`scheduled skill ${name} failed this pass — leaving slot unfired to retry next tick`);
        continue;
      }
      // Stamp the slot even on a degraded run. The tool gap is structural, not transient —
      // retrying every 30s would just spam a broken sweep all night. The alert below is what
      // gets it fixed, and it goes out on the SAME tick.
      state[name] = new Date().toISOString();
      saveState(state);
      if (message) {
        await deliver(transport, owner, message);
        log(`scheduled skill ${name} sent a ${degraded ? "DEGRADED-MODE alert" : "message"}`);
      }
    }

    // Dynamic watches — runtime-created dedicated loops. Each carries its own
    // focused prompt + cadence and self-prunes on resolution or expiry. Zero
    // watches = zero extra work here (the registry is just empty).
    for (const w of loadWatches()) {
      if (isExpired(w, now)) {
        removeWatch(w.id);
        log(`watch dropped (expired): ${w.id}`);
        continue;
      }
      const sched = parseSchedule(w.schedule);
      if (!sched) {
        warn(`watch ${w.id} has unparseable schedule "${w.schedule}" — skipping`);
        continue;
      }
      if (!shouldFire(sched, w.lastFiredISO, now, tz)) continue;
      log(`running watch: ${w.id}`);
      const { message, resolved } = await runWatch(w);
      if (resolved) {
        removeWatch(w.id);
        log(`watch ${w.id} resolved, dropped`);
      } else {
        markWatchFired(w.id, new Date().toISOString());
      }
      if (message) {
        await deliver(transport, owner, message);
        log(`watch ${w.id} sent a message`);
      }
    }

    // Dynamic detectors — cheap, LLM-free browser probes. A detector consumes
    // tokens only when its compact signal changes (or when a new probe error
    // needs to be surfaced once, such as an auth wall).
    for (const d of loadDetectors()) {
      if (!d.enabled) continue;
      if (isDetectorExpired(d, now)) {
        removeDetector(d.id);
        log(`detector dropped (expired): ${d.id}`);
        continue;
      }
      const sched = parseSchedule(d.schedule);
      if (!sched) {
        warn(`detector ${d.id} has unparseable schedule "${d.schedule}" — skipping`);
        continue;
      }
      if (!shouldFire(sched, d.lastCheckedISO, now, tz)) continue;

      const probe = PROBES[d.probe];
      if (!probe) {
        warn(`detector ${d.id} references unknown probe "${d.probe}" — skipping`);
        continue;
      }

      log(`running detector probe: ${d.id} (${d.probe})`);
      let result: Awaited<ReturnType<typeof probe>>;
      try {
        result = await probe();
      } catch (e) {
        result = { error: `PROBE_THROW:${e instanceof Error ? e.message : String(e)}` };
      }
      markDetectorChecked(d.id, now.toISOString());

      if ("error" in result) {
        const error = result.error || "UNKNOWN_ERROR";
        const isNewError = error !== d.lastError;
        setDetectorError(d.id, error);
        warn(`detector ${d.id} probe error: ${error}`);
        if (isNewError) {
          const message = await runDetectorWake(
            {
              ...d,
              prompt: `The detector probe "${d.probe}" failed before it could check the site. Text the owner a short operational heads-up. If the error is AUTH_FAILED, say the shared browser session may need login/checkpoint attention. Do not browse, retry, reply, or click anything.`,
            },
            `probe "${d.probe}" returned error: ${error}`,
          );
          markDetectorFired(d.id, new Date().toISOString());
          if (message) {
            await deliver(transport, owner, message);
            log(`detector ${d.id} sent an error message`);
          }
        }
        continue;
      }

      setDetectorError(d.id, undefined);
      if (d.lastValue === undefined) {
        setDetectorValue(d.id, result.signal);
        log(`detector ${d.id} baseline set`);
        continue;
      }
      if (result.signal === d.lastValue) continue;

      setDetectorValue(d.id, result.signal);
      const message = await runDetectorWake(d, result.human);
      markDetectorFired(d.id, new Date().toISOString());
      if (message) {
        await deliver(transport, owner, message);
        log(`detector ${d.id} sent a message`);
      }
    }

    // Self-driving goals — long-running objectives that DO work each pass and
    // accumulate it into a progress doc, terminating only when an explicit finish
    // line is met (or the pass cap is hit as a backstop). Zero goals = zero work.
    for (const g of loadGoals()) {
      if (isGoalExpired(g, now)) {
        removeGoal(g.id);
        log(`goal dropped (expired): ${g.id}`);
        continue;
      }
      const sched = parseSchedule(g.schedule);
      if (!sched) {
        warn(`goal ${g.id} has unparseable schedule "${g.schedule}" — skipping`);
        continue;
      }
      if (!shouldFire(sched, g.lastFiredISO, now, tz)) continue;
      const passNo = (g.passes ?? 0) + 1;
      const lastPass = passNo >= g.maxPasses;
      const report = !!g.reportEvery && passNo % g.reportEvery === 0;
      log(`running goal: ${g.id} (pass ${passNo}/${g.maxPasses})`);
      const { message, done } = await runGoal(g, { report, lastPass });
      if (done || lastPass) {
        removeGoal(g.id);
        log(`goal ${g.id} ${done ? "done" : "hit pass cap"}, dropped`);
      } else {
        markGoalPass(g.id, new Date().toISOString());
      }
      if (message) {
        await deliver(transport, owner, message);
        log(`goal ${g.id} sent a message`);
      }
    }
  }

  void (async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (e) {
        warn(`scheduler tick: ${e}`);
      }
      await sleep(TICK_MS);
    }
  })();

  log("scheduler started (reminders + scheduled skills)");
}
