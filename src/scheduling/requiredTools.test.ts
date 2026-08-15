import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests for the scheduled-skill tool contract + FAIL-LOUD guard.
 *
 * The bug being locked down: the nightly people-ingest sweep could not see
 * `mcp__mailsearch__find` / `mcp__calendar__list` in a scheduled pass, so it hand-rolled throwaway
 * scripts against the raw mail/calendar clients and reported that as a normal run — for
 * weeks, with the only trace a parenthetical in its own log file.
 *
 * Two halves are covered here: that a skill's declared tool dependency is parsed and turned
 * into an explicit, name-carrying, no-workarounds instruction; and that a completed run
 * which never called a declared tool is detected as degraded rather than passing as clean.
 */

let failures = 0;
let ran = 0;
/** Awaits async bodies too — an un-awaited assertion is a test that silently passes. */
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

async function main(): Promise<void> {
  const {
    DEGRADED_ERROR,
    declaresEmptyRequiredTools,
    declaresRequiredTools,
    degradedAlert,
    frontmatterField,
    missingRequiredTools,
    parseRequiredTools,
    requiredToolsPreamble,
    resolveRequirement,
  } = await import("./requiredTools");

  /** The vault's skills dir, or a path that doesn't exist when there's no vault. */
  const skillsDir = () =>
    path.join(process.env.BRAIN_DIR || path.join(process.env.HOME || "", "GitHub", "brain"), ".claude", "skills");

  /** [skillName, frontmatter] for every skill that runs on a schedule. */
  const scheduledSkillFrontmatter = (): [string, string][] => {
    const out: [string, string][] = [];
    for (const d of fs.readdirSync(skillsDir())) {
      const f = path.join(skillsDir(), d, "SKILL.md");
      if (!fs.existsSync(f)) continue;
      const fm = fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/);
      if (!fm || !/^schedule:/m.test(fm[1])) continue;
      out.push([d, fm[1]]);
    }
    return out;
  };

  console.log("requiredTools: frontmatter parsing");

  await check("inline bracket list", () => {
    assert.deepEqual(parseRequiredTools("requiredTools: [mcp__mailsearch__find, mcp__calendar__list]\n"), [
      "mcp__mailsearch__find",
      "mcp__calendar__list",
    ]);
  });

  await check("bare comma list", () => {
    assert.deepEqual(parseRequiredTools("requiredTools: mcp__mailsearch__find, mcp__calendar__list\n"), [
      "mcp__mailsearch__find",
      "mcp__calendar__list",
    ]);
  });

  await check("yaml block list", () => {
    assert.deepEqual(
      parseRequiredTools("name: x\nrequiredTools:\n  - mcp__mailsearch__find\n  - 'mcp__calendar__list'\nschedule: daily 9:00\n"),
      ["mcp__mailsearch__find", "mcp__calendar__list"],
    );
  });

  await check("absent field yields no requirements (guard simply off)", () => {
    assert.deepEqual(parseRequiredTools("name: x\nschedule: daily 9:00\n"), []);
  });

  await check("dedupes and drops junk entries", () => {
    assert.deepEqual(parseRequiredTools("requiredTools: [mcp__mailsearch__find, mcp__mailsearch__find, , not a tool!]\n"), [
      "mcp__mailsearch__find",
    ]);
  });

  await check("does not read a lookalike key", () => {
    assert.deepEqual(parseRequiredTools("notRequiredTools: [mcp__mailsearch__find]\n"), []);
  });

  await check("server-granularity entries parse", () => {
    assert.deepEqual(parseRequiredTools("requiredTools: [email, calendar, location]\n"), [
      "email",
      "calendar",
      "location",
    ]);
    // A hyphen is legal because one mcp.json server key has one (`agent-cards`).
    assert.deepEqual(parseRequiredTools("requiredTools: [agent-cards]\n"), ["agent-cards"]);
  });

  await check("an empty declaration parses as an empty list, not as absent", () => {
    // `requiredTools: []` is the "needs nothing, and someone decided that" case. It has to be
    // distinguishable from a missing line, which is what the lint fails on.
    assert.deepEqual(parseRequiredTools("requiredTools: []\n"), []);
    assert.equal(declaresRequiredTools("requiredTools: []\n"), true);
    assert.equal(declaresRequiredTools("name: x\nschedule: daily 9:00\n"), false);
  });

  await check("a deliberate empty declaration is not mistaken for an unparseable one", () => {
    // The scheduler warns "the guard is OFF" when a declaration is present but parses to
    // nothing. `requiredTools: []` parses to nothing ON PURPOSE, so warning on it fired on
    // every scan for skills that are perfectly in spec — and buried the real case in noise.
    assert.equal(declaresEmptyRequiredTools("requiredTools: []\n"), true);
    assert.equal(declaresEmptyRequiredTools("name: x\nrequiredTools:\nschedule: daily 9:00\n"), true);
    // Real failures still read as failures.
    assert.equal(declaresEmptyRequiredTools("requiredTools: [!!!]\n"), false);
    assert.equal(declaresEmptyRequiredTools("requiredTools: [mcp__mailsearch__find]\n"), false);
    assert.equal(declaresEmptyRequiredTools("requiredTools:\n  - mcp__mailsearch__find\n"), false);
    // Absent is not empty — the lint's "missing-declaration" case owns that.
    assert.equal(declaresEmptyRequiredTools("name: x\nschedule: daily 9:00\n"), false);
  });

  await check("a leftover `|` alternation is rejected rather than half-parsed", () => {
    // Alternation existed only because one capability had two names. It doesn't now, so an
    // entry with a pipe is a stale declaration — dropped here and reported by lintSkill(),
    // rather than silently normalized into something that no longer means anything.
    assert.deepEqual(parseRequiredTools("requiredTools: [mcp__fetch__fetch_url|mcp__fig_tools__fetch_url, browse]\n"), [
      "browse",
    ]);
  });

  console.log("requiredTools: block-scalar frontmatter reader");

  await check("single-line scalar", () => {
    assert.equal(frontmatterField("runPrompt: do the thing\n", "runPrompt"), "do the thing");
  });

  await check("block scalar is dedented and joined", () => {
    const fm = "runPrompt: |\n  line one\n  line two\ninternal: true\n";
    assert.equal(frontmatterField(fm, "runPrompt"), "line one\nline two");
  });

  await check("block scalar stops at the next top-level key", () => {
    const fm = "runPrompt: |\n  only this\ninternal: true\nschedule: daily 9:00\n";
    const v = frontmatterField(fm, "runPrompt");
    assert.equal(v, "only this");
    assert.ok(!v!.includes("internal"), "must not swallow the following key");
  });

  // Regression: a blank line inside a block scalar used to end the match, silently handing a
  // truncated instruction to the scheduled pass. Half a runPrompt is worse than none — it
  // still runs, it just quietly stops asking for the second half of the job.
  await check("blank line inside a block scalar does NOT truncate it", () => {
    const fm = "runPrompt: |\n  first paragraph\n\n  second paragraph\ninternal: true\n";
    const v = frontmatterField(fm, "runPrompt");
    assert.ok(v!.includes("first paragraph"), "lost the first paragraph");
    assert.ok(v!.includes("second paragraph"), "blank line truncated the block scalar");
    assert.ok(!v!.includes("internal: true"), "must not swallow the following key");
  });

  console.log("requiredTools: the run-prompt contract");

  await check("empty requirements produce no preamble at all", () => {
    assert.equal(requiredToolsPreamble([]), "");
  });

  await check("preamble carries the exact fully-qualified names", () => {
    // The failing runs' tell was `ToolSearch select:email,calendar` — the model guessing at
    // server keys because nothing handed it the real tool names.
    const p = requiredToolsPreamble(["mcp__mailsearch__find", "mcp__calendar__list"]);
    assert.ok(p.includes("mcp__mailsearch__find"), "must name the email tool");
    assert.ok(p.includes("mcp__calendar__list"), "must name the calendar tool");
    assert.ok(
      p.includes("select:mcp__mailsearch__find,mcp__calendar__list"),
      "must hand over a ready-to-use ToolSearch select for the exact names",
    );
  });

  await check("preamble bans the improvised workaround explicitly", () => {
    const p = requiredToolsPreamble(["mcp__mailsearch__find"]);
    assert.match(p, /STOP/, "must tell the pass to stop rather than continue degraded");
    assert.match(p, /do NOT improvise/i, "must forbid improvising a substitute");
    assert.match(p, /throwaway scripts/i, "must name the actual observed workaround");
  });

  console.log("requiredTools: the fail-loud guard");

  await check("a run that called the required tools is not degraded", () => {
    assert.deepEqual(
      missingRequiredTools(["mcp__mailsearch__find", "mcp__calendar__list"], [
        "Skill",
        "mcp__calendar__list",
        "mcp__mailsearch__find",
        "Edit",
      ]),
      [],
    );
  });

  await check("the real observed failure is caught: hand-rolled scripts, no specialist calls", () => {
    // Exactly the tool mix from the run: a Skill launch, ToolSearch flailing, then
    // Write+Bash to build and run scripts/dev/people-sweep.ts. Zero specialist calls.
    const observed = ["Skill", "Bash", "ToolSearch", "Write", "Edit", "Read"];
    assert.deepEqual(missingRequiredTools(["mcp__mailsearch__find", "mcp__calendar__list"], observed), [
      "mcp__mailsearch__find",
      "mcp__calendar__list",
    ]);
  });

  await check("partial coverage still reports only what's missing", () => {
    assert.deepEqual(
      missingRequiredTools(["mcp__mailsearch__find", "mcp__calendar__list"], ["mcp__mailsearch__find", "Bash"]),
      ["mcp__calendar__list"],
    );
  });

  await check("tool-name matching is exact, not substring", () => {
    // `mcp__agentmail__check_inbox` is mail-shaped but is NOT the email specialist.
    assert.deepEqual(missingRequiredTools(["mcp__mailsearch__find"], ["mcp__agentmail__check_inbox"]), [
      "mcp__mailsearch__find",
    ]);
  });

  await check("a pass with no tool calls at all is degraded, not quietly clean", () => {
    assert.deepEqual(missingRequiredTools(["mcp__mailsearch__find"], []), ["mcp__mailsearch__find"]);
  });

  console.log("requiredTools: server-granularity requirements");

  // Declaring a SERVER is the default: the tool list derives from the registry, so a server
  // gaining a tool never leaves the declaration stale. This is what replaced `|` alternation,
  // which only ever existed because one capability had two names.
  await check("a server entry is satisfied by any of that server's tools", () => {
    assert.deepEqual(missingRequiredTools(["reminders"], ["mcp__reminders__list"]), []);
    assert.deepEqual(missingRequiredTools(["reminders"], ["mcp__reminders__set"]), []);
    assert.deepEqual(missingRequiredTools(["location"], ["mcp__location__where_is"]), []);
  });

  await check("a server entry with none of its tools called is still degraded", () => {
    assert.deepEqual(missingRequiredTools(["reminders"], ["Bash", "WebFetch"]), ["reminders"]);
  });

  await check("a server entry does not loosen matching to a prefix", () => {
    assert.deepEqual(missingRequiredTools(["fetch"], ["mcp__fetch__fetch"]), ["fetch"]);
  });

  await check("a tool-level entry still works, because server granularity can't express everything", () => {
    // `mcp__mailsearch__find` both reads and sends; `flip_login` fires an OTP to the owner's real phone
    // from a server that reads as read-only at server granularity. The escape hatch is not
    // optional, and it's asserted so it doesn't get tidied away.
    assert.deepEqual(missingRequiredTools(["mcp__flip__login"], ["mcp__flip__account_status"]), ["mcp__flip__login"]);
    assert.deepEqual(missingRequiredTools(["mcp__flip__login"], ["mcp__flip__login"]), []);
  });

  await check("resolveRequirement derives from the registry rather than a written list", async () => {
    const { resolveRequirement } = await import("./requiredTools");
    const { serverByKey } = await import("../tools/registry");
    const expected = serverByKey("reminders")!.capabilities.map((c) => `mcp__reminders__${c.name}`);
    assert.deepEqual(resolveRequirement("reminders").sort(), expected.sort());
    assert.deepEqual(resolveRequirement("mcp__reminders__set"), ["mcp__reminders__set"]);
    // Nothing resolves for a name the registry doesn't publish — that's what the lint reports.
    assert.deepEqual(resolveRequirement("mcp__fig_tools__set_reminder"), []);
    assert.deepEqual(resolveRequirement("fig_tools"), []);
  });

  await check("preamble expands a server entry into the exact names ToolSearch needs", () => {
    const p = requiredToolsPreamble(["browse", "mcp__jobs__list"]);
    assert.ok(p.includes("mcp__browse__use"), "a server entry must name the tools it covers");
    assert.ok(p.includes("select:mcp__browse__use,mcp__jobs__list"), "select: takes exact names");
    assert.ok(!p.includes("|"), "no pipe may leak into the preamble");
  });

  await check("preamble covers BOTH pinned and deferred without asserting either", () => {
    // Measured (scripts/dev/tool-surface.ts): most in-process MCP tools sit in the deferred
    // registry and need a ToolSearch first, but email + calendar are alwaysLoad-pinned and are
    // already callable. The preamble has said each of those things exclusively at some point,
    // and each was wrong for the other half — the "they are not in your turn-1 tool list"
    // version told a briefing pass its own pinned tools weren't there. So it now describes the
    // split and makes the fetch conditional.
    const p = requiredToolsPreamble(["mcp__jobs__list"]);
    assert.match(p, /already in your turn-1 tool list/i, "must allow for a tool being pinned");
    assert.match(p, /DEFERRED/i, "must still say the rest need loading first");
    assert.match(p, /isn't already callable/i, "the ToolSearch step has to be conditional, not asserted");
    assert.doesNotMatch(p, /they are not in your turn-1 tool list/i, "the false blanket claim must not return");
    assert.match(p, /must actually CALL them/i, "reasoning to an answer instead of calling is the failure being named");
    assert.match(p, /EXACT-name lookup/i, "must warn that select: is exact, not fuzzy");
    assert.match(p, /select:email/, "must name the exact wrong-guess that caused the original failure");
  });

  await check("degraded alert renders a server entry as the tools it covers", () => {
    const msg = degradedAlert("newspaper", ["fetch"], 1);
    assert.ok(msg.includes("mcp__fetch__fetch_url"), "the alert has to name something callable");
    assert.ok(!msg.includes("|"), "no raw pipe in the message the owner reads");
  });

  console.log("requiredTools: the alert the owner actually sees");

  await check("alert names the skill and the unreachable tools", () => {
    const msg = degradedAlert("people-ingest", ["mcp__mailsearch__find", "mcp__calendar__list"], 1);
    assert.ok(msg.includes("people-ingest"), "must name the skill");
    assert.ok(msg.includes("mcp__mailsearch__find"), "must name the tool it couldn't reach");
    assert.ok(msg.startsWith("⚠️"), "must be visibly flagged, not a normal-looking line");
  });

  await check("alert is not swallowed as a quiet sentinel", async () => {
    // A degraded run must override the skill's own quiet path. If the alert text tripped
    // isQuietOutput/isQuietSentinel it would be suppressed by deliver() — i.e. the exact
    // silent-failure this whole guard exists to remove.
    const msg = degradedAlert("people-ingest", ["mcp__mailsearch__find"], 4);
    assert.ok(!/(^|\s)NOTHING\s*$/.test(msg), "alert must not end in the quiet sentinel");
    assert.ok(msg.trim().length > 40, "alert must carry real content");
  });

  await check("repeat degradations are surfaced as a count", () => {
    const once = degradedAlert("people-ingest", ["mcp__mailsearch__find"], 1);
    const fourth = degradedAlert("people-ingest", ["mcp__mailsearch__find"], 4);
    assert.ok(!/\b4 runs\b/.test(once));
    assert.ok(/\b4 runs\b/.test(fourth), "a repeat offender must read as a streak, not a one-off");
  });

  await check("DEGRADED_ERROR is a stable greppable marker", () => {
    assert.equal(DEGRADED_ERROR, "SCHEDULED_SKILL_DEGRADED");
  });

  console.log("requiredTools: the real people-ingest declaration");

  const skillPath = path.join(
    process.env.BRAIN_DIR || path.join(process.env.HOME || "", "GitHub", "brain"),
    ".claude",
    "skills",
    "people-ingest",
    "SKILL.md",
  );

  await check("people-ingest declares the servers it structurally depends on", () => {
    if (!fs.existsSync(skillPath)) {
      console.log(`    (skipped — no vault at ${skillPath})`);
      return;
    }
    const txt = fs.readFileSync(skillPath, "utf8");
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, "SKILL.md must have frontmatter");
    const required = parseRequiredTools(fm![1]);
    // gmail + calendar, not the deleted `email`/`calendar` specialists. The school and
    // personal-domain side is deliberately NOT declared: mcp__mailsearch__find has no
    // list-a-window verb for those backends (keyword matching only), so that pass is a
    // keyword lookup a correct run can skip.
    assert.ok(required.includes("gmail"), "the gmail tools must be declared required");
    assert.ok(required.includes("calendar"), "the calendar tools must be declared required");
    // The scheduler reads schedule + runPrompt from the same block; a requiredTools line
    // inserted above runPrompt must not break either.
    assert.match(fm![1], /^schedule:\s*daily 21:40$/m, "schedule must still parse");
    const rp = frontmatterField(fm![1], "runPrompt");
    assert.ok(rp && rp.length > 100, "runPrompt must still read as a full block scalar");
    assert.ok(rp!.includes("people-ingest sweep"), "runPrompt must still open with the real task");
    assert.ok(!rp!.includes("internal:"), "runPrompt must not swallow the following key");
  });

  console.log("runtime: top-level tool-use accounting");

  const { topLevelToolNames } = await import("../runtimes/claude");
  const assistant = (content: unknown[], parent?: string) => ({
    type: "assistant",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content },
  });

  await check("collects tool_use names from a top-level assistant message", () => {
    assert.deepEqual(
      topLevelToolNames(
        assistant([
          { type: "text", text: "on it" },
          { type: "tool_use", name: "mcp__mailsearch__find", input: { request: "..." } },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ]),
      ),
      ["mcp__mailsearch__find", "Bash"],
    );
  });

  await check("IGNORES nested specialist/subagent tool calls", () => {
    // A specialist's own internal gmail calls arrive with parent_tool_use_id. Counting them
    // would let a pass look like it delegated when it never did.
    assert.deepEqual(
      topLevelToolNames(assistant([{ type: "tool_use", name: "mcp__gmail__search" }], "toolu_123")),
      [],
    );
  });

  await check("tolerates malformed / non-assistant messages", () => {
    assert.deepEqual(topLevelToolNames({ type: "result", result: "done" }), []);
    assert.deepEqual(topLevelToolNames(assistant([])), []);
    assert.deepEqual(topLevelToolNames({ type: "assistant" }), []);
    assert.deepEqual(topLevelToolNames(assistant([{ type: "tool_use" }])), [], "nameless block is skipped");
    assert.deepEqual(topLevelToolNames(null), []);
  });

  await check("end to end: the failing run's stream yields no specialist calls", () => {
    const stream = [
      assistant([{ type: "tool_use", name: "Skill", input: { skill: "people-ingest" } }]),
      assistant([{ type: "tool_use", name: "ToolSearch", input: { query: "select:email,calendar" } }]),
      assistant([{ type: "tool_use", name: "Write", input: { file_path: "scripts/dev/people-sweep.ts" } }]),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "npx tsx scripts/dev/people-sweep.ts" } }]),
    ];
    const used = [...new Set(stream.flatMap((m) => topLevelToolNames(m)))];
    assert.deepEqual(missingRequiredTools(["mcp__mailsearch__find", "mcp__calendar__list"], used), [
      "mcp__mailsearch__find",
      "mcp__calendar__list",
    ]);
  });

  await check("end to end: a healthy run satisfies the contract", () => {
    const stream = [
      assistant([{ type: "tool_use", name: "Skill", input: { skill: "people-ingest" } }]),
      assistant([{ type: "tool_use", name: "mcp__calendar__list", input: { request: "events today" } }]),
      assistant([{ type: "tool_use", name: "mcp__gmail__search" }], "toolu_inner"),
      assistant([{ type: "tool_use", name: "mcp__mailsearch__find", input: { request: "today's human mail" } }]),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "People/reid.md" } }]),
    ];
    const used = [...new Set(stream.flatMap((m) => topLevelToolNames(m)))];
    assert.deepEqual(missingRequiredTools(["mcp__mailsearch__find", "mcp__calendar__list"], used), []);
    assert.ok(!used.includes("mcp__gmail__search"), "specialist-internal calls must not leak into the accounting");
  });

  console.log("scheduled lane: server coverage (the actual root cause)");

  const {
    buildScheduledMcpServers,
    buildFigMcpServers,
    laneServerDrift,
    scheduledInProcessServers,
    allRegisteredServerKeys,
    laneExclusions,
  } = await import("./lane");

  await check("every registered server is either in the unattended lane or excluded WITH a reason", () => {
    // THE invariant, and the whole point of the redesign. The original bug was a scheduled
    // lane that was a hand-maintained SUBSET of the live one — ack/code/voice/image/agentmail/
    // flip simply never passed, unreachable by any mechanism, for ~6 weeks. The first
    // fix (union the two) traded that for the opposite failure: an unattended pass could fire
    // deep_research or spawn a coding agent on its own cycle.
    //
    // Neither list is the answer. The answer is that membership is DECIDED: a server is in the
    // unattended lane, or its own definition carries a non-"both" exposure with a written
    // reason. A new server added later satisfies neither and fails at module load until
    // someone picks a side. That is the no-silent-drift property, in both directions.
    const drift = laneServerDrift(buildFigMcpServers(), buildScheduledMcpServers());
    assert.deepEqual(
      drift.undecided,
      [],
      `servers in the live lane that are neither in the unattended lane nor excluded with a reason: ${drift.undecided.join(", ")} — set an \`exposure\` on their registry definition`,
    );
    assert.deepEqual(
      drift.extraInScheduled,
      [],
      `servers only unattended passes can reach: ${drift.extraInScheduled.join(", ")}`,
    );
    assert.deepEqual(
      drift.staleExclusions,
      [],
      `the registry defines file-mcp servers mcp.json no longer contains: ${drift.staleExclusions.join(", ")}`,
    );
    assert.deepEqual(
      drift.leakedExclusions,
      [],
      `excluded but still present in the lane they're excluded from: ${drift.leakedExclusions.join(", ")}`,
    );
    // mcp.json servers are spread in from the vault, so a new entry there joins both lanes
    // without touching lane.ts — silent drift pointed the other way. Same bar: reviewed or excluded.
    assert.deepEqual(
      drift.unreviewedFileMcp,
      [],
      `mcp.json servers with no registry definition: ${drift.unreviewedFileMcp.join(", ")} — declare them in src/tools/external.ts`,
    );
  });

  await check("every exclusion carries a non-empty reason", () => {
    // A bare name in an array is how the last one rotted — `browser` and `agent-cards` were
    // two `delete` statements with a passing comment, and nothing tied the comment to the
    // deletion. The reason string is the artifact that survives the next refactor.
    for (const [name, e] of Object.entries(laneExclusions())) {
      assert.ok(e.reason && e.reason.trim().length > 20, `exclusion "${name}" needs a real reason, got: ${e.reason}`);
      assert.ok(["unattended", "both"].includes(e.scope), `exclusion "${name}" has an unknown scope: ${e.scope}`);
    }
  });

  await check("the excluded set is exactly what the owner signed off on", () => {
    // Deliberately a literal. Widening fig's unattended authority should be a diff someone
    // reads, not a side effect of editing a builder.
    assert.deepEqual(Object.keys(laneExclusions()).sort(), [
      "ack",
      "agent-cards",
      "browser",
      "code",
      "codex",
      "peekaboo",
      "research",
      "voice",
    ]);
    const lane = scheduledInProcessServers();
    for (const name of Object.keys(laneExclusions())) {
      assert.ok(!(name in lane), `${name} must not be wired into unattended passes`);
    }
  });

  console.log("scheduled lane: built-in denylist (the fourth drifted lane map)");

  const {
    BASE_DISALLOWED_TOOLS,
    UNATTENDED_ONLY_DISALLOWED_TOOLS,
    disallowedToolsForLane,
  } = await import("./lane");

  await check("both lanes resolve their denylist from the one table", async () => {
    // A per-lane copy of the denylist is how names end up denied to an attended turn and
    // ALLOWED at 3am. This binds the two ends together: the live-lane const IS the resolution
    // of the shared table, not a copy of it.
    const { FIG_DISALLOWED_TOOLS } = await import("../session/session");
    const { scheduledPassOptions } = await import("./scheduler");
    assert.deepEqual(FIG_DISALLOWED_TOOLS, disallowedToolsForLane("live"));
    assert.deepEqual(scheduledPassOptions().disallowedTools, disallowedToolsForLane("unattended"));
  });

  await check("the resolved denylist per lane is exactly what's signed off on", () => {
    // Deliberately literals, same bar as the exclusion table above. Handing either lane a new
    // built-in — or quietly taking one away from the unattended one — should be a diff someone
    // reads, not a side effect of editing a builder.
    assert.deepEqual(disallowedToolsForLane("live"), [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "Agent",
      "CronCreate",
      "CronList",
      "CronDelete",
      "Workflow",
      "ScheduleWakeup",
    ]);
    assert.deepEqual(disallowedToolsForLane("unattended"), [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "Agent",
      "CronCreate",
      "CronList",
      "CronDelete",
      "Workflow",
      "ScheduleWakeup",
    ]);
  });

  await check("unattended is a strict superset of the base denials", () => {
    // The directional invariant: whatever an owner-in-the-loop turn isn't trusted with, a pass
    // with nobody watching isn't either. A built-in may be denied unattended-only; it may never
    // be denied live-only.
    const unattended = new Set(disallowedToolsForLane("unattended"));
    for (const name of disallowedToolsForLane("live")) {
      assert.ok(unattended.has(name), `${name} is denied live but allowed unattended — that's the drift, inverted`);
    }
    for (const name of Object.keys(BASE_DISALLOWED_TOOLS)) {
      assert.ok(unattended.has(name), `base denial ${name} missing from the unattended lane`);
    }
    // Empty today on purpose (see its doc comment) — asserted so "empty" stays a decision.
    assert.deepEqual(Object.keys(UNATTENDED_ONLY_DISALLOWED_TOOLS), []);
  });

  await check("every denied built-in carries a non-empty reason", () => {
    for (const [name, reason] of Object.entries({ ...BASE_DISALLOWED_TOOLS, ...UNATTENDED_ONLY_DISALLOWED_TOOLS })) {
      assert.ok(reason && reason.trim().length > 20, `denial "${name}" needs a real reason, got: ${reason}`);
    }
  });

  await check("no lane call site hand-writes a disallowedTools literal", () => {
    // The tripwire on the actual failure mode. Pinning the resolved lists above catches a
    // changed definition; this catches the thing that really happened — a call site growing
    // its OWN array far from the table, which leaves both lists standing and green.
    //
    // Scoped to the four lane-level query() sites on purpose. Specialists (google/triage.ts,
    // specialists/browser.ts) legitimately hand-write disallowedTools: those are MCP verb
    // gates inside one sub-agent's own surface, one owner each, not a lane map.
    const laneSites = [
      "session/session.ts",
      "session/warmSession.ts",
      "session/background.ts",
      "scheduling/scheduler.ts",
    ];
    const literal = /disallowedTools:\s*\[/;
    for (const rel of laneSites) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      assert.ok(
        !literal.test(src),
        `${rel} hand-writes a disallowedTools array — derive it from disallowedToolsForLane() in scheduling/lane.ts instead`,
      );
    }
    // And prove the check can fail, rather than trusting that it would — same reason
    // laneServerDrift has an injected-fake test.
    assert.ok(literal.test(`disallowedTools: ["CronCreate", "CronList", "CronDelete"],`));
  });

  await check("the kept set is exactly the 23 servers an unattended pass is trusted with", () => {
    // Each entry earns its place. `maps`: read-only drive times, and a scheduled pass
    // reasoning about a commute needs it.
    // `tts`: it renders a local file with a local model — no network, no spend,
    // nothing to undo — and the audio morning briefing it exists for IS an unattended pass,
    // so live-only would have excluded it from its own reason for existing.
    // `facetime`: it can only ever dial the OWNER's own number on the free
    // FaceTime lane — no money, no third parties, undone by declining the ring — and
    // "call me when X" from a scheduled watch is the unattended feature it exists for.
    // `pangram`: read-only AI-text detection, ~$0.05/1000 words, nothing to undo.
    // It does ship its input to a third party — but `fetch` (arbitrary URL egress) is already
    // in both lanes, so that authority isn't new here, and the thing worth guarding against is
    // pasting the wrong text, which is a live-lane risk just as much as an unattended one.
    // `gmail`, `outlook` and `mailsearch` are mounted directly and deferred rather than behind
    // a one-tool specialist, and `calendar` is the google server rather than a delegator to it.
    // Same authority, one less LLM hop, and the pass reads raw tool output instead of a
    // subagent's summary of it.
    // `usage`: read-only Claude Code / Codex rate-limit lookup against their own
    // credential stores — never refreshes a token, returns only percentages, and a scheduled
    // pass deciding whether to fire a heavy coding delegation is exactly who needs it.
    assert.deepEqual(Object.keys(scheduledInProcessServers()).sort(), [
      "agentmail",
      "browse",
      "calendar",
      "facetime",
      "fetch",
      "flip",
      "gmail",
      "image",
      "jobs",
      "lights",
      "location",
      "mailsearch",
      "maps",
      "memory",
      "music",
      "outlook",
      "pangram",
      "reminders",
      "scheduled_tasks",
      "tts",
      "usage",
      "web_export",
    ]);
  });

  await check("the agentmail restriction is one TOOL, not a lane exclusion", async () => {
    // A server-level exclusion here was the blunt reading of "keep list_inboxes out", and it
    // took the standing unattended inbox-poll watch down with it — the loop that exists
    // because a forwarded email once sat unread for two days. The restriction is scoped to
    // the tool it's about: list_inboxes is absent from main context in BOTH lanes, and the
    // reads stay reachable in both.
    const { agentmailInboxServer, agentmailServer } = await import("../agentmail/tools");
    const names = (s: unknown) => Object.keys((s as any).instance?._registeredTools ?? {}).sort();
    assert.deepEqual(names(agentmailInboxServer), ["check_inbox", "read_message"]);
    for (const lane of [buildFigMcpServers(), buildScheduledMcpServers()]) {
      assert.ok(lane.agentmail, "agentmail must be reachable in both lanes");
      assert.deepEqual(names(lane.agentmail), ["check_inbox", "read_message"]);
    }
    // The browse specialist keeps the full toolset — burner management is its job, and that's
    // the whole reason list_inboxes doesn't need to sit in main context.
    assert.ok(names(agentmailServer).includes("list_inboxes"));
  });

  await check("session.ts re-exports the owner's builder rather than keeping its own copy", async () => {
    // The original bug in one sentence: two literals, two files, 400 lines apart. Identity
    // (not deep-equality) is the assertion that makes reintroducing a second literal fail.
    const session = await import("../session/session");
    assert.equal(session.buildFigMcpServers, buildFigMcpServers);
  });

  await check("no excluded surface reaches the unattended lane under a second name", async () => {
    // What this replaces, and why the shape changed. `fig_tools` was a SECOND registry that
    // re-published 16 tools other servers already owned, under its own names — a standing hole
    // in any server-level exclusion, since dropping a server accomplished nothing while the
    // bundle still published its tools under different names in the same lane. It was guarded
    // by two hand-written regex tripwires (research/voice/coding-shaped, and peekaboo-shaped)
    // plus a filter list, because a hole under a NEW name is exactly what a name-based check
    // can't see.
    //
    // The bundle is gone, so the hole is closed structurally rather than watched for: a
    // capability exists once, on one server, and `duplicatePublications()` fails if any handler
    // is ever registered twice. That check sees through a rename, which no tripwire could.
    // What remains worth asserting is the OUTCOME the tripwires were protecting — that the
    // unattended lane publishes nothing belonging to an excluded server.
    const { duplicatePublications, ALL_SERVERS } = await import("../tools/registry");
    assert.deepEqual(duplicatePublications(), [], "a capability is published twice — that's the old fig_tools hole reopening");

    const lane = buildScheduledMcpServers();
    const excludedKeys = new Set(ALL_SERVERS.filter((s) => s.exposure !== "both").map((s) => s.key));
    // Every handler an excluded server owns, by identity. If any of these turned up mounted in
    // the unattended lane under ANY name, the exclusion would be decorative.
    const forbiddenHandlers = new Set(
      ALL_SERVERS.filter((s) => excludedKeys.has(s.key)).flatMap((s) => s.capabilities.map((c) => c.handler)),
    );
    assert.ok(forbiddenHandlers.size > 0, "expected the excluded servers to own some handlers");
    const leaks: string[] = [];
    for (const [key, cfg] of Object.entries(lane)) {
      const tools = (cfg as any).instance?._registeredTools ?? {};
      for (const [t, def] of Object.entries<any>(tools)) {
        // The SDK wraps our handler, so identity is checked against the definition instead.
        const owner = ALL_SERVERS.find((s) => s.key === key);
        const cap = owner?.capabilities.find((c) => c.name === t);
        if (!cap) leaks.push(`mcp__${key}__${t} (no registry definition)`);
        else if (forbiddenHandlers.has(cap.handler)) leaks.push(`mcp__${key}__${t}`);
      }
    }
    assert.deepEqual(leaks, [], `the unattended lane publishes excluded capability(ies): ${leaks.join(", ")}`);

    // And the one tool-level restriction, which a server-level exclusion could not express:
    // list_inboxes is out of main context in BOTH lanes, while agentmail's reads stay in.
    assert.ok(!("list_inboxes" in ((lane.agentmail as any).instance?._registeredTools ?? {})));
  });

  console.log("lane instances: one query per instance (the real six-week cause)");

  await check("every lane build hands out FRESH in-process instances", () => {
    // THE bug, and the one nothing was checking. An in-process SDK MCP server instance can be
    // mounted by exactly one open query; a second query handed the same instance while the
    // first is open silently gets zero tools (measured — scripts/dev/singleton-probe.ts, 0 of
    // 5). fig always has a long-lived interactive session open, so every scheduled pass was
    // mounting instances the session already held. Identity is the whole assertion: if two
    // builds ever return the same object, passes start sharing again and go quietly toolless.
    const a = buildScheduledMcpServers();
    const b = buildScheduledMcpServers();
    const live = buildFigMcpServers();
    const inProcess = Object.keys(a).filter((k) => (a[k] as any).instance?._registeredTools);
    assert.ok(inProcess.length > 10, `expected the lane to carry in-process servers, saw ${inProcess.length}`);
    for (const k of inProcess) {
      assert.notEqual((a[k] as any).instance, (b[k] as any).instance, `${k}: two scheduled builds share an instance`);
      if (live[k]) {
        assert.notEqual((a[k] as any).instance, (live[k] as any).instance, `${k}: scheduled shares an instance with live`);
      }
    }
  });

  await check("a cloned server keeps its tools, schemas and alwaysLoad pin", async () => {
    // A clone that mounts but drops a tool, an arg schema, or the pin would trade a loud
    // failure for a quiet one. reminders is the useful case: `set` is pinned, and its args
    // are the kind of schema a lazy clone would flatten.
    const { cloneInProcessServer } = await import("../runtimes/mcpInstances");
    const { remindersServer } = await import("./reminders-tools");
    const src = (remindersServer as any).instance._registeredTools;
    const copy = (cloneInProcessServer(remindersServer as any) as any).instance._registeredTools;
    assert.deepEqual(Object.keys(copy), Object.keys(src));
    assert.equal(copy.set.description, src.set.description);
    assert.deepEqual(Object.keys(copy.set.inputSchema.shape), Object.keys(src.set.inputSchema.shape));
    assert.equal(copy.set._meta?.["anthropic/alwaysLoad"], true, "a cloned pinned tool must stay pinned");
    assert.equal(typeof copy.set.handler, "function");
    // And a PARTLY pinned server must clone partly pinned. The clone used to re-apply the pin
    // server-wide if any one tool carried it, which was harmless while pins were server-level
    // and would now hand every lane a schema the definition deliberately deferred.
    const { scheduledTasksServer } = await import("./scheduledTasks-tools");
    const tasks = (cloneInProcessServer(scheduledTasksServer as any) as any).instance._registeredTools;
    assert.equal(tasks.schedule._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tasks.list._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tasks.cancel._meta?.["anthropic/alwaysLoad"], undefined, "a clone must not pin cancel");
    // File-based MCP servers get their own process per query, so they're passed through as-is.
    const fileMcp = { type: "stdio", command: "x" } as any;
    assert.equal(cloneInProcessServer(fileMcp), fileMcp);
  });

  await check("every SDK query site mounts fresh instances", () => {
    // The rule, enforced where it can't be forgotten: mounting is cloning. Declaring a server
    // map is harmless — specialists, triage and research all build theirs from module-level
    // singletons — what matters is the handful of places that actually hand a map to `query()`.
    // Patching declaration sites one by one would hold only until the next one was added, so
    // the clone lives at the query call and this test asserts every such call is covered.
    const root = path.join(__dirname, "..");
    const sites: string[] = [];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          const src = fs.readFileSync(p, "utf8");
          // The SDK's own `query({`, not e.g. google's freebusy.query(.
          for (const m of src.matchAll(/(^|[^.\w])query\(\{/g)) {
            const rel = path.relative(root, p);
            sites.push(rel);
            // The mcpServers value within this call's options.
            const after = src.slice(m.index ?? 0, (m.index ?? 0) + 1200);
            const val = after.match(/mcpServers:\s*([^,\n]*)/)?.[1]?.trim();
            if (!val) continue; // no servers mounted here at all
            if (/freshInstances\(|buildScheduledMcpServers\(|buildFigMcpServers\(/.test(val)) continue;
            offenders.push(`${rel}: mcpServers: ${val}`);
          }
        }
      }
    };
    walk(root);
    assert.ok(sites.length >= 3, `expected to find the SDK query sites, saw ${sites.length}`);
    assert.deepEqual(
      offenders,
      [],
      `these mount a server map without fresh instances — wrap in freshInstances():\n  ${offenders.join("\n  ")}`,
    );
  });

  console.log("degraded runs: wiring failure vs a tool the pass just didn't call");

  await check("unattendedLaneProvidesTool answers from the lane, not from a name pattern", async () => {
    const { unattendedLaneProvidesTool } = await import("./lane");
    // The mail + calendar tools the nightly sweeps lean on: in the lane, and the whole reason
    // this function exists — a name-pattern guess reports pinned tools as improvised-around
    // while they're sitting in the pass's own turn-1 prompt.
    assert.equal(unattendedLaneProvidesTool("mcp__mailsearch__find"), true);
    assert.equal(unattendedLaneProvidesTool("mcp__calendar__list"), true);
    assert.equal(unattendedLaneProvidesTool("mcp__gmail__list"), true);
    assert.equal(unattendedLaneProvidesTool("mcp__outlook__get"), true);
    // Server keys AND tool names both contain underscores, so the split point can't be
    // inferred from the string — this is the case a naive regex gets wrong.
    assert.equal(unattendedLaneProvidesTool("mcp__memory__recall_conversations"), true);
    assert.equal(unattendedLaneProvidesTool("mcp__scheduled_tasks__schedule"), true);
    // Genuinely excluded servers, i.e. the real wiring-failure case.
    assert.equal(unattendedLaneProvidesTool("mcp__research__deep_research"), false);
    assert.equal(unattendedLaneProvidesTool("mcp__code__delegate"), false);
    // Real server, tool that doesn't exist on it — must not pass just because the server does.
    assert.equal(unattendedLaneProvidesTool("mcp__agentmail__list_inboxes"), false);
    assert.equal(unattendedLaneProvidesTool("mcp__gmail__nonexistent"), false);
    // Built-ins aren't a lane question at all.
    assert.equal(unattendedLaneProvidesTool("Bash"), false);
  });

  await check("splitMissingByReachability separates a wiring bug from a skipped call", async () => {
    const { splitMissingByReachability } = await import("./requiredTools");
    const provides = (t: string) => t === "mcp__calendar__list" || t === "mcp__location__where_is";
    const split = splitMissingByReachability(
      ["mcp__calendar__list", "mcp__research__deep_research"],
      provides,
    );
    assert.deepEqual(split.uncalled, ["mcp__calendar__list"]);
    assert.deepEqual(split.unreachable, ["mcp__research__deep_research"]);
    // A SERVER entry is reachable when any of its tools is — otherwise a run that did its job
    // through a sibling tool gets called a wiring failure.
    const srv = splitMissingByReachability(["location"], provides);
    assert.deepEqual(srv.unreachable, []);
    assert.equal(srv.uncalled.length, 1);
    // An entry the registry publishes nothing for → genuinely unreachable.
    const none = splitMissingByReachability(["fig_tools"], provides);
    assert.equal(none.unreachable.length, 1);
  });

  await check("the briefing failure does not reproduce", async () => {
    // The failure: `briefing` declares email + calendar, the pass calls neither, and the guard
    // suppresses the brief with an alert saying it "improvised around" them — while both were
    // pinned into that pass's turn-1 prompt. Two things have to be true for that, and this
    // asserts both are false.
    const { splitMissingByReachability, missingRequiredTools, uncalledToolNote } = await import("./requiredTools");
    const { unattendedLaneProvidesTool } = await import("./lane");
    const toolsUsed = ["ToolSearch", "Skill", "Bash", "Read", "mcp__location__where_is", "Edit"];

    // 1. Nothing the briefing declares is unreachable — so it can never produce a wiring alert.
    const missing = missingRequiredTools(["mcp__calendar__list"], toolsUsed);
    const { unreachable, uncalled } = splitMissingByReachability(missing, unattendedLaneProvidesTool);
    assert.deepEqual(unreachable, [], "a reachable tool must never be reported as a wiring failure");
    assert.deepEqual(uncalled, ["mcp__calendar__list"]);

    // 2. A one-off skipped call doesn't say anything to the owner at all — the brief still ships.
    assert.equal(uncalledToolNote("briefing", uncalled, 1), null);
    assert.equal(uncalledToolNote("briefing", uncalled, 2), null);
    assert.ok(uncalledToolNote("briefing", uncalled, 3)?.includes("3 runs in a row"));

    // 3. And email is no longer declared, because the skill's own step 1 forbids the inbox path.
    const f = path.join(
      process.env.BRAIN_DIR || path.join(process.env.HOME || "", "GitHub", "brain"),
      ".claude/skills/briefing/SKILL.md",
    );
    if (fs.existsSync(f)) {
      const fm = fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/);
      assert.deepEqual(parseRequiredTools(fm![1]), ["calendar"]);
    }
  });

  await check("laneServerDrift catches a server added to neither side", () => {
    // Proving the guard fires, rather than trusting that it would. A test that only ever sees
    // the passing case is the same shape as a guardrail aimed at a file that doesn't exist.
    const drift = laneServerDrift(
      { ...buildFigMcpServers(), brand_new_server: {} },
      buildScheduledMcpServers(),
      [...allRegisteredServerKeys(), "brand_new_server"],
    );
    assert.deepEqual(drift.undecided, ["brand_new_server"]);
  });

  await check("every requirement a scheduled skill declares resolves and is in the lane", () => {
    // Two halves bound together. A declaration that resolves to nothing would fail EVERY run
    // with a degraded alert; one that resolves to a server the lane doesn't carry is the
    // wiring bug this whole guard exists for.
    const lane = buildScheduledMcpServers();
    if (!fs.existsSync(skillsDir())) {
      console.log(`    (skipped — no vault at ${skillsDir()})`);
      return;
    }
    let checked = 0;
    for (const [skill, fm] of scheduledSkillFrontmatter()) {
      for (const entry of parseRequiredTools(fm)) {
        const names = resolveRequirement(entry);
        assert.ok(
          names.length > 0,
          `${skill} declares "${entry}", which resolves to nothing in the registry`,
        );
        for (const name of names) {
          const server = name.match(/^mcp__(.+?)__/)?.[1];
          assert.ok(server! in lane, `${skill} declares ${entry} but server "${server}" is not in the scheduled lane`);
        }
        checked += 1;
      }
    }
    assert.ok(checked > 0, "expected at least one scheduled skill to declare requiredTools");
  });

  console.log("skill lint: a scheduled skill must have decided what it needs");

  await check("every scheduled skill declares requiredTools (empty is legal, absent is not)", async () => {
    // The rule, enforced instead of asked for. `requiredTools` began as a diagnostic for one
    // broken skill and then got added to whatever else was open during that debugging session
    // — 7 of 16 scheduled skills declared, two of those incompletely. Same failure class as the
    // lane maps, one layer up: a rule with no mechanical enforcement decays to "whoever
    // remembered". `requiredTools: []` means "needs nothing, and someone decided that".
    const { lintSkill } = await import("./requiredTools");
    if (!fs.existsSync(skillsDir())) {
      console.log(`    (skipped — no vault at ${skillsDir()})`);
      return;
    }
    const findings = scheduledSkillFrontmatter().flatMap(([skill, fm]) => lintSkill(skill, fm));
    assert.deepEqual(
      findings.map((f) => `${f.skill}: ${f.kind} — ${f.detail}`),
      [],
    );
  });

  await check("the lint fires on each thing it's supposed to catch", async () => {
    const { lintSkill } = await import("./requiredTools");
    // Scheduled, no declaration at all.
    assert.deepEqual(lintSkill("x", "name: x\nschedule: daily 9:00\n").map((f) => f.kind), ["missing-declaration"]);
    // Scheduled, empty declaration — legal, that's the "decided nothing is needed" case.
    assert.deepEqual(lintSkill("x", "schedule: daily 9:00\nrequiredTools: []\n"), []);
    // Not scheduled — the lint doesn't apply; an on-demand skill isn't running unattended.
    assert.deepEqual(lintSkill("x", "name: x\n"), []);
    // A name the registry doesn't publish.
    assert.deepEqual(lintSkill("x", "schedule: d\nrequiredTools: [fig_tools]\n").map((f) => f.kind), ["unresolvable"]);
    assert.deepEqual(
      lintSkill("x", "schedule: d\nrequiredTools: [mcp__location__where_was]\n").map((f) => f.kind),
      ["unresolvable"],
    );
    // A leftover alternation from the duplicate-name era.
    assert.deepEqual(
      lintSkill("x", "schedule: d\nrequiredTools: [mcp__fetch__fetch_url|mcp__fig_tools__fetch_url]\n").map((f) => f.kind),
      ["alternation"],
    );
  });

  await check("pinning is the exception, not the strategy — three tools are alwaysLoad in this lane", () => {
    // alwaysLoad is paid in the turn-1 prompt of EVERY pass. Measured on the real lane's
    // instances: these three cost 2,781 chars of schema (scheduled_tasks.schedule 1,590 +
    // list 508, reminders.set 683); pinning every in-process capability would cost 26,375.
    // Deferred tools cost only their name (~28 chars) and are provably reachable via
    // ToolSearch, so a new pin needs a real turn-1 argument — the arming three earned theirs
    // because a promise and the call that arms it happen in the same turn. This test is the
    // tripwire on that budget. (ack is pinned too but is live-only, so it is not in this
    // lane.) The email + calendar specialists used to be pinned here for 1,416 of those
    // chars; deleting them took the pin with them, and their 34 replacement tools cost their
    // names in the deferred registry instead.
    const lane = buildScheduledMcpServers();
    const pinned: string[] = [];
    for (const [key, cfg] of Object.entries(lane)) {
      const tools = (cfg as any).instance?._registeredTools;
      if (!tools) continue;
      for (const [t, def] of Object.entries<any>(tools)) {
        if (def?._meta?.["anthropic/alwaysLoad"] === true) pinned.push(`mcp__${key}__${t}`);
      }
    }
    assert.deepEqual(pinned.sort(), [
      "mcp__reminders__set",
      "mcp__scheduled_tasks__list",
      "mcp__scheduled_tasks__schedule",
    ]);
  });

  if (failures > 0) {
    console.error(`\n${failures} requiredTools check(s) failed`);
    process.exit(1);
  }
  console.log("\nall requiredTools checks passed");
}

void main();
