import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { loadMcpServers } from "../runtimes/mcp";
import { freshInstances } from "../runtimes/mcpInstances";
import type { Exposure, ServerDefinition } from "../tools/define";
import { ALL_SERVERS, IN_PROCESS_SERVERS, instantiate, serverByKey } from "../tools/registry";

/**
 * Per-lane MCP surface — now entirely DERIVED from `src/tools/registry.ts`.
 *
 * History, because it's the reason for the shape. This started as two hand-maintained object
 * literals 400 lines apart: the live lane's in `session.ts`, the unattended lane's inline in
 * `runAgentPassResult`. They drifted invisibly — seven servers the live lane carried were never
 * passed to scheduled passes, so a nightly skill couldn't reach them by ANY mechanism. That ran
 * for ~6 weeks. The first fix moved both lanes here and derived unattended as
 * live-minus-an-exclusion-table. That was better, but the exclusion table was still a
 * hand-kept list of server names living in a different file from the servers it named — and
 * two more copies of the same idea turned up afterwards (`news/run.ts`, and
 * `FIG_DISALLOWED_TOOLS` vs the scheduler's inline denylist).
 *
 * So the table is gone too. A server declares its own `exposure` next to its own definition,
 * and this file computes lanes from that. There is nothing here left to keep in sync: adding a
 * server without deciding its exposure fails at module load, and `laneServerDrift()` still
 * checks the four directions a mistake could point.
 *
 * The cost model that makes lane membership a question of AUTHORITY rather than budget:
 * nothing is pinned except the two measured exceptions (email + calendar). Every other server
 * is DEFERRED behind ToolSearch, costing ~28 chars of name in the deferred registry and zero
 * turn-1 schema. Pinning the whole in-process set would cost 27,662 chars in every pass. A
 * server is excluded because an unattended pass shouldn't be able to do that thing, never
 * because it's expensive to list.
 */

/** The two agent lanes this file owns the tool surface for. */
export type Lane =
  /** The owner is in the loop: the main iMessage turn, the warm session, and /btw background figs. */
  | "live"
  /** Nobody is in the loop: scheduled skills, one-off scheduled tasks, watches, detectors, goals. */
  | "unattended";

/**
 * The built-in denylist lives in the leaf module `builtinDenylist.ts` (it imports nothing, so a
 * sub-query runner can use it without importing this file's server registry). Re-exported here
 * because lane membership and built-in denial are one question for every lane consumer.
 */
export {
  BASE_DISALLOWED_TOOLS,
  UNATTENDED_ONLY_DISALLOWED_TOOLS,
  disallowedToolsForLane,
  subQueryDisallowedTools,
} from "./builtinDenylist";

/** Is this server mounted in this lane's orchestrator context? */
export function inLane(exposure: Exposure, lane: Lane): boolean {
  if (exposure === "specialist-only") return false;
  return lane === "live" || exposure === "both";
}

export interface LaneExclusion {
  /** Which lanes lose it: "unattended" for live-only servers, "both" for specialist-only ones. */
  scope: "unattended" | "both";
  /** Why. Comes straight off the server definition — there is no second place to write it. */
  reason: string;
}

/**
 * The exclusion table, DERIVED. Kept as an export because the alerting and the generated
 * inventory both read it, but nobody maintains it any more: a server's `exposure` and `reason`
 * live on its own definition, and this is a projection of them.
 */
export function laneExclusions(): Readonly<Record<string, LaneExclusion>> {
  const out: Record<string, LaneExclusion> = {};
  for (const s of ALL_SERVERS) {
    if (s.exposure === "both") continue;
    out[s.key] = {
      scope: s.exposure === "specialist-only" ? "both" : "unattended",
      reason: s.reason ?? "",
    };
  }
  return out;
}

/** Server keys dropped from the unattended lane (either scope). */
export function unattendedExcluded(): string[] {
  return ALL_SERVERS.filter((s) => !inLane(s.exposure, "unattended")).map((s) => s.key);
}

/** Server keys dropped from the live lane too (specialist-only). */
export function laneWideExcluded(): string[] {
  return ALL_SERVERS.filter((s) => !inLane(s.exposure, "live")).map((s) => s.key);
}

/**
 * Every in-process SDK MCP server for a lane, keyed by the name that forms its tools'
 * `mcp__<key>__<tool>` prefix.
 *
 * Each call builds FRESH instances. An in-process SDK server instance can be mounted by exactly
 * one open query (see runtimes/mcpInstances.ts) — a background pass overlapping the interactive
 * session would otherwise come up toolless, which is what scheduled passes actually did.
 */
function inProcessServersForLane(lane: Lane): Record<string, McpServerConfig> {
  return Object.fromEntries(
    IN_PROCESS_SERVERS.filter((s) => inLane(s.exposure, lane)).map((s) => [s.key, instantiate(s)]),
  );
}

/** File-mcp servers for a lane: whatever mcp.json yields, minus anything not exposed there. */
function fileServersForLane(lane: Lane): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(loadMcpServers()).filter(([key]) => {
      const def = serverByKey(key);
      // An unregistered mcp.json entry is a decision nobody made. It is kept OUT of both
      // lanes and reported by `laneServerDrift()`, which fails a test — the safe direction,
      // and loud. The alternative (include it) is how a vault edit silently hands a 3am pass
      // a new surface.
      return def ? inLane(def.exposure, lane) : false;
    }),
  );
}

/**
 * The live lane — the owner is in the loop and can be asked, so it carries everything except the
 * specialist-only servers.
 */
export function buildFigMcpServers(): Record<string, McpServerConfig> {
  return freshInstances({ ...fileServersForLane("live"), ...inProcessServersForLane("live") });
}

