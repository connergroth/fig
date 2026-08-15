/**
 * Cheap, human-readable "what's it doing right now" summaries for the job board.
 *
 * Both async engines (the SDK-driven browser/claude-code specialists, and the raw
 * Codex CLI child process) surface tool calls in different shapes — this module turns
 * either into a single short one-liner, overwritten in place on the job (see jobs.ts),
 * never accumulated into a log. Just enough to tell "stuck on a selector" apart from
 * "actively working" without paying for a full transcript.
 */

const MAX_LEN = 100;

function clip(s: string, max = MAX_LEN): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Summarize a Claude Agent SDK tool_use block (name + input) into one short line.
 * Covers the browser (@playwright/mcp) and coding (Read/Edit/Bash/Grep/Glob) tool
 * surfaces by name; anything unrecognized falls back to a generic "tool: arg" shape
 * so a brand-new tool still produces something readable instead of nothing.
 */
export function summarizeToolUse(name: string, input: unknown): string {
  // Strip the mcp__<server>__ prefix so e.g. "mcp__browser__browser_navigate" reads
  // as "browser_navigate" below.
  const short = name.replace(/^mcp__[^_]+__/, "");
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  switch (short) {
    case "browser_navigate":
      return clip(`navigating to ${pick("url") ?? "…"}`);
    case "browser_navigate_back":
      return "navigating back";
    case "browser_click":
      return clip(`clicking ${pick("element", "target") ?? "an element"}`);
    case "browser_type":
      return clip(`typing into ${pick("element", "target") ?? "a field"}`);
    case "browser_press_key":
      return clip(`pressing key ${pick("key") ?? ""}`);
    case "browser_hover":
      return clip(`hovering ${pick("element", "target") ?? "an element"}`);
    case "browser_select_option":
      return clip(`selecting an option in ${pick("element", "target") ?? "a field"}`);
    case "browser_fill_form":
      return "filling out a form";
    case "browser_file_upload":
      return "uploading a file";
    case "browser_snapshot":
      return "reading the page snapshot";
    case "browser_take_screenshot":
      return "taking a screenshot";
    case "browser_wait_for":
      return "waiting on the page";
    case "browser_tabs":
      return "managing browser tabs";
    case "browser_evaluate":
    case "browser_run_code_unsafe":
      return "running page script";
    case "browser_drag":
    case "browser_drop":
      return "dragging an element";
    case "browser_handle_dialog":
      return "handling a browser dialog";
    case "browser_close":
      return "closing the browser";
    case "Read":
      return clip(`reading ${pick("file_path") ?? "a file"}`);
    case "Write":
      return clip(`writing ${pick("file_path") ?? "a file"}`);
    case "Edit":
      return clip(`editing ${pick("file_path") ?? "a file"}`);
    case "Bash":
      return clip(`running bash: ${pick("command") ?? "…"}`, 120);
    case "Grep":
      return clip(`searching for ${pick("pattern") ?? "…"}`);
    case "Glob":
      return clip(`listing files matching ${pick("pattern") ?? "…"}`);
    default: {
      const arg = pick("url", "target", "element", "path", "file_path", "command", "pattern", "query", "text");
      return arg ? clip(`${short}: ${arg}`) : short.replace(/_/g, " ") || "working";
    }
  }
}

/**
 * Summarize one `codex exec --json` JSONL event into a one-liner, or undefined if
 * it's not worth surfacing (final agent text, reasoning chatter, turn bookkeeping).
 * Only `item.started` events are treated as "step began" progress — a job stuck on
 * one started-but-never-completed item is exactly the "hung" signal this exists for.
 */
export function summarizeCodexEvent(evt: unknown): string | undefined {
  const e = (evt && typeof evt === "object" ? evt : {}) as Record<string, unknown>;
  if (e.type !== "item.started") return undefined;
  const item = (e.item && typeof e.item === "object" ? e.item : {}) as Record<string, unknown>;
  const itemType = typeof item.type === "string" ? item.type : undefined;
  switch (itemType) {
    case "command_execution":
      return clip(`running: ${String(item.command ?? "…")}`, 120);
    case "file_change":
      return clip(`editing ${String(item.path ?? item.file ?? "a file")}`);
    case "mcp_tool_call":
      return clip(`calling ${String(item.tool ?? item.server ?? "a tool")}`);
    case "web_search":
      return clip(`searching: ${String(item.query ?? "…")}`);
    case "agent_message":
    case "reasoning":
      return undefined; // final/near-final text or internal chatter, not a discrete step
    default:
      return itemType ? `codex: ${itemType}` : undefined;
  }
}
