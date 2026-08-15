import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The internal-skill contract, both halves of it.
 *
 * WHY THIS FILE EXISTS. An automation skill (`internal: true`) has no business being in the
 * model's skill listing — the owner never types `/heartbeat`, and the listing is char-budgeted
 * (budget = contextTokens * 4 * skillListingBudgetFraction), so 20 automation skills were
 * crowding out the ~31 skills they do invoke until the whole list collapsed to bare names.
 * The vault therefore sets `skillOverrides: {<skill>: "off"}` for every internal skill, which
 * removes it from the listing AND blocks model invocation of it.
 *
 * That has a sharp edge: the moment a skill is "off", any automation that fires it by asking
 * the model to "use your X skill" is broken, silently — the Skill call is refused and the
 * pass improvises. So the second half of the contract is that every automation INLINES its
 * skill body into its own prompt instead of asking for it.
 *
 * Two ways this can rot, and both are covered below:
 *   1. Someone adds `internal: true` (or a new automation skill) and forgets settings.json.
 *      The skill stays in the listing, eating budget, model-invocable — the drift is silent.
 *   2. Someone drops `internal: true`, or renames/deletes the skill, and the "off" entry
 *      outlives it. Now a real skill the owner might want is hidden for no recorded reason —
 *      an undocumented gap that reads like a decision and isn't one.
 *
 * The guard is deliberately bidirectional. A one-way check ("every internal skill is off")
 * would have passed happily through case 2.
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

const brainDir = () => process.env.BRAIN_DIR || path.join(process.env.HOME || "", "GitHub", "brain");
const skillsDir = () => path.join(brainDir(), ".claude", "skills");
const settingsFile = () => path.join(brainDir(), ".claude", "settings.json");

