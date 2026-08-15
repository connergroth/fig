import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { ARMED_LIST_DESCRIPTION, armedView } from "./armed";
import { addReminder, cancelReminder } from "./reminders";

/**
 * Reminder tools, available to the orchestrator (reminders are set conversationally).
 * The agent computes the absolute ISO time from the current date/time in its preamble.
 *
 * `set` is pinned into the turn-1 prompt; `list` and `cancel` are not — `list` is deferred
 * because scheduled_tasks.list already answers for both stores (see armed.ts) and pinning a
 * second door onto the same view would pay twice for one answer.
 */
export const remindersServerDef = defineServer({
  key: "reminders",
  kind: "direct",
  purpose:
    "fixed-text pings to the owner at an absolute time (as opposed to scheduled_tasks, which runs a full agent pass)",
  exposure: "both",
  capabilities: [
    {
      name: "set",
      purpose: "queue a fixed-text ping to the owner at an absolute time",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "schedules a local, cancellable ping; was fallback-published as fig_tools.set_reminder",
      // Pinned: the other half of arming. A ping promised in a sentence has to be armable in
      // that same turn, so this can't sit behind a ToolSearch fetch either.
      alwaysLoad: true,
      description:
        "Queue a fixed-text ping to the owner at an absolute time — no agent pass, no tools, just this message delivered as written. If that future moment needs you to DO or CHECK anything, use scheduled_tasks.schedule instead. Arm it in the SAME turn you promise it (scheduled_tasks.schedule carries the full trigger + routing rule). `when` is an absolute ISO datetime computed from the current date/time you were given. `text` is the short, natural message in your normal voice.",
      input: {
        text: z.string().describe("the message to send when it fires"),
        when: z.string().describe("ISO datetime"),
      },
      handler: async (args) => {
        const r = addReminder(args.text, args.when);
        return `Reminder set (${r.id}) for ${r.dueAt}: "${r.text}"`;
      },
    },
    {
      name: "list",
      purpose: "show everything currently armed — reminders AND scheduled tasks",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "reads local reminder state",
      description: ARMED_LIST_DESCRIPTION,
      input: {},
      handler: async () => armedView(),
    },
    {
      name: "cancel",
      purpose: "drop one pending reminder by id",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "local and reversible — a cancelled reminder can be re-set",
      description: "Cancel a reminder by id.",
      input: { id: z.string() },
      handler: async (args) => {
        return cancelReminder(args.id) ? `Cancelled ${args.id}.` : `No reminder ${args.id}.`;
      },
    },
  ],
});

export const remindersServer = toSdkServer(remindersServerDef);
