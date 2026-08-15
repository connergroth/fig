import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { enqueueResearch } from "./jobs";

/**
 * The deep-research tool, available to the orchestrator. It does NOT run the
 * research inline — that's a minutes-long parallel fan-out that would freeze the
 * chat turn. It enqueues a job and returns immediately; the background worker
 * (worker.ts) runs the pipeline, writes the full breakdown to the vault, and then
 * hands the result BACK to the orchestrator (a fresh "fig" pass) to package and
 * text the owner — the worker never texts them directly, because only the orchestrator
 * knows WHY this was run and what's relevant. So the agent's job here is just: fire
 * it (with `intent`), then tell the owner it's underway.
 */
export const researchServerDef = defineServer({
  key: "research",
  kind: "direct",
  purpose:
    "kick off a background multi-source deep-research investigation that lands a written breakdown in the vault",
  exposure: "live-only",
  reason:
    "deep_research is expensive and should only run in a live conversation, not from a scheduled pass",
  capabilities: [
    {
      name: "deep_research",
      purpose:
        "kick off a background multi-source deep-research investigation that lands a written breakdown in the vault",
      mutates: "write",
      namingException:
        "`deep_research` is an established concept in the system prompt, in the owner's own vocabulary and across the vault — the repeated token carries meaning here rather than restating the domain, unlike `flip_login` or `fig_tools__fetch_url`.",
      description:
        "Kick off genuine deep research on a question — a multi-source, fact-checked investigation that runs " +
        "in the background and lands a full written breakdown in the vault. Use this (not your own web search) " +
        "whenever the owner wants real depth, comparison, or a researched recommendation rather than a quick lookup. " +
        "Returns immediately. When it finishes (a few minutes), the result comes BACK TO YOU to package — you " +
        "write the text the owner gets, framed against why you ran it — it is NOT texted to them raw. So always pass " +
        "`intent`. After calling it, just tell them you're on it; do NOT research it yourself too.",
      input: {
        question: z.string().describe("the research question, phrased clearly and self-contained"),
        focus: z
          .string()
          .optional()
          .describe("constraints/angle that shape the RESEARCH itself: budget, region, timeframe, what to prioritize"),
        intent: z
          .string()
          .optional()
          .describe(
            "why you're running this and how the result will be used — the conversational context (e.g. 'part of " +
              "the next-project ideation hunt, screening for the frequency/habit filter'). This is fed back to you " +
              "later so you can package the findings for the owner with the right framing. Capture it now while you have it.",
          ),
      },
      handler: async (args) => {
        const job = enqueueResearch(args.question, args.focus, args.intent);
        return (
          `Deep-research job ${job.id} started for: "${job.question}". ` +
          `Tell the owner you're digging into it and will text them the findings when it's done (usually a few ` +
          `minutes). The result will come back to YOU to package — don't wait on it or research it yourself.`
        );
      },
    },
  ],
});

export const researchServer = toSdkServer(researchServerDef);
