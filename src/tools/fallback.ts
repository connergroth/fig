import { capabilitySchema } from "./define";
import { allCapabilities, type RegisteredCapability } from "./registry";

/**
 * The Codex stdio fallback surface — DERIVED, not authored.
 *
 * What this replaces: `figTools`, a hand-written array of 19 tool objects that was the ONLY
 * place `policy.fallback` lived, and which doubled as a second publication surface into the
 * Claude lanes. 16 of its 19 entries were re-publications of capabilities other servers already
 * owned, under different names, which is how a server-level lane exclusion could be walked
 * around by reaching for the bundle's copy instead. Killing the array as a *publication*
 * surface and keeping it as a *transport* is the whole shape of this rewrite.
 *
 * The transport constraint that keeps `fig_tools` alive as a name: Codex is configured with
 * exactly ONE mcp_servers block (`runtimes/codex.ts` → `codexFigToolsArgs`), spawning one
 * process that runs `runtimes/fig-tools-mcp.ts`. That config must not change. So the fallback
 * is one FLAT MCP server, and the server key has to be folded into each tool name or
 * `reminders.list` and `scheduled_tasks.list` collide. `fallbackName()` does that folding as a
 * pure function of the definition — a derived encoding, not a second authored name, which is
 * exactly the difference between this and what it replaces.
 *
 * Default is DENY. A newly added tool is not fallback-published by accident; someone has to
 * write `fallback: "allow"` and say why. That preserves the pre-rewrite set exactly: the same
 * 16 capabilities reach Codex, and the three `jobs_*` still don't (the job registry lives in
 * the main process, so an out-of-process runtime would only ever see an empty one).
 */
export function fallbackCapabilities(): RegisteredCapability[] {
  return allCapabilities().filter((c) => c.capability.fallback === "allow");
}

export function fallbackCapabilityByName(name: string): RegisteredCapability | undefined {
  return fallbackCapabilities().find((c) => c.fallbackName === name);
}

export function fallbackAllows(name: string): boolean {
  return fallbackCapabilityByName(name) !== undefined;
}

/** The MCP `tools/list` payload, with JSON Schema derived from each capability's Zod shape. */
export function fallbackToolList(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return fallbackCapabilities().map(({ capability, fallbackName }) => ({
    name: fallbackName,
    description: capability.notes ? `${capability.description}\nPolicy: ${capability.notes}` : capability.description,
    inputSchema: capabilitySchema(capability),
  }));
}

/** Comma-separated names, embedded in the Codex system prompt. */
export function fallbackToolNames(): string {
  return fallbackCapabilities()
    .map((c) => c.fallbackName)
    .join(", ");
}

/** The MCP `initialize` instructions string. */
export function fallbackInstructions(): string {
  return [
    "Safe fig tools for fallback runtimes.",
    `Available tools: ${fallbackToolNames()}.`,
    "Use these instead of guessing when you need URL content, the owner's live location, reminders, scheduled tasks, or fig's AgentMail inbox.",
    "This server intentionally cannot launch coding delegation or deep research.",
  ].join(" ");
}