/** [dirName, frontmatter] for every skill in the vault. */
function allSkills(): [string, string][] {
  const out: [string, string][] = [];
  for (const d of fs.readdirSync(skillsDir())) {
    const f = path.join(skillsDir(), d, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    const fm = fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    out.push([d, fm[1]]);
  }
  return out;
}

const isInternal = (fm: string) => /^internal:[ \t]*true[ \t]*$/m.test(fm);

async function main(): Promise<void> {
  const haveVault = fs.existsSync(skillsDir());

  // ---- THE SYNC GUARD ------------------------------------------------------------------
  await check(
    'internal:true skills and skillOverrides "off" stay in sync (both directions)',
    () => {
      if (!haveVault) return console.log(`    (skipped — no vault at ${skillsDir()})`);
      const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      const overrides: Record<string, string> = settings.skillOverrides ?? {};

      const internal = allSkills()
        .filter(([, fm]) => isInternal(fm))
        .map(([d]) => d)
        .sort();
      const turnedOff = Object.entries(overrides)
        .filter(([, mode]) => mode === "off")
        .map(([name]) => name)
        .sort();

      // Direction 1: a new/changed internal skill that nobody turned off.
      const unhidden = internal.filter((s) => !turnedOff.includes(s));
      assert.deepEqual(
        unhidden,
        [],
        `these skills are \`internal: true\` but are NOT "off" in ${settingsFile()} — they're still in ` +
          `the model's skill listing, eating budget, and model-invocable. Add "<name>": "off" to ` +
          `skillOverrides: ${unhidden.join(", ")}`,
      );

      // Direction 2: an "off" entry that outlived its skill or its internal flag.
      const known = new Map(allSkills());
      const stale = turnedOff.filter((s) => !known.has(s) || !isInternal(known.get(s)!));
      assert.deepEqual(
        stale,
        [],
        `these skillOverrides "off" entries don't name an \`internal: true\` skill — either the skill ` +
          `was renamed/deleted, or it stopped being internal and is now hidden for no recorded reason. ` +
          `Remove the entry (or restore the flag): ${stale.join(", ")}`,
      );

      // Everything else in skillOverrides is a deliberate non-"off" mode; there are none
      // today, and one appearing should be a decision someone writes down, not a surprise.
      const other = Object.entries(overrides).filter(([, mode]) => mode !== "off");
      assert.deepEqual(
        other.map(([n, m]) => `${n}: ${m}`),
        [],
        "a non-\"off\" skillOverrides mode appeared. That's legal, but this guard only reasons about " +
          "\"off\" — extend it (and say why the mode was chosen) rather than deleting the assertion.",
      );
    },
  );

  await check("every internal skill has a body to inline (frontmatter alone is not a procedure)", async () => {
    if (!haveVault) return console.log(`    (skipped — no vault at ${skillsDir()})`);
    const { readSkillBody } = await import("./skillBody");
    for (const [dir, fm] of allSkills()) {
      if (!isInternal(fm)) continue;
      const body = readSkillBody(dir, skillsDir());
      assert.ok(body.length > 100, `${dir}/SKILL.md has a suspiciously short body (${body.length} chars)`);
    }
  });

  await check("skill directory name == its `name:` frontmatter field", () => {
    if (!haveVault) return console.log(`    (skipped — no vault at ${skillsDir()})`);
    // The scheduler locates SKILL.md by DIRECTORY and reports/schedules by `name:`. They agree
    // for every skill today; this pins that, because if they ever diverge the failure is a
    // scheduled pass that can't find its own procedure.
    const mismatched = allSkills()
      .map(([dir, fm]) => [dir, fm.match(/^name:[ \t]*(.+)$/m)?.[1]?.trim()] as const)
      .filter(([dir, name]) => name !== dir)
      .map(([dir, name]) => `${dir} (name: ${name})`);
    assert.deepEqual(mismatched, []);
  });

  // ---- THE INLINING ITSELF -------------------------------------------------------------
  await check("stripFrontmatter drops the YAML block and nothing else", async () => {
    const { stripFrontmatter } = await import("./skillBody");
    assert.equal(stripFrontmatter("---\nname: x\nschedule: daily 9:00\n---\n\n# Body\n\ndo it\n"), "# Body\n\ndo it");
    // A `---` horizontal rule inside the body must survive (non-greedy match on the FIRST close).
    assert.equal(stripFrontmatter("---\nname: x\n---\nstep one\n\n---\n\nstep two\n"), "step one\n\n---\n\nstep two");
    // No frontmatter at all: the whole file is the body.
    assert.equal(stripFrontmatter("just prose\n"), "just prose");
    // Frontmatter and nothing else — the fail-loud case readSkillBody rejects.
    assert.equal(stripFrontmatter("---\nname: x\n---\n"), "");
  });

  await check("readSkillBody throws (never returns empty) on a missing or bodyless SKILL.md", async () => {
    const { readSkillBody, SKILL_BODY_ERROR } = await import("./skillBody");
    const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "skillbody-"));
    // Missing entirely.
    assert.throws(() => readSkillBody("nope", tmp), (e: Error) => e.message.includes(SKILL_BODY_ERROR));
    // Present but frontmatter-only. This is the one that MUST NOT silently pass: an empty
    // procedure inlined into a run prompt looks like a working pass and does nothing.
    fs.mkdirSync(path.join(tmp, "hollow"));
    fs.writeFileSync(path.join(tmp, "hollow", "SKILL.md"), "---\nname: hollow\nschedule: daily 9:00\n---\n");
    assert.throws(() => readSkillBody("hollow", tmp), (e: Error) => e.message.includes(SKILL_BODY_ERROR));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await check("the inlined block carries the body, the skill's own dir, and a don't-invoke instruction", async () => {
    const { skillProcedureBlock } = await import("./skillBody");
    const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "skillbody-"));
    fs.mkdirSync(path.join(tmp, "newspaper"));
    fs.writeFileSync(
      path.join(tmp, "newspaper", "SKILL.md"),
      "---\nname: newspaper\nschedule: daily 9:00\nrunPrompt: go\n---\nRead `references/interests.md` then write.\n",
    );
    const block = skillProcedureBlock("newspaper", tmp);
    // The procedure text is actually there, verbatim.
    assert.ok(block.includes("Read `references/interests.md` then write."));
    // The frontmatter is NOT — re-feeding `runPrompt` would hand the pass a second, competing
    // instruction alongside the one the scheduler already framed the task with.
    assert.ok(!block.includes("runPrompt"));
    assert.ok(!block.includes("schedule: daily"));
    // Relative asset paths inside a body (references/, scripts/) resolved from the skill dir
    // under the Skill tool; an inlined pass has the vault root as cwd, so the block says where.
    assert.ok(block.includes(".claude/skills/newspaper/"));
    // And it must stop the pass from hunting for a skill that's deliberately not in its list.
    assert.match(block, /do NOT call the Skill tool/i);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await check("no internal skill's runPrompt asks the model to invoke a skill", async () => {
    if (!haveVault) return console.log(`    (skipped — no vault at ${skillsDir()})`);
    // `runPrompt` is frontmatter the scheduler pastes into the run prompt verbatim, so
    // "Use your briefing skill to…" is the same bug as the in-code version one layer over:
    // the pass tries the Skill tool, gets refused, and can report itself unavailable. The
    // procedure is already inlined right below the runPrompt — it just has to stop asking.
    // Read the field with the SAME parser the scheduler uses. A bespoke regex here got the
    // YAML block scalar wrong (`$` under /m ends at the first line, so it only ever saw
    // "runPrompt: |") and the guard passed on text it should have caught — a green check that
    // was measuring nothing.
    const { frontmatterField } = await import("./requiredTools");
    const internalNames = allSkills().filter(([, fm]) => isInternal(fm)).map(([d]) => d);
    const offenders: string[] = [];
    for (const [dir, fm] of allSkills()) {
      if (!isInternal(fm)) continue;
      const rp = frontmatterField(fm, "runPrompt") ?? "";
      // Scoped to INTERNAL skill names on purpose. An unscoped "run the X skill" match flagged
      // spot-daily for telling its pass to run spot-carousel — which is a non-internal skill it
      // legitimately still invokes. Only naming a skill that's turned OFF is the bug.
      for (const name of internalNames) {
        if (new RegExp(`(use|using|run|invoke)\\s+(your|the)\\s+["'\`]?${name}["'\`]?\\s+skill`, "i").test(rp)) {
          offenders.push(`${dir} → ${name}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these runPrompts tell the pass to invoke a skill. Internal skills are inlined, not invocable — " +
        "say what to DO instead of naming the skill to reach for",
    );
  });

  await check("no skill an internal skill's BODY reaches for is turned off", () => {
    if (!haveVault) return console.log(`    (skipped — no vault at ${skillsDir()})`);
    // The third surface, and the one the other two miss. Inlining fixed how an automation is
    // ENTERED; it did nothing about what that automation reaches for once it is running. The
    // inlined body IS the prompt, so `dream` step 1 ("Invoke the vault-lint skill") is a live
    // Skill call mid-pass — as are page / voice / save / wiki / meeting-prep, which internal
    // bodies call all over. Those skills LOOK conversational, so the tempting cleanup a month
    // from now is to mark one internal and hide it, which silently removes half of dream's
    // contract with nothing erroring. So: a skill named inside an internal body may not be off.
    const off = new Set<string>();
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      for (const [name, v] of Object.entries(settings.skillOverrides ?? {})) {
        if (v === "off") off.add(name);
      }
    } catch {
      /* the sync guard above owns a missing/broken settings.json */
    }
    for (const [dir, fm] of allSkills()) if (isInternal(fm)) off.add(dir);

    const offenders: string[] = [];
    for (const [dir, fm] of allSkills()) {
      if (!isInternal(fm)) continue;
      const raw = fs.readFileSync(path.join(skillsDir(), dir, "SKILL.md"), "utf8");
      const body = raw.replace(/^---\n[\s\S]*?\n---/, "");
      for (const name of off) {
        if (name === dir) continue; // a body referring to itself is not a Skill call
        if (new RegExp(`(use|using|run|invoke)\\s+(your|the)\\s+["'\`]?${name}["'\`]?\\s+skill`, "i").test(body)) {
          offenders.push(`${dir} → ${name}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "an internal skill's body invokes a skill that is turned OFF, so that call gets refused mid-pass " +
        "and the pass improvises. Either un-hide the named skill, or inline what it does",
    );
  });

  await check("no in-code prompt still asks the model to invoke an internal skill", () => {
    // The regression that would re-break every automation at once: someone writes "use your X
    // skill" into a prompt for a skill that's turned off. The Skill call is refused, the pass
    // improvises, and nothing errors. Scan the prompt-building source for the phrasing.
    const srcDir = path.join(__dirname, "..");
    const offenders: string[] = [];
    const internalNames = haveVault
      ? allSkills().filter(([, fm]) => isInternal(fm)).map(([d]) => d)
      : [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
          // Comments are stripped first. Checking the raw text flags a comment that QUOTES the
          // old phrasing to explain why it's gone — a string match where an operation was
          // meant, which is the same false-positive shape as a guardrail denying a grep for
          // mentioning a filename. Only prompt strings can actually mislead the model.
          const txt = fs
            .readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "")
            .replace(/([^:"'`\\])\/\/.*$/gm, "$1");
          for (const name of internalNames) {
            // Quoted-or-bare skill name followed by the word "skill", in an instruction verb
            // phrase — the shape of `use your "reconcile" skill` / `using the email-triage skill`.
            const re = new RegExp(`(use|using|run|invoke)\\s+(your|the)\\s+["'\`]?${name}["'\`]?\\s+skill`, "i");
            if (re.test(txt)) offenders.push(`${path.relative(srcDir, p)} → ${name}`);
          }
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(
      offenders,
      [],
      "these prompts ask the model to invoke a skill that skillOverrides turns OFF — the call will be " +
        "refused and the pass will improvise. Inline the body with skillProcedureBlock() instead",
    );
  });

  if (failures > 0) {
    console.error(`\n${failures} internal-skill check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${ran} internal-skill checks passed`);
}

void main();
