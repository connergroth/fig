import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { ARMED_LIST_DESCRIPTION, armedView } from "./armed";
import { addScheduledTask, cancelScheduledTask } from "./scheduledTasks";

/**
 * Scheduled-TASK tools — fig's durable one-off "at X time, DO this" mechanism, the
 * in-house replacement for the ephemeral harness cron. Unlike `reminders.set` (which
 * just delivers a fixed string), `schedule` runs a full agent pass with the given
 * prompt when due, survives restarts, and self-catches-up if fig was down at the
 * fire-minute. Set the absolute ISO time from the current date/time in the preamble.
 *
 * `schedule` and `list` are pinned into the turn-1 prompt; `cancel` is not. `list` answers for
 * BOTH stores (see armed.ts) — "is this armed?" is one question, not one per store.
 */
export const scheduledTasksServerDef = defineServer({
  key: "scheduled_tasks",
  kind: "direct",
  purpose:
    'durable one-off "at X time, DO this" — runs a full agent pass, fig\'s in-house replacement for the ephemeral harness cron',
  exposure: "both",
  capabilities: [
    {
      name: "schedule",
      purpose: "queue a one-off future agent pass with its own prompt",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "schedules future harness work; no immediate external action",
      notes: "Schedules future harness work; no immediate external action.",
      // Pinned: arming is the half that can't afford a round-trip. A promise is made in the
      // sentence fig is already writing, so the mechanism has to be callable inside that same
      // turn — a ToolSearch fetch first is exactly the gap a "set" that never happened falls
      // through. The routing rule for all five mechanisms lives in this description, so it
      // also has to be in front of fig every turn, not fetched once fig already decided.
      alwaysLoad: true,
      description:
        "Schedule a ONE-OFF future agent pass — YOU at that time, with your tools and your voice — not a fixed-text ping. ARM IT IN THE SAME TURN YOU SAY IT: any reply promising future work ('later', 'in the morning', 'on my own cycle', 'next pass', 'when X lands', 'I'll ping you when', 'I'll check back') requires the mechanism call BEFORE that reply goes out; if nothing gets armed, don't phrase it as a commitment. Route by what actually has to happen: timed work you perform -> this tool; fixed-text ping to the owner with no work -> reminders.set; poll a condition until it trips -> the watch skill; no clock, done on your own cycles -> an ## Open line in Tasks.md; nothing to do, just tracking -> a line in Pending.md. A deadline-bearing promise parked only as a Tasks.md line is NOT armed. Durable: survives restarts, and if fig was down at the fire-time it runs as soon as fig is back (within maxLateMinutes). `when` is an absolute ISO datetime computed from the current date/time you were given. `prompt` is the instruction to your future self — self-contained, second person, everything that pass needs to act (it sees recent conversation, otherwise assume it starts cold). `label` is a short tag for logs. `maxLateMinutes` is how late it may run and still be worth doing: ~15-30 for time-sensitive things like a morning wake, longer when delay is fine; default 60.",
      input: {
        prompt: z.string().describe("what your future self should DO when this fires (runs as a full agent pass)"),
        when: z.string().describe("absolute ISO datetime"),
        label: z.string().describe("short tag for logs"),
        maxLateMinutes: z
          .number()
          .optional()
          .describe("drop without running if more than this many minutes late (default 60)"),
      },
      handler: async (args) => {
        const maxLateMs = (args.maxLateMinutes ?? 60) * 60_000;
        const t = addScheduledTask(args.prompt, args.label, args.when, maxLateMs);
        return `Scheduled task ${t.id} ("${t.label}") for ${t.fireAt} — runs as a full pass if within ${Math.round(
          maxLateMs / 60_000,
        )}m of target, else dropped.`;
      },
    },
    {
      name: "list",
      purpose: "show everything currently armed — scheduled tasks AND reminders",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "reads local scheduled-task state",
      // Pinned for the same reason `schedule` is: checking whether a commitment is already
      // armed happens mid-turn, and it is worthless if it costs a round-trip fig will skip.
      alwaysLoad: true,
      description: ARMED_LIST_DESCRIPTION,
      input: {},
      handler: async () => armedView(),
    },
    {
      name: "cancel",
      purpose: "drop one pending scheduled task by id",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "local and reversible",
      description: "Cancel a scheduled task by id.",
      input: { id: z.string() },
      handler: async (args) => {
        return cancelScheduledTask(args.id) ? `Cancelled ${args.id}.` : `No scheduled task ${args.id}.`;
      },
    },
  ],
});

export const scheduledTasksServer = toSdkServer(scheduledTasksServerDef);
