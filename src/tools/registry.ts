import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { ackServerDef } from "../ack/tools";
import { facetimeServerDef } from "../call/tools";
import { agentmailInboxServerDef } from "../agentmail/tools";
import { fetchServerDef } from "../fetch/tool";
import { calendarServerDef } from "../google/calendar-tools";
import { gmailServerDef } from "../google/tools";
import { imageServerDef } from "../image/tools";
import { locationServerDef } from "../location/tools";
import { mailSearchServerDef } from "../mail/searchAll";
import { outlookServerDef } from "../mail/tools";
import { mapsServerDef } from "../maps/tools";
import { memoryServerDef } from "../memory/tools";
import { pangramServerDef } from "../pangram/tools";
import { researchServerDef } from "../research/tool";
import { remindersServerDef } from "../scheduling/reminders-tools";
import { scheduledTasksServerDef } from "../scheduling/scheduledTasks-tools";
import { browseServerDef } from "../specialists/browser";
import { claudeCodeServerDef } from "../specialists/claude-code";
import { codexServerDef } from "../specialists/codex";
import { jobsServerDef } from "../specialists/jobs";
import { ttsServerDef } from "../tts/tools";
import { usageServerDef } from "../usage/tools";
import { voiceServerDef } from "../voice/tools";
import { webExportServerDef } from "../webExport/tools";
import { fallbackName, fullName, toSdkServer, type Capability, type ServerDefinition } from "./define";
import { EXTERNAL_SERVERS } from "./external";

/**
 * THE index. Every capability fig publishes, defined exactly once, in one list.
 *
 * This file deliberately holds no data of its own — it imports definitions and orders them.
 * The definitions live next to their handlers, because a declaration that sits far away from
 * the thing it governs is precisely what rotted: the lane maps, `FIG_DISALLOWED_TOOLS`,
 * `FILE_MCP_REVIEWED`, and the fig_tools `policy.fallback` field were each a hand-kept list
 * somewhere else, and every one of them drifted from what it described.
 *
 * What derives from here, with no second list anywhere:
 *   - both agent lanes and the exclusions between them            (scheduling/lane.ts)
 *   - the Codex stdio fallback server's tool list and schemas      (runtimes/fig-tools-mcp.ts)
 *   - the generated inventory doc                                  (scripts/dev/tool-inventory.ts)
 *   - skill `requiredTools` resolution and the lint behind it      (scheduling/requiredTools.ts)
 *
 * ADDING A TOOL: see `docs/adding-a-tool.md`.
 */

/**
 * The personal-tools seam. `src/tools/personal/` is gitignored: it holds the owner-specific
 * servers (lights, music, flip, …) behind their own mini-registry, `PERSONAL_SERVERS`, and a
 * public checkout simply doesn't have the directory. A static import would make that private
 * dir a build dependency for everyone, so the load is a runtime `require` that treats "the
 * seam module itself is absent" as "no personal tools". Anything else — including a
 * MODULE_NOT_FOUND from a module *inside* personal/ — still throws, so a broken personal
 * module fails loudly instead of its tools silently vanishing from the surface.
 */
function loadPersonalServers(): readonly ServerDefinition[] {
  try {
    return (require("./personal") as { PERSONAL_SERVERS?: readonly ServerDefinition[] }).PERSONAL_SERVERS ?? [];
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "MODULE_NOT_FOUND" && String(err.message).includes("./personal")) return [];
    throw e;
  }
}

