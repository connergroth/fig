import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * "Is this armed?" has ONE answer, and both list tools give it.
 *
 * The failure being fenced off: a reminder is armed correctly, the confirming turn calls
 * `scheduled_tasks.list` alone, sees an empty list, reports it was never set, and arms a
 * duplicate — several pings for one commitment. Two stores for one question is the defect;
 * a merged view is the fix. So the assertions are (a) both handlers read both stores,
 * and (b) an EMPTY store still prints its header, because "checked and empty" and "never
 * checked" reading the same is what made the wrong conclusion available in the first place.
 *
 * The handler half runs against a throwaway BRAIN_DIR so it exercises the real store code
 * without touching the live vault — hence the dynamic imports, after the env is set.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

const TASK_HEADER = "SCHEDULED TASKS";
const REMINDER_HEADER = "REMINDERS";

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fig-armed-"));
  process.env.BRAIN_DIR = tmp;
  fs.mkdirSync(path.join(tmp, ".state"), { recursive: true });

  const { renderArmed } = await import("./armed");
  const { remindersServerDef } = await import("./reminders-tools");
  const { scheduledTasksServerDef } = await import("./scheduledTasks-tools");
  const { addReminder } = await import("./reminders");
  const { addScheduledTask } = await import("./scheduledTasks");

  const listHandlers = [remindersServerDef, scheduledTasksServerDef].map((def) => {
    const cap = def.capabilities.find((c) => c.name === "list")!;
    return { name: `${def.key}.list`, cap };
  });

  console.log("armed view: one answer, both stores");

  await check("an empty store still prints its section header", () => {
    const out = renderArmed([], []);
    assert.match(out, new RegExp(`^${TASK_HEADER}`, "m"));
    assert.match(out, new RegExp(`^${REMINDER_HEADER}`, "m"));
    // Two "(none)" rows, not one line saying nothing is set — a reader has to be able to see
    // that BOTH stores were read.
    assert.equal(out.split("\n").filter((l) => l === "(none)").length, 2);
  });

  await check("each row keeps its id | time | label shape", () => {
    const out = renderArmed(
      [{ id: "t1", prompt: "p", label: "psych unit 1", fireAt: "2026-08-13T16:00:00Z", maxLateMs: 0, createdAt: "" }],
      [{ id: "r1", text: "submit unit 1", dueAt: "2026-10-12T16:00:00Z", createdAt: "" }],
    );
    assert.match(out, /^t1 \| 2026-08-13T16:00:00Z \| psych unit 1$/m);
    assert.match(out, /^r1 \| 2026-10-12T16:00:00Z \| submit unit 1$/m);
    assert.equal(out.split("\n").filter((l) => l === "(none)").length, 0);
  });

  await check("one store empty, the other full — both sections still show", () => {
    const out = renderArmed([], [{ id: "r1", text: "ping", dueAt: "2026-08-13T16:00:00Z", createdAt: "" }]);
    assert.match(out, new RegExp(`^${TASK_HEADER}[^\\n]*\\n\\(none\\)$`, "m"));
    assert.match(out, /^r1 \| 2026-08-13T16:00:00Z \| ping$/m);
  });

  await check("both list handlers return both stores, empty", async () => {
    for (const { name, cap } of listHandlers) {
      const out = await cap.handler({});
      assert.ok(out.includes(TASK_HEADER), `${name} must report scheduled tasks`);
      assert.ok(out.includes(REMINDER_HEADER), `${name} must report reminders`);
    }
  });

  await check("both list handlers return both stores once each has one thing in it", async () => {
    addScheduledTask("write the thing", "psych unit 1", "2026-08-13T16:00:00Z", 60_000);
    addReminder("submit unit 1", "2026-10-12T16:00:00Z");
    const outs = await Promise.all(listHandlers.map(({ cap }) => cap.handler({})));
    for (const [i, out] of outs.entries()) {
      const who = listHandlers[i].name;
      assert.ok(out.includes("psych unit 1"), `${who} missed the scheduled task`);
      assert.ok(out.includes("submit unit 1"), `${who} missed the reminder`);
    }
    // Same view, not two views that happen to overlap — that's the whole point.
    assert.equal(outs[0], outs[1]);
  });

  await check("both list tools carry the same model-facing description", () => {
    const [a, b] = listHandlers.map(({ cap }) => cap.description);
    assert.equal(a, b);
    assert.match(a, /merged view/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${ran - failures}/${ran} armed-view checks passed`);
  if (failures) process.exit(1);
}

void main();
