import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * One in-process MCP server instance per open query.
 *
 * The constraint, measured rather than assumed (`scripts/dev/singleton-probe.ts`): an
 * in-process SDK MCP server instance can be mounted by exactly ONE open query. Hand the same
 * instance to a second query while the first is still open and it is silently dropped — the
 * second query comes up with ZERO MCP tools and no error anywhere. Sequential mounts are fine,
 * which is what makes this so good at hiding: any one-shot script measuring it in a quiet
 * process sees a perfectly healthy system.
 *
 * fig's process always has a long-lived query open (the interactive session), and it runs
 * overlapping queries constantly — scheduled passes, watches, background passes, and specialist
 * sub-queries that can fire concurrently with each other. Every one of those was mounting
 * module-level singletons somebody else already held. That is what actually caused six weeks of
 * scheduled passes silently hand-rolling Bash instead of calling the email/calendar specialists.
 *
 * The rule this module exists to enforce: **a module-level `xServer` export is a TEMPLATE, not
 * something to mount.** Anything that builds an `mcpServers` map for a query copies first.
 *
 * File-based (stdio/http) servers are returned untouched — the CLI spawns a process per query,
 * so they never had the problem.
 */
export function cloneInProcessServer(cfg: McpServerConfig): McpServerConfig {
  const inst = (cfg as { instance?: { _registeredTools?: Record<string, unknown> } }).instance;
  const registered = inst?._registeredTools;
  if (!registered) return cfg;
  const defs = Object.entries(registered) as [string, Record<string, any>][];
  return createSdkMcpServer({
    name: (cfg as { name?: string }).name ?? "",
    version: "1.0.0",
    // `alwaysLoad` lands in each tool's `_meta`, so it has to be read back off the tools and
    // re-applied TOOL BY TOOL. Losing it would quietly un-pin email + calendar from the turn-1
    // prompt of every lane; re-applying it server-wide would be just as wrong now that a server
    // can be partly pinned (scheduled_tasks pins schedule + list, not cancel) — the clone would
    // hand the model schemas the definition deliberately left deferred.
    tools: defs.map(([name, d]) =>
      tool(
        name,
        d?.description ?? "",
        d?.inputSchema?.shape ?? {},
        d?.handler,
        d?._meta?.["anthropic/alwaysLoad"] === true ? { alwaysLoad: true } : undefined,
      ),
    ),
  }) as McpServerConfig;
}

/** Fresh instances of every in-process server in a map. Call at mount time, per query. */
export function freshInstances(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, cloneInProcessServer(v)]));
}
