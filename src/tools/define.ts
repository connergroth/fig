import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ZodRawShape } from "zod";

import { text } from "../core/toolResult";
import { inputJsonSchema } from "./jsonSchema";

/**
 * ONE definition per capability. Everything else derives.
 *
 * This file is the contract; `registry.ts` is the index; every consumer (both agent lanes,
 * the Codex stdio fallback, the generated inventory, the skill-requirement lint) reads the
 * same definitions and hand-maintains nothing.
 *
 * WHY, concretely — the failures this shape exists to make impossible:
 *
 *  - Two names for one capability. `fig_tools` was a second registry that re-published 16
 *    tools already owned by location/reminders/scheduled_tasks/jobs/fetch/agentmail under its
 *    own names (`mcp__fig_tools__where_is` vs `mcp__location__where_is`, and 11 of them under
 *    DIFFERENT names, so no automated check could see the duplication at all). That made every
 *    server-level exclusion walkable-around and forced `|` alternation into skill declarations.
 *    Now a capability exists once, in one server, and `oneHandlerOneCapability()` fails a test
 *    if any handler is ever published twice.
 *  - Metadata living apart from the thing it describes. `policy.fallback` existed ONLY on the
 *    fig_tools array; lane exclusions lived in a table in `lane.ts` naming servers defined
 *    elsewhere; the read/write split existed only as a comment. Each of those is a hand-kept
 *    list far from what it governs, which is the exact shape that rotted for six weeks. Every
 *    one of them is now a field HERE, next to the handler, and the tables downstream derive.
 *  - Two authored schemas for one input — see `jsonSchema.ts`.
 *
 * Adding a tool: see `docs/adding-a-tool.md`. The short version is that `defineServer` throws
 * at module load if you leave a decision unmade, so a half-declared tool cannot boot.
 */

/** What a server IS, which decides how much a grant of it hands over. */
export type ServerKind =
  /** One thin tool that opens a sub-agent query. Expensive; its real verbs live inside. */
  | "specialist"
  /** Does one cheap thing in-process and returns. */
  | "direct"
  /** A file-mcp (`mcp.json`) process. Tools are not statically enumerable from here. */
  | "external";

/** Does calling this change state outside fig? The grant primitive for a read-only allow. */
export type Mutates =
  /** Reads or computes. Re-running it costs time, nothing else. */
  | "read"
  /** Sends, spends, schedules, deletes, or otherwise changes something outside this process. */
  | "write";

/** Whether the out-of-process Codex fallback runtime may call this. Default `deny`. */
export type FallbackPolicy = "allow" | "deny";

/** Which orchestrator contexts may mount this server. Replaces the old LANE_EXCLUSIONS table. */
export type Exposure =
  /** Live lane and unattended lane both get it. */
  | "both"
  /** Live only. The owner is in the loop and can interrupt; a 3am pass has nobody. */
  | "live-only"
  /** Never in an orchestrator context — reachable only inside a specialist's own sub-query. */
  | "specialist-only";

export interface Capability {
  /** Bare tool name. Published as `mcp__<serverKey>__<name>`. */
  name: string;
  /** One line, for humans and the generated inventory. Not sent to the model. */
  purpose: string;
  /** The model-facing description. */
  description: string;
  /** CANONICAL input shape. The JSON Schema the stdio fallback serves is derived from this. */
  input: ZodRawShape;
  /** read vs write. What makes a read-only grant expressible; see registry.ts `writeCapabilities`. */
  mutates: Mutates;
  /** Codex stdio fallback policy. Omitted = "deny": a new tool is not fallback-published by accident. */
  fallback?: FallbackPolicy;
  /** Why this is or isn't in the fallback surface. Required whenever `fallback` is set at all. */
  fallbackReason?: string;
  /** Extra policy text appended to the description on the fallback surface only. */
  notes?: string;
  /**
   * Pin THIS capability into every turn-1 prompt, overriding the server's flag in both
   * directions: effective = `cap.alwaysLoad ?? server.alwaysLoad`. Same budget as the
   * server-level field — paid in the turn-1 prompt of EVERY pass — so it needs a measured
   * justification here, at the definition site.
   *
   * It exists because pinning a whole server to reach one tool pays for its siblings too.
   * The case that forced it: arming a commitment has to be callable with no ToolSearch
   * round-trip, and "what's armed" has to be answerable the same way, but cancelling does
   * not — pinning the server would have bought three schemas nobody reads in a normal turn.
   */
  alwaysLoad?: boolean;
  /**
   * Opt out of the naming rule (tool name must not restate its server key), with the reason.
   * On the definition rather than in a style-exemption table, because a table of exemptions
   * living somewhere else is the same rot this whole rewrite is removing.
   */
  namingException?: string;
  handler: (args: Record<string, any>) => Promise<string>;
}

export interface ServerSpec {
  /** The `mcp__<key>__…` prefix. Lowercase; `-` allowed only for mcp.json servers that use it. */
  key: string;
  kind: ServerKind;
  /** One line: what domain this server owns. */
  purpose: string;
  exposure: Exposure;
  /** Why it isn't in every lane. REQUIRED unless exposure is "both" — a bare name is what rots. */
  reason?: string;
  /**
   * Pin EVERY capability of this server into every turn-1 prompt instead of deferring behind
   * ToolSearch. Costs real prompt budget in EVERY pass, so it needs a measured justification
   * at the definition site. A single capability can be pinned (or held back) on its own with
   * `Capability.alwaysLoad`, which wins over this flag.
   */
  alwaysLoad?: boolean;
  /** Empty/omitted only for `kind: "external"`, whose tools live in another process. */
  capabilities?: readonly Capability[];
}

