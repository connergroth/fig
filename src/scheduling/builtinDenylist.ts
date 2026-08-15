/**
 * The BUILT-IN (non-MCP) tool denylist — the one place the harness's own tools are refused.
 *
 * A LEAF module on purpose: it imports nothing. `lane.ts` (which pulls in the whole server
 * registry) re-exports everything here, so lane consumers are unchanged — but a sub-query
 * runner (`runtimes/brain.ts`, `specialists/run.ts`) can reach the denylist without importing
 * the registry and creating an import cycle back through itself.
 */
import type { Lane } from "./lane";

/**
 * BUILT-IN (non-MCP) tools denied in EVERY lane, each with the reason it's denied.
 *
 * Server membership answers "which MCP servers does this lane get". This answers the other
 * half — which of the harness's own built-ins it does NOT get. It lives here, once, for both
 * lanes: a per-lane copy is how a name ends up denied to an attended turn and silently ALLOWED
 * at 3am, which is the wrong direction for every name on this list.
 *
 * These are harness built-ins, not MCP capabilities, so they can't carry a definition in the
 * registry — this table is the one place they exist, and the reason string is required for
 * exactly the reason the registry requires one: a bare name in an array is what rots.
 */
export const BASE_DISALLOWED_TOOLS: Readonly<Record<string, string>> = {
  AskUserQuestion:
    "renders an interactive picker that expects a click. Over iMessage there's nothing to click, so a call dead-ends; in an unattended pass there is additionally nobody to click it. fig asks in plain text instead",
  EnterPlanMode:
    "plan-mode UI, same dead end as AskUserQuestion — it waits on an approval surface neither lane has",
  ExitPlanMode:
    "the other half of plan mode; denying only one of the pair leaves the model able to enter a mode it can't leave",
  Agent:
    "the generic built-in subagent spawner. Delegation goes through the MCP specialist servers (email/calendar/browse/code/…), which are the surface the registry actually governs — a generic Agent is an unscoped sub-agent on the owner's quota that no exclusion reaches, which matters MORE unattended, not less",
  CronCreate:
    "the harness's ephemeral kairos cron (tengu_kairos_cron_durable is off in this build, so a cron dies on any restart and missed fires drop silently). Durable one-off work goes through the file-backed scheduled_tasks tool",
  CronList: "same kairos cron surface — we don't schedule through it, so we don't read it either",
  CronDelete: "same kairos cron surface; deleting a cron we never create is only ever a confused pass acting on stale state",
  Workflow:
    "the single most expensive thing in the prompt: its description alone measures 19,078 chars (~4,800 tokens), ~40% the size of the ENTIRE hand-written system prompt and ~5x the whole deferred-tool registry — paid on every turn of every lane. Deferring it behind ToolSearch is not available to us: the always-loaded built-in set comes from the server-side `tengu_non_deferrable_builtins` gate whose local fallback is an empty array, so there is no option, env var or flag we can pass. Denial is the only lever. It costs nothing real — deep_research does NOT use this tool, it spawns its own query with an explicit tools list (see research/workflowRunner.ts), so that path is untouched. The only capability lost is launching an ad-hoc workflow mid-conversation; if that's ever wanted, wrap it in a sub-query the same way workflowRunner already does",
  ScheduleWakeup:
    "exists solely to self-pace `/loop` dynamic mode, which this codebase does not use — zero references to ScheduleWakeup or /loop anywhere in src/. Recurring and one-off timed work goes through the file-backed scheduled_tasks tool, which survives restarts and catches up on missed fires; this one cannot. Dead weight in every turn's tool block",
};

/**
 * Denials that apply to the unattended lane ONLY — the built-in analogue of an
 * `exposure: "live-only"` server.
 *
 * EMPTY on purpose, not by neglect. Every name that belongs on this list today also belongs in
 * the live lane's, so it's in the base table where one edit covers both. The mechanism stays
 * wired and tested so the first built-in that's genuinely fine attended and not fine at 3am is
 * one line here, not a redesign.
 */
export const UNATTENDED_ONLY_DISALLOWED_TOOLS: Readonly<Record<string, string>> = {};

/**
 * THE denylist for a lane — the single definition both `query()` call sites derive from.
 *
 * Unattended is strictly the base plus its own extras, so the live lane can never deny
 * something the unattended lane allows. That directionality is the invariant: whatever an
 * owner-in-the-loop turn isn't trusted with, a pass with nobody watching isn't either.
 */
export function disallowedToolsForLane(lane: Lane): string[] {
  const names = Object.keys(BASE_DISALLOWED_TOOLS);
  if (lane === "unattended") names.push(...Object.keys(UNATTENDED_ONLY_DISALLOWED_TOOLS));
  return [...new Set(names)];
}

/**
 * The same denylist, for a SUB-QUERY (a specialist or any scoped brain pass) rather than a lane.
 *
 * Neither lane's `disallowedTools` reaches a sub-query — a specialist gets its own `query()`, so
 * until this existed every one of them carried the full built-in preset. That is not a
 * theoretical hole: the code specialist called `AskUserQuestion` mid-job and parked on a picker
 * nobody can click over iMessage, which is the exact dead end the base table exists to prevent.
 * It also meant every specialist run paid for `Workflow`'s ~4,800-token description.
 *
 * A caller that names a base-denied built-in in its OWN `tools` allowlist keeps it — declaring
 * a tool explicitly is a decision, not an accident. That is what lets `research/workflowRunner`
 * (`tools: ["Workflow", …]`) keep the one tool the base table denies everywhere else, without a
 * second exception list living somewhere far away from it.
 *
 * `allowedTools` is NOT an escape hatch here, and must not become one: in the Agent SDK it is
 * the AUTO-APPROVE list ("tool names that are auto-allowed without prompting"), not the tool
 * surface. Reading it as a surface is what hid this hole in the first place — the code
 * specialist's six-name list looked like a cap and was only a convenience.
 */
export function subQueryDisallowedTools(declaredTools?: readonly string[] | unknown): string[] {
  const declared = new Set(Array.isArray(declaredTools) ? (declaredTools as string[]) : []);
  return Object.keys(BASE_DISALLOWED_TOOLS).filter((name) => !declared.has(name));
}