/**
 * Every in-process server an unattended pass can reach. Exported separately (rather than only
 * via the assembled map) so tests can diff it by key against the live lane.
 */
export function scheduledInProcessServers(): Record<string, McpServerConfig> {
  return inProcessServersForLane("unattended");
}

/**
 * The full mcpServers map handed to every unattended agent pass — instances built fresh for
 * THIS pass. Two scheduled passes can overlap (a watch and a skill on the same tick), so
 * per-call is the right granularity, not per-lane.
 */
export function buildScheduledMcpServers(): Record<string, McpServerConfig> {
  return freshInstances({ ...fileServersForLane("unattended"), ...inProcessServersForLane("unattended") });
}

/** Every server key registered anywhere, before any lane filtering. */
export function allRegisteredServerKeys(): string[] {
  return [...new Set([...Object.keys(loadMcpServers()), ...ALL_SERVERS.map((s) => s.key)])].sort();
}

/**
 * Does the given lane actually PUBLISH this fully-qualified tool (`mcp__server__tool`)?
 *
 * This exists to separate two failures the required-tools guard was conflating, and the
 * conflation cost a real morning brief: "the tool isn't wired into this lane" (a wiring bug —
 * the six-week people-ingest failure) versus "the tool was right there and the pass didn't call
 * it" (a prompt/skill-instruction problem). Both looked identical from `toolsUsed` alone.
 *
 * Registry servers answer exactly — no reflection on a built instance, no string-splitting
 * guesswork about where the server key ends, because the registry knows both halves. File-mcp
 * servers can't be enumerated without connecting, so a tool whose SERVER is present is reported
 * as provided — deliberately optimistic, because this answer only ever downgrades an alert, and
 * a false "unreachable" is the louder, more misleading mistake.
 *
 * KNOWN LIMIT, stated rather than implied: this measures what we WIRE, not what the model
 * ultimately saw. `scripts/dev/tool-surface.ts scheduled` runs a real query against this exact
 * lane and reports what lands in the prompt vs the deferred registry; re-run it if a skill
 * starts skipping a tool it shouldn't.
 */
export function laneProvidesTool(fullyQualified: string, lane: Lane = "unattended"): boolean {
  if (!fullyQualified.startsWith("mcp__")) return false; // built-in (Bash/Read/…) — not a lane question
  for (const s of ALL_SERVERS) {
    const prefix = `mcp__${s.key}__`;
    if (!fullyQualified.startsWith(prefix)) continue;
    if (!inLane(s.exposure, lane)) return false;
    if (s.kind === "external") return Object.hasOwn(loadMcpServers(), s.key);
    return s.capabilities.some((c) => c.name === fullyQualified.slice(prefix.length));
  }
  return false;
}

/** Back-compat alias for the unattended-lane question, which is the only one callers ask. */
export function unattendedLaneProvidesTool(fullyQualified: string): boolean {
  return laneProvidesTool(fullyQualified, "unattended");
}

export interface LaneDrift {
  /** In the live lane, absent from the unattended lane, with no exclusion explaining it. */
  undecided: string[];
  /** In the unattended lane but not the live lane — a server only unattended passes can reach. */
  extraInScheduled: string[];
  /** Registry definitions naming a file-mcp server that mcp.json no longer contains. */
  staleExclusions: string[];
  /** Excluded servers nonetheless still present in the lane they're excluded from. */
  leakedExclusions: string[];
  /** mcp.json servers with no registry definition — included by nobody's decision. */
  unreviewedFileMcp: string[];
}

/** mcp.json servers with no definition in the registry — silently present in the vault. */
export function unreviewedFileMcpServers(): string[] {
  return Object.keys(loadMcpServers())
    .filter((k) => !serverByKey(k))
    .sort();
}

/**
 * The whole invariant, in one function, asserted in tests.
 *
 * Every registered server is EITHER in the unattended lane OR carries a non-"both" exposure
 * with a reason — and nothing declared is stale or leaking. That's the property that makes
 * membership impossible to drift in either direction: adding a server fails at module load
 * until someone decides, and deleting one fails a test until someone cleans up.
 */
export function laneServerDrift(
  live: Record<string, unknown>,
  scheduled: Record<string, unknown>,
  registered: readonly string[] = allRegisteredServerKeys(),
): LaneDrift {
  const liveKeys = new Set(Object.keys(live));
  const schedKeys = new Set(Object.keys(scheduled));
  const known = new Set(registered);
  const exclusions = laneExclusions();

  const undecided = [...liveKeys].filter((k) => !schedKeys.has(k) && !exclusions[k]).sort();
  const extraInScheduled = [...schedKeys].filter((k) => !liveKeys.has(k)).sort();
  // An `external` definition whose mcp.json entry vanished (renamed away, or its ${VAR} went
  // unset) is the same class of rot as a missing server — a written-down decision pointing at
  // nothing. In-process definitions can't go stale this way; they ARE the registration.
  const staleExclusions = ALL_SERVERS.filter((s) => s.kind === "external" && !known.has(s.key))
    .map((s) => s.key)
    .sort();
  const leakedExclusions = Object.entries(exclusions)
    .filter(([k, e]) => schedKeys.has(k) || (e.scope === "both" && liveKeys.has(k)))
    .map(([k]) => k)
    .sort();

  return {
    undecided,
    extraInScheduled,
    staleExclusions,
    leakedExclusions,
    unreviewedFileMcp: unreviewedFileMcpServers(),
  };
}

/** Re-exported for consumers that want the definition, not just the key. */
export type { ServerDefinition };
