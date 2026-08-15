/**
 * Surface-correction hooks.
 *
 * Two families live here:
 *   1. PostToolUse surface notes — counter formatting orders baked into built-in
 *      tool descriptions (below).
 *   2. A PreToolUse redirect that stops SEARCHES over `Conversations/` from going
 *      through grep, since a ranked index tool exists and grep is both worse and
 *      far more expensive (one common word = 60k+ tokens of whole messages).
 *
 * Some built-in tools ship formatting instructions in their own descriptions that
 * assume a markdown-rendering surface. WebSearch, for example, ends its description
 * with "end with a 'Sources:' list of the URLs you used as markdown links" — correct
 * for a terminal/markdown client, wrong for an iMessage thread, where `[a](b)` lands
 * as literal brackets around a raw url.
 *
 * We can't edit a built-in tool's description (it lives inside the compiled CLI), so
 * we counter it at the point of use: a PostToolUse hook appends a surface note to the
 * tool's result, which the model reads immediately after the search output and right
 * before it writes the reply. Verified end-to-end — the note arrives verbatim.
 *
 * Keep this narrow. It's a correction for tools whose descriptions carry
 * surface-specific formatting orders, not a general place to bolt on instructions
 * (those belong in SOUL.md / the system prompt).
 */
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

/** Tools whose descriptions order markdown-formatted output. */
const MARKDOWN_ASSUMING_TOOLS = ["WebSearch", "WebFetch"];

const SURFACE_NOTE =
  "SURFACE NOTE (from the harness, overrides the tool's own formatting instructions): " +
  "this output is delivered to a plain-text iMessage thread with no markdown renderer. " +
  "IGNORE any instruction from this tool to close with a \"Sources:\" list of markdown links — " +
  "markdown link syntax, bold, headers and tables all render as literal characters here. " +
  "Cite sources by name in plain words; if a specific link is worth sending, put the bare url " +
  "on its own line.";

/**
 * SEARCHING `Conversations/` is the index tool's job; grep is not an alternate route.
 *
 * The distinction this enforces is search vs. read, NOT tool vs. folder:
 *   - denied  — Grep over Conversations/, or a shell search binary pointed at it.
 *               There is a strictly better path (`recall_conversations`: hybrid
 *               keyword + semantic, ranked, snippet-windowed, payload-capped).
 *   - allowed — Read/cat/head/tail of a specific transcript, and Glob enumeration.
 *               The nightly skills (recap, reflect, evening, winddown, dream) read a
 *               whole day in order; ranked snippets cannot substitute for that, and
 *               the index tool's own results point back at a file+line to read.
 *
 * Denying only the search half is what keeps behavior consistent instead of trading
 * one inconsistency for another.
 */
const CONVERSATIONS_DIR = "Conversations";

/** Shell binaries that constitute a search rather than a read. */
const SHELL_SEARCH_BINARIES = /\b(grep|egrep|fgrep|zgrep|rg|ag|ack|ripgrep)\b/;

const RECALL_REDIRECT =
  "Blocked by the harness: searching Conversations/ goes through the `recall_conversations` " +
  "tool, not grep. The tool is hybrid keyword + semantic search over the same log — it ranks " +
  "results, returns snippet windows instead of whole messages, and caps the payload. Grep here " +
  "returns entire messages, so one common word can burn 60k+ tokens and still miss anything you " +
  "didn't word exactly right. Call recall_conversations with a natural-language query instead. " +
  "(Reading a specific transcript file is still fine — this only blocks searching.)";

/** True when a Grep call is aimed at the conversation log. */
function grepTargetsConversations(input: Record<string, unknown>): boolean {
  const fields = [input.path, input.glob, input.pattern]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return fields.includes(CONVERSATIONS_DIR);
}

/** Commands that can hand the log to a search further down the line: `cd`, `find`, `ls`. */
const FEEDS_A_SEARCH = /^\s*(cd|find|ls)\b/;

/** A concrete single transcript — `2026-07-28.md`, no glob characters. */
const namesOneTranscript = (arg: string) => /\.md$/.test(arg) && !arg.includes("*");