export interface ServerDefinition extends ServerSpec {
  capabilities: readonly Capability[];
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$/;
const TOOL_RE = /^[a-z][a-z0-9_]*$/;

function fail(msg: string): never {
  // Throwing at module load is deliberate: a malformed definition is a wiring bug, and the
  // whole point of this rewrite is that wiring bugs stop being discoverable only at 3am.
  throw new Error(`tool registry: ${msg}`);
}

/**
 * Validate and freeze one server definition. Called at module load, throws on any unmade
 * decision — that is the enforcement half of "defined once, cleanly".
 */
export function defineServer(spec: ServerSpec): ServerDefinition {
  const { key, kind, purpose, exposure, reason, capabilities = [] } = spec;

  if (!KEY_RE.test(key)) fail(`server key "${key}" must be lowercase snake_case`);
  if (!purpose.trim()) fail(`server "${key}" needs a one-line purpose`);
  if (exposure !== "both" && !reason?.trim()) {
    fail(`server "${key}" has exposure "${exposure}" and must say why — an exclusion without a written reason is what rotted last time`);
  }
  if (exposure === "both" && reason?.trim()) {
    fail(`server "${key}" is in both lanes but carries an exclusion reason — say it in \`purpose\` instead`);
  }
  if (kind === "external") {
    if (capabilities.length) fail(`external server "${key}" cannot declare capabilities — its tools live in another process`);
  } else if (!capabilities.length) {
    fail(`server "${key}" declares no capabilities`);
  }

  const seen = new Set<string>();
  for (const c of capabilities) {
    if (!TOOL_RE.test(c.name)) fail(`tool "${key}.${c.name}" must be lowercase snake_case`);
    if (seen.has(c.name)) fail(`tool "${key}.${c.name}" is declared twice`);
    seen.add(c.name);
    if (!c.purpose.trim()) fail(`tool "${key}.${c.name}" needs a one-line purpose`);
    if (!c.description.trim()) fail(`tool "${key}.${c.name}" needs a model-facing description`);
    if (c.fallback && !c.fallbackReason?.trim()) {
      fail(`tool "${key}.${c.name}" sets fallback="${c.fallback}" without a reason`);
    }
    // The naming rule, enforced rather than asked for. A name that restates its server key
    // (`mcp__flip__flip_login`, `mcp__fig_tools__fetch_url`) is how a surface drifts into
    // having two spellings for one idea.
    if (!c.namingException && restatesServerKey(key, c.name)) {
      fail(
        `tool "${key}.${c.name}" restates its server key — publish it as \`mcp__${key}__<verb>\`, or set \`namingException\` with the reason it has to stay`,
      );
    }
  }

  return Object.freeze({ ...spec, capabilities: Object.freeze([...capabilities]) });
}

/** Does the tool name repeat any token of the server key? (`flip` in `flip_login`.) */
export function restatesServerKey(serverKey: string, toolName: string): boolean {
  const keyTokens = new Set(serverKey.split(/[_-]/).filter(Boolean));
  return toolName.split("_").some((t) => keyTokens.has(t));
}

/** The name the Claude lanes publish: `mcp__<server>__<tool>`. */
export function fullName(serverKey: string, toolName: string): string {
  return `mcp__${serverKey}__${toolName}`;
}

/**
 * The name the Codex stdio fallback publishes.
 *
 * The fallback is ONE flat MCP server (Codex is configured with exactly one `fig_tools` block
 * and that config must not change), so the server key has to be folded into the tool name or
 * `reminders.list` and `scheduled_tasks.list` collide. It is DERIVED — a pure function of the
 * definition, not a second authored name — which is the whole difference between this and the
 * fig_tools array it replaces.
 */
export function fallbackName(serverKey: string, toolName: string): string {
  return `${serverKey}__${toolName}`;
}

/** The derived JSON Schema for a capability's input. */
export function capabilitySchema(c: Capability): Record<string, unknown> {
  return inputJsonSchema(c.input);
}

/**
 * Is this capability in the turn-1 prompt? The capability's own flag wins over the server's,
 * so a server can be partly pinned — and so anything reporting on the pinned set (the context
 * report, the inventory, the budget tripwires) has ONE place to ask.
 */
export function isPinned(server: Pick<ServerSpec, "alwaysLoad">, c: Capability): boolean {
  return c.alwaysLoad ?? server.alwaysLoad ?? false;
}

/**
 * Build the SDK MCP server for a definition.
 *
 * NOT memoised, and that is the point: an in-process SDK server instance can be mounted by
 * exactly one open query (see runtimes/mcpInstances.ts), so every caller needs its own. The
 * definition is the template; this makes an instance.
 */
export function toSdkServer(def: ServerDefinition): McpServerConfig {
  if (def.kind === "external") fail(`external server "${def.key}" has no in-process instance`);
  return createSdkMcpServer({
    name: def.key,
    version: "1.0.0",
    // The pin is applied PER TOOL even when the flag is server-level. The SDK ORs its
    // server-level `alwaysLoad` with the per-tool one, so passing both would make a
    // capability-level opt-OUT inexpressible. Both paths land the identical
    // `_meta["anthropic/alwaysLoad"]`, so a wholly-pinned server is unchanged by this.
    tools: def.capabilities.map((c) =>
      tool(
        c.name,
        c.description,
        c.input,
        async (args) => text(await c.handler((args ?? {}) as Record<string, any>)),
        isPinned(def, c) ? { alwaysLoad: true } : undefined,
      ),
    ),
  }) as McpServerConfig;
}
