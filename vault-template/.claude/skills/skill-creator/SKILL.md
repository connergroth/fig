---
name: skill-creator
description: >-
  Build a new skill (or fix/standardize an existing one) for this setup. Trigger when the owner says "make a skill for X", "turn this into a skill", "we should have a skill that...", "standardize how you do X", or when a task they ask for keeps recurring and deserves its own repeatable workflow. ALSO covers "learn from source" — when they point you at an artifact to learn ("learn this codebase/sdk/docs", "read this repo and make a skill for it", "ingest these docs into a skill"), you go read it for real and author a reference-shaped skill from it. Also covers scaffolding a standardized template/structure file for a recurring note type (daily log, meeting notes, person note).
---

# skill-creator (the house style for building skills)

This is the meta-skill. It exists so every skill added comes out in the SAME
shape, so the collection stays consistent as it grows instead of each one being
a one-off. When the owner wants a new capability made repeatable, use this to
build it — don't freehand a skill from memory, follow this so it matches the
others.

The philosophy: standardized instruction files keep structure consistent. A
skill IS that instruction file — it teaches future-you how to do one job the
same way every time. Bake the guidance in once; reap consistency forever.

## what a skill is here

- A folder under `.claude/skills/<name>/` containing a `SKILL.md`. Lowercase,
  hyphenated folder name that matches the `name` field.
- The harness reads `.claude/skills/` by path, so a new folder + SKILL.md is all
  it takes to register one. No other wiring.
- Supporting files live under a purpose-named resource folder:
  `references/` for docs, playbooks, preferences, templates the agent reads;
  `scripts/` for executable helpers; `assets/` only for output assets. Do not
  leave loose top-level files next to `SKILL.md`.

## who runs the skill — decide placement BEFORE writing it

A skill is just an instruction file; WHO runs it is a wiring choice, and it
shapes the whole design. Two kinds:

- **Main-agent skill (the default).** Triggered by the owner's phrasing to the
  main agent, which runs it. Most skills.
- **Subagent-run skill.** A specialist (email/browser/calendar agent) runs it
  end to end as part of its job — usually fired by an event, producing a
  structured brief the main agent turns into the owner's text. To wire one,
  point the specialist's brief (the harness repo's
  `src/specialists/prompts/<x>-agent.md`) at the skill so it knows to run it.

The dividing line is one question: **does the job need a back-and-forth with
the owner?**
- Interactive / conversational / in their voice / writes to the vault →
  main-agent skill.
- Autonomous, self-contained, one specialist's tools, structured output, NO
  conversation mid-run → can live in a subagent.

## brain/hands — when a main-agent skill delegates to a specialist

Many main-agent skills still need a specialist's tools for PART of the job.
Keep the split clean and wire BOTH sides, or it's only half-built:
- the SKILL (brain) owns the judgment, the conversation with the owner, the
  vault writes, and the voice.
- the specialist (hands) does the mechanical tool work and returns RAW results
  — it does not curate, judge, or compose.
- **whenever a skill delegates, add a matching note to the specialist's brief**
  spelling out exactly what it fetches/does for that skill and what it must NOT
  do. The skill and the brief are two halves of one contract; a skill that
  delegates without updating the brief is half-wired.

Example of the split: a "draft in my voice" skill (brain: drafts + refines with
the owner) ↔ the email agent (hands: reads sent mail to ground the voice, saves
the approved draft).

## anatomy of a SKILL.md (match this exactly)

1. **YAML frontmatter**, opening the file:
   ```
   ---
   name: <lowercase-hyphenated, matches folder>
   description: >-
     <what it does + WHEN to trigger, written so the agent can pattern-match>
   schedule: <optional — only for skills that fire on a clock, e.g. "daily 7:00">
   internal: <optional — true for scheduled/event automation or specialist-only skills>
   ---
   ```
   - `description` is the most important line in the file. It's the trigger. It
     must say both what the skill does AND the concrete phrases/situations that
     should fire it, ideally with example user phrasings in quotes. A vague
     description means the skill never fires when it should.
   - Use block-scalar descriptions (`description: >-`) by default. Long trigger
     descriptions often contain `: `, quotes, and paths; block scalars keep
     YAML valid.
   - Only add `schedule` if it genuinely runs on a timer.
   - `internal: true` hides the skill from the `/command` system (the owner can
     type `/<skill-name>` to force any visible skill directly). Set it for
     scheduled skills, event-triggered skills, and specialist-only skills so
     automation plumbing does not show up as a user-facing command.

2. **Title** — `# <skill name>` with a short parenthetical if it sharpens it.

3. **One-paragraph intro** — what this skill is for and the core principle, in
   plain language. Set the mental model before the steps.

4. **Context section(s)** if the skill needs standing facts (targets, paths,
   preferences). Mark this as the source of truth so it's edited here, not
   hardcoded elsewhere.

