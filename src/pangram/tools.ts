import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { detectAiText, formatDetection, pangramConfigured } from "./detect";

/**
 * AI-text detection, so "is this AI-written?" stops meaning "go open pangram.com and paste".
 *
 * NAMING, deliberately against the house rule. `docs/adding-a-tool.md` says a server is named
 * for the CAPABILITY, not the vendor (`lights`, not `govee`) — vendors get replaced. This one
 * is `pangram` anyway, on the owner's explicit call, and the reason it's defensible here is that
 * the vendor IS the claim: an AI-detection verdict is only interpretable if you know which
 * detector produced it and what its error profile is. "the ai_detector tool says 92% AI" is a
 * number with no provenance; "Pangram says 92%" is a citable one. If we ever add a second
 * detector, the right move is a `detectors` server with the vendor as an argument, not two
 * vendor servers.
 *
 * `mutates: "read"` — it computes and bills (~$0.05/1000 words, one $25 pack lasts years at
 * our volume), it changes nothing. Same class as the Google Directions call.
 *
 * `exposure: "both"` — read-only, and `fetch` (arbitrary URL egress) is already in both lanes,
 * so the data-egress authority is not new. The privacy rule is enforced by the description and
 * repeated in every result rather than by lane, because the risk isn't "3am pass" — it's
 * "pasted the wrong thing", which is equally possible live.
 *
 * `fallback` unset (= deny). The Codex in-child stdio surface is pinned to the pre-rewrite 16;
 * Codex-as-main reaches this through the tool bridge via `exposure` anyway.
 */
export const pangramServerDef = defineServer({
  key: "pangram",
  kind: "direct",
  purpose: "check whether a chunk of text was AI-generated, via Pangram's detection API",
  exposure: "both",
  capabilities: [
    {
      name: "detect",
      purpose: "one AI-detection read on pasted text — verdict, mix, flagged passages, caveats",
      mutates: "read",
      description:
        "Check whether text was AI-generated, using Pangram (the most accurate detector currently available — near-zero false positives on long passages). Paste the text in; returns a verdict (human / AI-assisted / AI / mixed), the % breakdown of the document, the specific passages it flagged with Pangram's own confidence, and explicit caveats. " +
        "TREAT THE RESULT AS EVIDENCE, NEVER AS PROOF — relay it with its caveats, and never state it as established fact or use it to accuse someone. Short samples (under ~50 words), heavily edited text, formulaic academic prose, and 'humanized' output all fool detectors, and a 'human' result does not prove human authorship either. " +
        "PRIVACY: the text is sent to Pangram's servers, so it LEAVES the mini. Do not feed it the owner's private Apple/work material, NDA'd docs, or other people's private messages — ask them first if it's anything sensitive. " +
        "Longer samples are much more reliable than short ones; prefer several paragraphs.",
      input: {
        text: z.string().min(1).describe("the text to check — paste it verbatim, longer is more reliable"),
        dashboard_link: z
          .boolean()
          .optional()
          .describe("ask Pangram for a shareable public result page (default false). Only when the owner wants a link to show someone."),
      },
      handler: async (args) => {
        const text = String(args.text ?? "");
        if (!text.trim()) return "pangram detect needs some text to check.";
        if (!pangramConfigured()) {
          return "Pangram isn't configured — tell the owner to set PANGRAM_API_KEY (key from pangram.com).";
        }
        const result = await detectAiText({ text, dashboardLink: !!args.dashboard_link });
        if (!result.ok) {
          // Say it failed rather than guessing. A hedged guess about authorship is exactly the
          // kind of answer this tool exists to replace.
          return `Pangram check failed: ${result.error}`;
        }
        return formatDetection(result.read);
      },
    },
  ],
});

export const pangramServer = toSdkServer(pangramServerDef);
