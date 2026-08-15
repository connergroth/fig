import { z } from "zod";

import { defineServer } from "../tools/define";
import { callLaneStatus, dialOwner, hangupLiveCall } from "./lane";

/**
 * The FaceTime call lane's tool surface — how fig itself places/inspects calls to
 * THE OWNER on the free FaceTime pipe. Distinct from `voice` (Vapi), which
 * calls BUSINESSES on the errand lane at retail per-minute pricing; this server
 * only ever dials the owner, on the transport that costs nothing.
 */
export const facetimeServerDef = defineServer({
  key: "facetime",
  kind: "direct",
  purpose: "call the owner on the free FaceTime-audio lane (the mini's patched-BlackHole pipe), and check the lane's state",
  exposure: "both",
  capabilities: [
    {
      name: "dial",
      purpose: "ring the owner as a FaceTime audio call with the voice session pre-warmed",
      description:
        "Place a FaceTime audio call TO THE OWNER (their own number — this tool can't dial anyone else). Use when they asked to be called ('call me when X', a briefing-as-a-call) or a scheduled task says to. The voice session pre-warms before the dial so fig talks the moment they pick up; `reason` becomes fig's opening line, so phrase it as why you're calling. If they don't pick up in ~40s the attempt cleans itself up — do NOT redial in a loop; one retry max, then text them instead.",
      input: {
        reason: z.string().describe("why you're calling — spoken as the opener, e.g. 'you asked me to call when the seats opened: two just did'"),
      },
      mutates: "write",
      handler: async (args) => dialOwner(String(args.reason ?? "").trim() || "you asked me to call"),
    },
    {
      name: "hang_up",
      purpose: "end the live FaceTime call naturally when the conversation wraps up",
      description:
        "End the CURRENT live FaceTime call with the owner. Only meaningful mid-call — you'll know because your prompt says you're on a live voice call. Use it when they say bye / gotta go / wraps up naturally: say your short goodbye in the SAME reply, then call this. The End press waits for your goodbye to finish RENDERING AND PLAYING before it fires, so say the whole thing — it won't get cut off. Errors when no call is live.",
      input: {},
      mutates: "write",
      handler: async () => hangupLiveCall(),
    },
    {
      name: "lane_status",
      purpose: "check whether the call lane is armed / a call is in flight",
      description:
        "Current state of the FaceTime call lane: armed vs off, and whether a call is warming or live right now. Read-only.",
      input: {},
      mutates: "read",
      handler: async () => callLaneStatus(),
    },
  ],
});
