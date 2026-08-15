/**
 * Measure the ACTUAL tool surface of an unattended (scheduled) pass, empirically.
 *
 * Two things this answers that no amount of reading the code can:
 *  1. Which tools the CLI puts in the turn-1 prompt vs which it DEFERS behind ToolSearch —
 *     read off the CLI's own debug log ("Dynamic tool loading: N/M deferred tools included"),
 *     not inferred from the config.
 *  2. Whether an in-process SDK MCP tool that is NOT pinned with `alwaysLoad` is actually
 *     reachable from that lane via `ToolSearch select:<name>`. Reachability is easy to
 *     assume and expensive to be wrong about, so this measures it.
 *
 * Usage:
 *   tsx scripts/dev/tool-surface.ts scheduled            # the real lane, via scheduledPassOptions()
 *   tsx scripts/dev/tool-surface.ts baseline             # the hand-listed subset, as a comparison
 *   tsx scripts/dev/tool-surface.ts live
 *   tsx scripts/dev/tool-surface.ts scheduled --probe mcp__location__where_is
 *   tsx scripts/dev/tool-surface.ts scheduled --json     # machine-readable, for before/after diffs
 */
import "dotenv/config";

import { query, type McpServerConfig, type Options } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";

import { config } from "../../src/core/config";
import { fetchServer } from "../../src/fetch/tool";
import { locationServer } from "../../src/location/tools";
import { researchServer } from "../../src/research/tool";
import { loadMcpServers } from "../../src/runtimes/mcp";
import { buildScheduledMcpServers, disallowedToolsForLane } from "../../src/scheduling/lane";
import { remindersServer } from "../../src/scheduling/reminders-tools";
import { scheduledPassOptions } from "../../src/scheduling/scheduler";
import { scheduledTasksServer } from "../../src/scheduling/scheduledTasks-tools";
import { buildFigMcpServers } from "../../src/session/session";
import { calendarServer } from "../../src/google/calendar-tools";
import { gmailServer } from "../../src/google/tools";
import { browseServer } from "../../src/specialists/browser";
import { codexServer } from "../../src/specialists/codex";
import { jobsServer } from "../../src/specialists/jobs";
import { memoryServer } from "../../src/memory/tools";

/**
 * A hand-listed subset of the scheduled lane's servers, kept as the comparison target for
 * `baseline` mode. What it demonstrates is the SHAPE — a map someone maintained by hand,
 * missing seven servers the derived one includes — not its exact membership, so swapping a
 * member for its current equivalent doesn't change the point.
 */
function baselineScheduledServers(): Record<string, McpServerConfig> {
  const fileMcp = loadMcpServers();
  delete (fileMcp as Record<string, unknown>).browser;
  return {
    ...fileMcp,
    gmail: gmailServer,
    calendar: calendarServer,
    codex: codexServer,
    browse: browseServer,
    jobs: jobsServer,
    reminders: remindersServer,
    memory: memoryServer,
    research: researchServer,
    location: locationServer,
    fetch: fetchServer,
    scheduled_tasks: scheduledTasksServer,
  };
}

const lane = (process.argv[2] || "scheduled") as "scheduled" | "live" | "baseline";
const jsonOnly = process.argv.includes("--json");
const probeIdx = process.argv.indexOf("--probe");
const probe = probeIdx >= 0 ? process.argv[probeIdx + 1] : "mcp__jobs__list";

const say = (...a: unknown[]) => {
  if (!jsonOnly) console.log(...a);
};

/**
 * Per-server inventory of the in-process SDK tools, with a consistent proxy for prompt
 * cost: fully-qualified name + description + serialized input schema, i.e. the same three
 * things the CLI itself sums when it sizes deferred tools (isToolSearchEnabled's char
 * fallback). File-based (stdio/http) servers have no local instance and are skipped.
 */
function sdkToolInventory(servers: Record<string, McpServerConfig>) {
  const out: {
    server: string;
    tools: string[];
    alwaysLoad: boolean;
    chars: number;
    /** The pinned tools and what each costs — a server can be PARTLY pinned. */
    pinned: { name: string; chars: number }[];
  }[] = [];
  for (const [key, cfg] of Object.entries(servers)) {
    const inst = (cfg as { instance?: { _registeredTools?: Record<string, unknown> } }).instance;
    if (!inst?._registeredTools) continue;
    const tools = Object.keys(inst._registeredTools);
    let chars = 0;
    const pinned: { name: string; chars: number }[] = [];
    for (const [toolName, def] of Object.entries(inst._registeredTools)) {
      const d = def as { description?: string; inputSchema?: unknown; _meta?: Record<string, unknown> };
      let toolChars = `mcp__${key}__${toolName}`.length + String(d?.description ?? "").length;
      try {
        toolChars += JSON.stringify(d?.inputSchema ?? {}).length;
      } catch {
        /* zod shapes can be circular; name+description dominates anyway */
      }
      chars += toolChars;
      if (d?._meta?.["anthropic/alwaysLoad"] === true) pinned.push({ name: `mcp__${key}__${toolName}`, chars: toolChars });
    }
    out.push({ server: key, tools, alwaysLoad: pinned.length > 0, chars, pinned });
  }
  return out.sort((a, b) => a.server.localeCompare(b.server));
}

