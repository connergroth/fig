import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { recallStats, resolveSpeaker, searchConversationsDetailed, speakerFilterValues } from "./conversationSource";

/**
 * fig's recall over its own long-term record.
 *
 * The third capability that was genuinely unique to the old `fig_tools` bundle. Named for the
 * DOMAIN (`memory`) rather than the corpus (`conversations`), deliberately: email is the next
 * corpus to land here, and it should arrive as `mcp__memory__recall_email` beside this one
 * rather than as another top-level server. The tool keeps `recall_conversations` because it
 * names which corpus it searches, which is exactly the distinction that will matter once
 * there's more than one.
 */
export const memoryServerDef = defineServer({
  key: "memory",
  kind: "direct",
  purpose: "hybrid keyword + semantic recall over fig's long-term record of the owner",
  exposure: "both",
  capabilities: [
    {
      name: "recall_conversations",
      purpose: "ranked snippets from the full iMessage history — the only sanctioned way to search Conversations/",
      mutates: "read",
      fallback: "allow",
      fallbackReason:
        "a read over the local index; was fallback-published before the rewrite as fig_tools.recall_conversations",
      description:
        "Search the full iMessage history with the owner (every message ever) and get back ranked snippets — " +
        "not whole messages. This is the ONLY way to search Conversations/ — grepping the folder is blocked by the " +
        "harness, because a grep there returns entire messages and one common word can blow 60k+ tokens of context. " +
        "(Reading one specific dated transcript end-to-end is still fine and sometimes right.) Search is HYBRID — keyword matching fused with " +
        "semantic similarity — so you do NOT have to guess the owner's exact words. Asking in your own phrasing works: " +
        "'the guy from apple nyc' finds the message naming them. Plain natural-language questions are fine and often " +
        "better than keyword soup. \"Quoted phrases\" still match exactly when you do know the wording. Optional: " +
        "speaker ('owner' or 'agent'; the configured names also work) to search only one side, since/until as YYYY-MM-DD, limit (default 15, max 50). " +
        "Results are best-match-first, «guillemets» around a keyword hit. Snippets are windows — if you need the full " +
        "message, the date+time in each result tells you which line of Conversations/YYYY-MM/YYYY-MM-DD.md to read.",
      input: {
        query: z
          .string()
          .describe("what you're looking for — a natural-language question or keywords, both work"),
        // Derived from OWNER_NAME/AGENT_NAME, not hardcoded names — a stranger's
        // owner label must be filterable without editing this file.
        speaker: z.enum(speakerFilterValues()).optional().describe("only search one side of the conversation"),
        since: z.string().optional().describe("earliest date, YYYY-MM-DD"),
        until: z.string().optional().describe("latest date, YYYY-MM-DD"),
        limit: z.number().optional().describe("max results, default 15, hard max 50"),
      },
      handler: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) return "recall_conversations needs a query.";
        try {
          const res = await searchConversationsDetailed({
            query,
            speaker: args.speaker ? resolveSpeaker(String(args.speaker)) : undefined,
            since: args.since,
            until: args.until,
            limit: typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 15,
          });
          if (!res.results.length) {
            const s = recallStats();
            return `No matches for "${query}" in ${s.messages} messages (${s.firstDate} → ${s.lastDate}). Try fewer or more common words.`;
          }
          const lines = res.results.map(
            (r) => `${r.date} ${r.time} ${r.speaker}: ${r.snippet.replace(/\s*\n+\s*/g, " ")}`,
          );
          const dropped = res.droppedForBudget ? `, ${res.droppedForBudget} trimmed to fit` : "";
          const more = res.totalHits > res.shown ? ` (best ${res.shown} of ${res.totalHits} total hits${dropped})` : "";
          return `${lines.join("\n")}\n— ${res.shown} shown${more}`;
        } catch (e) {
          return `recall_conversations failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const memoryServer = toSdkServer(memoryServerDef);