5. **The workflow** — numbered steps, the actual procedure to run every time.
   Be concrete: which file to read first, what to check, what to compute, where
   to write, what to reply. This is the heart of the skill.

6. **A template** when the skill creates or appends to files — show the exact
   structure in a fenced block so output is identical every time. This is the
   standardization payoff.

7. **Edge cases / notes** — the gotchas, the "if X then Y", the don'ts.

## knowledge that ships with the skill (references/ + progressive disclosure)

Sometimes a new skill comes WITH durable knowledge — a framework, a scorecard,
a reference table the skill acts on. Don't cram it into SKILL.md and don't
scatter it into the vault. **SKILL.md stays lean; the deep knowledge lives in
`.claude/skills/<name>/references/<thing>.md` and loads on demand.** That's
progressive disclosure — the entry file is the trigger + workflow, the
reference is the substrate it pulls only when it runs.

This is governed by `Memory.md`'s one-canonical-home law — the short of it for
skill-building:
- **Operational knowledge** (the skill acts on it, it changes behavior) → goes
  in THIS skill's `references/`. That's its canonical home.
- **Stock knowledge** (general fact, queried by many skills or by the owner
  directly, doesn't drive one skill's logic) → a vault topic note or the Wiki
  if this vault has one. If the skill needs to point at it, link it; don't copy
  it in.
- **One canonical home, never two.** Duplicates drift.

The wiring is NON-OPTIONAL — an unlinked reference is orphaned and never fires
(same bug as an orphaned skill). When you add a `references/` file you MUST
wire it into the SKILL.md in two places: (1) a line in a file-map / "what this
skill reads" section so the agent knows it exists, and (2) the EXACT workflow
step that consumes it. The weekly `dream` sweep verifies every `references/*.md`
is linked from its SKILL.md and flags orphans — but file it wired in the first
place.

## voice + writing rules for the body

- Write instructions TO the agent (second person: "read the file first",
  "reply short"). You're teaching future-you, not describing to the owner.
- Be specific over clever. Exact paths, exact filenames, exact field names.
- Show, don't just tell: include a real example or a filled-in template.
- Keep the agent's voice rules implicit — they come from `SOUL.md`, don't
  restate them. But if a skill's reply has a specific shape, spell that out.
- Don't bloat it. A skill is a sharp instruction sheet, not an essay. If a line
  doesn't change behavior, cut it. And don't instruct against what the model
  already does well by default — that's wasted tokens.

## the process when the owner asks for a skill

1. **Nail the trigger first.** Before writing anything, be clear on: what's the
   one job, and what should make it fire? If that's fuzzy, ask one sharp
   question — don't guess a trigger; a wrong one makes the skill misfire or
   stay silent.
2. **Check it doesn't already exist** or overlap an existing skill. Grep
   `.claude/skills/`. If it's really an extension of one already here, edit
   that instead of making a near-duplicate.
3. **Decide placement** (see "who runs the skill" above): main-agent skill or
   subagent-run? And if it delegates to a specialist for part of the job, plan
   to wire the specialist's brief too — that's part of building it, not an
   afterthought.
4. **Draft the frontmatter** — name, and a description loaded with trigger
   phrases. This is 80% of whether the skill works.