function pinnedTools(inv: ReturnType<typeof sdkToolInventory>) {
  return inv.flatMap((s) => s.pinned).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `--exec` mode: don't just load the schema, actually INVOKE the deferred tool. This is the
 * end-to-end proof that a lane can reach a newly-wired in-process server — schema retrieval
 * alone would still pass if the server were registered but unreachable.
 */
const EXEC_PROMPT = `Do exactly this, then stop.

1. Call ToolSearch with the query "select:${probe}".
2. Then actually CALL ${probe} with minimal/default arguments.
3. Reply with a single JSON object and nothing else:
   {"loaded": <true if step 1 returned a <functions> block>, "called": <true if step 2 returned a tool result rather than an error>, "resultHead": "<first 200 chars of the tool's result>"}

Do not use any other tool.`;

const PROMPT = `Answer with a single JSON object and NOTHING else. Do not use any tool except ToolSearch.

1. "reminderToolNames": the exact list of tool names listed in the system-reminder that names deferred tools available via ToolSearch. If there is no such system-reminder, use [].
2. "probeLoaded": call ToolSearch exactly once with the query "select:${probe}". Set this to true if the result contained a <functions> block defining ${probe}, false if it said no matching deferred tools were found.
3. "probeRaw": the first 200 characters of that ToolSearch result.

Output only the JSON object.`;

async function main() {
  const servers: Record<string, McpServerConfig> =
    lane === "live"
      ? buildFigMcpServers()
      : lane === "baseline"
        ? baselineScheduledServers()
        : buildScheduledMcpServers();

  const inventory = sdkToolInventory(servers);
  const pinned = pinnedTools(inventory);
  // Summed over pinned TOOLS, not pinned servers: a server can be partly pinned, and charging
  // the whole server for it would overstate the turn-1 bill.
  const pinnedChars = pinned.reduce((n, t) => n + t.chars, 0);
  const allChars = inventory.reduce((n, s) => n + s.chars, 0);

  const debugFile = `/tmp/fig-tool-surface-${lane}.log`;
  try {
    fs.unlinkSync(debugFile);
  } catch {
    /* first run */
  }

  // The REAL scheduled-pass options for the scheduled lane — same object the scheduler
  // hands every skill/task/watch/goal — so this measures the shipping path, not a replica.
  const base: Options =
    lane === "scheduled"
      ? (scheduledPassOptions() as Options)
      : {
          cwd: config.brainDir,
          mcpServers: servers,
          settingSources: ["project"],
          // Derived, not hand-written — the point of this script is to measure the real
          // lane, and a literal here would drift off lane.ts the same way scheduler.ts did.
          disallowedTools: disallowedToolsForLane("live"),
          permissionMode: "bypassPermissions",
        };
  const options: Options = { ...base, mcpServers: servers, debug: true, debugFile };

  let initTools: string[] = [];
  let finalText = "";
  const toolCalls: string[] = [];

  const exec = process.argv.includes("--exec");
  for await (const msg of query({ prompt: exec ? EXEC_PROMPT : PROMPT, options }) as AsyncIterable<any>) {
    if (msg.type === "system" && msg.subtype === "init") initTools = msg.tools ?? [];
    else if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") toolCalls.push(b.name);
        if (b.type === "text" && b.text.trim()) finalText = b.text;
      }
    } else if (msg.type === "result" && typeof msg.result === "string" && msg.result.trim()) {
      finalText = msg.result;
    }
  }

  // "Dynamic tool loading: L/D deferred tools included" is the CLI's own accounting:
  // D = deferred registry size, L = how many were pulled into the prompt so far.
  let deferredTotal: number | null = null;
  let toolSearchDisabled: string[] = [];
  try {
    const dbg = fs.readFileSync(debugFile, "utf8");
    const m = [...dbg.matchAll(/Dynamic tool loading: (\d+)\/(\d+) deferred tools included/g)];
    if (m.length) deferredTotal = Number(m[0][2]);
    toolSearchDisabled = [...new Set([...dbg.matchAll(/Tool search disabled[^\n]*/g)].map((x) => x[0]))];
  } catch {
    /* debug file missing — reported as null */
  }

  const mcpToolNames = initTools.filter((t) => t.startsWith("mcp__")).sort();
  const summary = {
    lane,
    probe,
    inProcessServerCount: inventory.length,
    inProcessToolCount: inventory.reduce((n, s) => n + s.tools.length, 0),
    initToolCount: initTools.length,
    initMcpToolCount: mcpToolNames.length,
    deferredRegistrySize: deferredTotal,
    alwaysLoadPinned: pinned.map((t) => t.name),
    pinnedPromptChars: pinnedChars,
    allInProcessChars: allChars,
    toolSearchDisabled,
    inProcess: inventory.map((s) => ({
      server: s.server,
      tools: s.tools.length,
      alwaysLoad: s.alwaysLoad,
      pinnedTools: s.pinned.length,
      chars: s.chars,
    })),
    modelToolCalls: toolCalls,
    modelReport: finalText.slice(0, 4000),
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

void main();