/**
 * True when a shell command is a SEARCH aimed at the conversation log.
 *
 * What's actually being prevented is UNBOUNDED fan-out: one common word grepped across the
 * whole log returns entire messages and burns 60k+ tokens while still missing anything worded
 * differently. That's the thing `recall_conversations` replaces. Grep itself isn't the sin, so
 * the line is drawn at whether the command names its target:
 *
 *  - a directory, a glob, or a recursive sweep → DENIED, redirected to the tool
 *  - ONE named transcript file → allowed, same as `cat`/`tail` of it already is
 *
 * Three narrowings, each from a real false positive:
 *
 *  1. Quoted segments are stripped, so grepping OTHER trees for the literal string
 *     "Conversations/" — auditing which files mention it, or a commit message quoting the
 *     command it describes — isn't caught. The folder has to appear as a bare path.
 *  2. Only the arguments AFTER a search binary count, not the whole command line. Reading the
 *     entire string denied `cd …/Conversations/2026-07 && grep -n "07:0" 2026-07-28.md`, where
 *     the folder appears only in the `cd`.
 *  3. Naming a single `.md` transcript is allowed. Bounding a search to one day is the same
 *     cost as reading that day, which every nightly skill already does.
 *
 * The log can also reach a search INDIRECTLY — `cd` into it, or `find … | xargs grep`. So a
 * search that names no log path is still denied when an earlier segment put the log in its
 * way, unless the search names one concrete transcript. That keeps every whole-log shape
 * closed while letting a bounded single-day search through.
 *
 * The failure mode all of this fixes: matching a STRING instead of judging the OPERATION —
 * same shape as a guardrail that denies a plain read because the filename matched.
 */
function bashSearchesConversations(command: string): boolean {
  const unquoted = command.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
  const targetsLog = new RegExp(`(^|[\\s=./])${CONVERSATIONS_DIR}(/|\\b)`);
  // Split into pipeline/sequence segments so `cd X && grep …` is judged per command.
  const segments = unquoted.split(/\||;|&&|\n/);
  const upstreamTouchesLog = segments.some((s) => FEEDS_A_SEARCH.test(s) && targetsLog.test(s));
  for (const seg of segments) {
    const m = SHELL_SEARCH_BINARIES.exec(seg);
    if (!m) continue;
    const args = seg.slice(m.index + m[0].length).split(/\s+/).filter(Boolean);
    const logTargets = args.filter((a) => targetsLog.test(` ${a}`));
    if (logTargets.length > 0) {
      // Explicit log paths: denied unless EVERY one is a single concrete transcript.
      if (!logTargets.every(namesOneTranscript)) return true;
      continue;
    }
    // No log path of its own — but something upstream handed it the log.
    if (upstreamTouchesLog && !args.some(namesOneTranscript)) return true;
  }
  return false;
}

/** Shared decision logic, exported for tests. */
export function deniesAsConversationSearch(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "Grep") return grepTargetsConversations(input);
  if (toolName === "Bash") return typeof input.command === "string" && bashSearchesConversations(input.command);
  return false;
}

/**
 * PostToolUse hooks that patch surface assumptions baked into built-in tool descriptions,
 * plus the PreToolUse recall redirect.
 * Spread into an SDK `Options.hooks` for any query whose output reaches the owner.
 */
export const SURFACE_HOOKS: Partial<Record<"PostToolUse" | "PreToolUse", HookCallbackMatcher[]>> = {
  PreToolUse: [
    {
      matcher: "Grep|Bash",
      hooks: [
        async (input) => {
          const { tool_name: toolName, tool_input: toolInput } = input as {
            tool_name?: string;
            tool_input?: Record<string, unknown>;
          };
          if (!toolName || !deniesAsConversationSearch(toolName, toolInput ?? {})) return {};
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: RECALL_REDIRECT,
            },
          };
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: MARKDOWN_ASSUMING_TOOLS.join("|"),
      hooks: [
        async () => ({
          hookSpecificOutput: {
            hookEventName: "PostToolUse" as const,
            additionalContext: SURFACE_NOTE,
          },
        }),
      ],
    },
  ],
};