5. **Write the body** following the anatomy above. Pull real specifics from the
   vault (paths, the owner's context) so it's concrete to this setup, not
   generic.
6. **Include a template** if it touches files, and wire any file paths to where
   that kind of thing actually lives (check `Memory.md` / `README.md` for the
   right folder).
7. **Save** to `.claude/skills/<name>/SKILL.md`.
8. **Tell the owner** what you built in a couple lines: the name, the trigger,
   and the one-line of what it does. Offer to tweak the trigger if it feels off
   — the trigger is the thing most worth getting right, and they'll know from
   feel.

## quality bar before you call it done

- Could a fresh agent run this skill with zero other context and produce the
  same result every time? If not, it's underspecified — add the missing
  step/template.
- Does the description contain phrasings the owner would actually text?
- Are all file paths real and consistent with the vault layout?
- Is there a template for anything it writes?
- Is placement right (main-agent vs subagent-run), and if it delegates, is the
  specialist's brief updated to match? A delegating skill with no brief note is
  half-wired.
- Did you cut everything that doesn't change behavior?

## learn from source (the second way a skill gets born)

Most skills come from a workflow the owner describes. The OTHER entry path:
they point you at an artifact — a local codebase/dir, an SDK, a doc set, a URL
— and say "learn it." You go READ it for real, then distill a reference-shaped
skill that loads on-demand whenever they're touching that thing. Next time
they're debugging that repo, you load the skill and you're already oriented —
architecture, conventions, gotchas, real commands — instead of re-deriving it
from scratch every session.

The key design decision is what NOT to build:

- **No ingestion engine. The agent picks tools inline.** Do NOT hard-code
  per-shape rulebooks ("if codebase do X, if url do Y"). Just read the artifact
  with whatever fits: a local repo → walk the tree, read entry points +
  configs, scan the test dir; a URL/doc → fetch it; an SDK → read its public
  surface + examples. Tool-selection is your job at runtime, not a routing
  table baked into the skill.
- **The leverage is OUTPUT DISCIPLINE, not ingestion.** A learned skill is only
  as good as it is faithful and tight. Clamp every learned skill to the
  template below.

### the output template every learned skill must follow

Section order is FIXED. Description ≤60 chars. Most-common workflow first, edge
cases last. Refs loaded on demand.

```
---
name: <thing>-codebase   (or <thing>-sdk, <thing>-docs)
description: <=60 chars, says what it covers + when to load it
---

# <thing> — working reference

One line: what this artifact is and when to load this skill.

## When to Use
Load this whenever the owner is touching <repo/sdk/doc-set>: debugging it,
extending it, reviewing it. Don't load it otherwise — it's on-demand, not
always-on.

## Quick Reference
A table of the REAL, verified commands/entry points/paths. Most-used first.
| what | command / path |
| build | <actual command from the repo> |
| test  | <actual command> |
| run   | <actual command> |

## Procedure
The most common workflow(s), step by step, concrete paths and file names.

## Pitfalls
The gotchas that actually bite — the non-obvious stuff you only learn by
reading it.

## Verification
How to confirm a change works (the repo's own test/lint/typecheck command).
```

### the iron rule: no invented commands

NEVER fabricate a CLI command, script, env var, or file path the artifact
doesn't actually have. If you didn't see it in the repo (package.json scripts,
Makefile, README, actual config), it does not go in the skill. A learned skill
that lists a build command that doesn't exist is worse than no skill — it sends
future-you down a wrong path with false confidence. When unsure whether
something's real, leave it out or mark it unverified.

### per-source-type checklist (guidance, not a rigid engine)

A short reminder of what to actually look at, so you don't write a thin skill.
This is a checklist to jog the read, NOT a routing machine — adapt it to what's
there.

- **Codebase / repo:** walk the tree; read the entry point(s) + main config(s);
  map where the real logic lives; find the test layout + the actual test
  command; note the gotchas (the stuff that bit you while reading). Output a
  Quick Reference table of REAL build/test/run commands.
- **SDK / library:** read the public API surface + the official examples;
  capture the canonical usage pattern, auth/setup, and the common footguns.
  Quick Reference = the minimal working snippet + key methods.
- **Doc set / URL:** extract the structure and the load-bearing facts; link
  back to the source rather than copying it wholesale; Quick Reference = the
  few things you reach for most.

### helper scripts go in scripts/

If learning the thing requires real parsing (walking a big dependency graph,
extracting an API surface, summarizing a large tree), write a small script into
the skill's `scripts/` folder and have the skill call it — don't make
future-you re-write a parser inline each time. Keep ad-hoc reads inline;
reserve scripts/ for the reusable mechanical bits.

### the run for "learn X"

1. Confirm the source and the scope in one line if it's fuzzy ("the whole repo,
   or just the pipeline?"). Don't over-ask.
2. READ it for real per the checklist above. Actually open files — don't skim
   the README and call it learned.
3. Author the SKILL.md against the template. Description ≤60 chars, fixed
   section order, real commands only.
4. Add `scripts/` only if real parsing earns it.
5. Show the owner the skill before saving — name, what it covers, the Quick
   Reference table. They confirm, then save.

## propose (offer, never auto-write)

At most, when you notice something non-obvious that'd genuinely work well as a
skill — something the owner wouldn't have flagged themselves — propose it in
ONE line: "btw, the way we just did X would make a clean skill — want me to?"
Then stop. Yes/no, their call.

Hard rule: NEVER author a skill unsolicited. No auto-capture, no "I went ahead
and made it." The bottleneck is good workflows worth capturing, not authoring
volume — bloat is the enemy. If it's obviously a skill, they'll tell you. Only
the non-obvious ones are worth a nudge, and even then it's a one-liner, not a
draft.

## bonus: standardizing a recurring note type (not a full skill)

Same philosophy, lighter touch. When the owner wants a consistent structure for
a recurring page (a daily log, meeting-notes format, a People/ note shape), you
don't always need a full skill — sometimes the move is a template/instruction
file the relevant skill or CLAUDE.md points at. Decide:
- recurring ACTION with a trigger → full skill (this process).
- recurring STRUCTURE for a note type → a template file in the right folder,
  plus a one-line pointer from wherever notes of that type get created, so the
  shape stays identical. Keep the template minimal and show a filled example.

When in doubt, a skill is the safer container — it carries its own trigger and
travels with the workflow.
