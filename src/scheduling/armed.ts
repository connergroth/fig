import { listReminders, type Reminder } from "./reminders";
import { listScheduledTasks, type ScheduledTask } from "./scheduledTasks";

/**
 * ONE answer to "is this actually armed?".
 *
 * Scheduled tasks and reminders are two stores for one question, and answering it from one of
 * them is how a correctly-armed reminder gets reported as "never set" and then armed twice:
 * `scheduled_tasks.list` alone shows an empty list and reads as proof of absence. So the fix
 * isn't a better habit, it's that either list tool answers for BOTH stores — and an empty
 * store still prints its header, so a reader can see it was checked rather than absent.
 */
/**
 * The model-facing description of BOTH list tools. One string, because they are one view —
 * two spellings of it would drift, and the drift would be in the sentence that exists to stop
 * fig concluding "not armed" off half the picture.
 */
export const ARMED_LIST_DESCRIPTION =
  "List EVERYTHING currently armed — scheduled tasks (future agent passes) AND reminders (fixed-text pings) — in one merged view. This is the single source of truth for 'did I actually arm that?'. Read the whole output before concluding something isn't set: an empty section only proves that section is empty, and checking one store and declaring the commitment missing is exactly how a duplicate gets armed.";

export function renderArmed(tasks: readonly ScheduledTask[], reminders: readonly Reminder[]): string {
  const rows = <T>(list: readonly T[], row: (x: T) => string): string[] =>
    list.length ? list.map(row) : ["(none)"];
  return [
    "SCHEDULED TASKS — future agent passes. Cancel with scheduled_tasks.cancel.",
    ...rows(tasks, (t) => `${t.id} | ${t.fireAt} | ${t.label}`),
    "",
    "REMINDERS — fixed-text pings. Cancel with reminders.cancel.",
    ...rows(reminders, (r) => `${r.id} | ${r.dueAt} | ${r.text}`),
    "",
    "Both stores were read. An empty section means that store is empty, not that it went unchecked.",
  ].join("\n");
}

/** The live merged view, read off both stores. What both list tools return. */
export function armedView(): string {
  return renderArmed(listScheduledTasks(), listReminders());
}