export const IN_PROCESS_SERVERS: readonly ServerDefinition[] = [
  // specialists — thin one-tool delegators; the heavy MCP loads inside their sub-query.
  // Mail and calendar used to be here too (`mcp__email__ask`, `mcp__calendar__ask`) and are
  // now plain deferred servers below: a specialist earns its place when the work is long and
  // its output is big, not when it's one call and one answer. What the wrapper actually cost
  // was an extra LLM run per question and LOSSINESS — fig saw the subagent's prose, not the
  // tool's output, and relayed "no CTC message has ever arrived" when the truth was "25 hits,
  // none matching" from an INBOX-only search. A summary can't be re-examined.
  claudeCodeServerDef, // DEFAULT coding-delegation engine (Claude subagent); codex is the alt engine
  codexServerDef,
  browseServerDef,
  jobsServerDef, // unified control plane for all async background jobs (browse, codex, ...)
  // direct tools the orchestrator uses itself
  ackServerDef,
  gmailServerDef,
  outlookServerDef, // the owner's non-Gmail accounts (school Exchange + a personal domain)
  mailSearchServerDef, // find-a-message: one call spanning both backends and every folder
  calendarServerDef,
  remindersServerDef,
  scheduledTasksServerDef,
  researchServerDef,
  locationServerDef,
  mapsServerDef, // live drive time / traffic; the commute watch's whole job runs through it
  fetchServerDef,
  voiceServerDef,
  facetimeServerDef, // call the owner on the free FaceTime lane (voice = Vapi = businesses)
  imageServerDef,
  ttsServerDef, // local Kokoro TTS — the free/unlimited audio lane; ElevenLabs stays the publish lane
  agentmailInboxServerDef,
  pangramServerDef, // "is this AI-written" — evidence, never proof; text leaves the mini
  // memory was one of the three capabilities genuinely unique to the old fig_tools bundle
  // (with lights and web_export), given real homes so the bundle could stop existing
  memoryServerDef,
  webExportServerDef,
  usageServerDef, // Claude Code + Codex rate-limit windows; read-only on CLI creds, never refreshes
  // owner-specific servers (lights, music, flip, …) — in-process like everything above, but
  // sourced from the gitignored personal/ seam so they never become a public build dependency
  ...loadPersonalServers(),
];

/** Every server fig knows about — in-process and file-mcp alike. */
export const ALL_SERVERS: readonly ServerDefinition[] = [...IN_PROCESS_SERVERS, ...EXTERNAL_SERVERS];

const BY_KEY = new Map(ALL_SERVERS.map((s) => [s.key, s]));

// Two servers claiming the same `mcp__<key>__` prefix would silently shadow each other.
// Cheap to check, and it runs at module load like every other invariant in this layer.
if (BY_KEY.size !== ALL_SERVERS.length) {
  const seen = new Set<string>();
  const dupes = ALL_SERVERS.map((s) => s.key).filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  throw new Error(`tool registry: duplicate server key(s): ${[...new Set(dupes)].join(", ")}`);
}

export function serverByKey(key: string): ServerDefinition | undefined {
  return BY_KEY.get(key);
}

export interface RegisteredCapability {
  server: ServerDefinition;
  capability: Capability;
  /** `mcp__<server>__<tool>` — the name the Claude lanes publish. */
  name: string;
  /** `<server>__<tool>` — the derived name the flat Codex stdio fallback publishes. */
  fallbackName: string;
}

/** Every enumerable capability, flattened. External servers contribute none. */
export function allCapabilities(): RegisteredCapability[] {
  return ALL_SERVERS.flatMap((server) =>
    server.capabilities.map((capability) => ({
      server,
      capability,
      name: fullName(server.key, capability.name),
      fallbackName: fallbackName(server.key, capability.name),
    })),
  );
}

/** Resolve a fully-qualified `mcp__server__tool` name against the registry. */
export function capabilityByName(fullyQualified: string): RegisteredCapability | undefined {
  return allCapabilities().find((c) => c.name === fullyQualified);
}

/** Does the registry publish this fully-qualified name at all (in any lane)? */
export function isRegisteredToolName(fullyQualified: string): boolean {
  return capabilityByName(fullyQualified) !== undefined;
}

/** The write half of the surface — what a read-only grant would have to withhold. */
export function writeCapabilities(): RegisteredCapability[] {
  return allCapabilities().filter((c) => c.capability.mutates === "write");
}

/** Build a fresh SDK instance for one in-process server. */
export function instantiate(def: ServerDefinition): McpServerConfig {
  return toSdkServer(def);
}

/**
 * THE structural check that makes the old rename table deletable.
 *
 * 11 of the 16 duplicate publications were RENAMED pairs — `fig_tools.list_reminders` and
 * `reminders.list` were the same capability under different names, and nothing in the code
 * said so. The only way to know was a hand-authored table pairing them up, which is a
 * maintenance burden that would have rotted the moment someone added the next one.
 *
 * The insight that removes the table: two names for one capability means the SAME HANDLER
 * registered twice. Handler identity is checkable. So a duplicate publication is now a
 * structural property the code can see, under any names, forever — and if this ever returns
 * empty-handed while a duplicate exists, the duplicate is a genuine second implementation,
 * which the naming rule and the code review would both catch on the way in.
 */
export function duplicatePublications(): { handler: unknown; names: string[] }[] {
  const byHandler = new Map<unknown, string[]>();
  for (const c of allCapabilities()) {
    const list = byHandler.get(c.capability.handler) ?? [];
    list.push(c.name);
    byHandler.set(c.capability.handler, list);
  }
  return [...byHandler.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([handler, names]) => ({ handler, names: names.sort() }));
}
