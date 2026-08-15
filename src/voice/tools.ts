import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { getCall, hasResults, isEnded, isTerminal, placeCall, summarize, vapiConfigured } from "./client";

const NOT_CONFIGURED =
  "Outbound calling isn't set up (no Vapi config). Tell the owner to set VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, and VAPI_ASSISTANT_ID.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll budget: a call can sit in a phone tree / on hold for a while, so wait up to
// ~10 minutes for it to finish before handing back control. If it's still going,
// return the id so the agent can check_call later rather than blocking forever.
const POLL_MS = 6000;
const MAX_POLLS = 100;

// After a call reaches `ended`, Vapi finalizes the transcript, summary, and real
// cost asynchronously — they land a few seconds later. Keep polling (bounded) until
// they show up, otherwise we'd report an empty result with cost $0. ~60s ceiling.
const SETTLE_MS = 3000;
const MAX_SETTLE_POLLS = 20;

/**
 * Given a call that has already ended, poll until Vapi has attached the transcript
 * and summary (or we hit the settle ceiling). Returns the most complete call object
 * we managed to fetch. No-op for calls that ended without connecting (no artifacts
 * are ever coming for a no-answer/busy/failed call).
 */
async function awaitFinalized(id: string, call: any): Promise<any> {
  if (!isEnded(call.status)) return call;
  let latest = call;
  for (let i = 0; i < MAX_SETTLE_POLLS && !hasResults(latest); i++) {
    await sleep(SETTLE_MS);
    latest = await getCall(id);
  }
  return latest;
}

/**
 * Outbound-voice tools for the orchestrator. The agent uses these to make a real phone
 * call to a business on the owner's behalf — confirm hours, check on an order, ask a
 * question, sit through hold — and read back what happened. The persona, manners, and
 * the hard guardrails (never pay, never sign anything, never invent info) live on the
 * Vapi "Concierge" assistant; here we only pass the per-call objective and what it may
 * share. Disclosure of being an AI is OFF by default — set disclose_ai for matters where
 * announcing it is warranted.
 */
export const voiceServerDef = defineServer({
  key: "voice",
  kind: "direct",
  purpose: "place a real outbound phone call to a business on the owner's behalf and report back",
  exposure: "live-only",
  reason:
    "places real outbound phone calls that cost money and cannot be undone — needs a human in the loop, always",
  capabilities: [
    {
      name: "call",
      purpose: "place a real outbound call to a business and wait for the outcome",
      mutates: "write",
      description:
        "Place a real outbound phone call to a business on the owner's behalf and wait for it to finish, then report what happened. Use for things the owner would otherwise have to call in for — confirming hours/an appointment/an order, asking a question, sitting through hold. It will navigate phone menus and wait on hold. It will NOT make payments, agree to anything binding, or share info you didn't give it. Returns the outcome (summary + transcript). If the call runs long, returns a call_id to check later.",
      input: {
        phone_number: z.string().describe("The business's phone number in E.164, e.g. +13035551234."),
        objective: z
          .string()
          .describe(
            "What this call should accomplish, in plain language. Be specific: what to ask, what a successful outcome looks like, e.g. 'Confirm whether my prescription is ready for pickup and until what time the pharmacy is open today.'",
          ),
        details: z
          .string()
          .optional()
          .describe(
            "Info the assistant may share if asked — and ONLY this. e.g. 'Name: Alex Rivera. Order #44871. Appointment was Tuesday 2pm.' Never put payment info or sensitive identifiers here.",
          ),
        disclose_ai: z
          .boolean()
          .optional()
          .describe(
            "Whether to announce it's an AI calling on the owner's behalf. Default false. Set true only when disclosure is warranted.",
          ),
        share_name: z
          .boolean()
          .optional()
          .describe(
            "Whether the call may use the owner's real name. Default FALSE — calls are ANONYMOUS unless the task genuinely requires identity (looking up an account, a reservation in their name). A generic question — hours, availability, does-a-room-exist — needs no name, so leave this off. Putting 'don't give my name' in the objective does NOT work: the greeting is rendered server-side before the objective is read, so this flag is the only thing that suppresses it.",
          ),
      },
      handler: async (args) => {
        if (!vapiConfigured()) return NOT_CONFIGURED;
        try {
          const call = await placeCall({
            to: args.phone_number,
            objective: args.objective,
            details: args.details,
            disclose: args.disclose_ai,
            shareName: args.share_name,
          });
          const id: string = call.id;
          // Poll to completion. The agent is autonomous and replies once the job is done,
          // so blocking here until the call ends is the intended behavior.
          let latest = call;
          for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_MS);
            latest = await getCall(id);
            if (isTerminal(latest.status)) {
              // The call is over, but for a call that connected the transcript/summary/cost
              // are still being written server-side — wait for them before reporting back.
              latest = await awaitFinalized(id, latest);
              return `Call to ${args.phone_number} finished.\n\n${summarize(latest)}`;
            }
          }
          return (
            `Call to ${args.phone_number} is still in progress after 10 minutes (call_id: ${id}). ` +
            `Current status: ${latest.status}. Use check_call with this id to get the result.`
          );
        } catch (e) {
          return `call failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "check_call",
      purpose: "look up a past or in-flight outbound call by its id",
      mutates: "read",
      description:
        "Look up a past or in-progress outbound call by its call_id (returned by call when a call ran long). Gives current status, and the summary + transcript once it's ended.",
      input: { call_id: z.string().describe("The Vapi call id from call.") },
      handler: async (args) => {
        if (!vapiConfigured()) return NOT_CONFIGURED;
        try {
          // If it's ended but the artifacts haven't settled yet, wait briefly so
          // check_call returns the same summary + transcript + cost as call.
          const call = await awaitFinalized(args.call_id, await getCall(args.call_id));
          return summarize(call);
        } catch (e) {
          return `check_call failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const voiceServer = toSdkServer(voiceServerDef);
