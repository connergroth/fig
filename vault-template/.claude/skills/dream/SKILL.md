---
name: dream
description: >-
  Weekly housekeeping sweep of the vault. Runs on a schedule (Friday evening) or on demand when the owner says "run dream", "do a cleanup", "tidy the vault", "sweep", or "consolidate memory". It calls the `vault-lint` skill to verify every folder against its contract (structure, naming, frontmatter, POV, cross-folder consistency, README coverage) and then does the janitor work contracts don't cover - consolidates scattered memory per Memory.md, clears resolved loops in Pending/Tasks, and checks skill consistency (SKILL.md frontmatter, delegating skills wired to their brief, reference orphans) - then texts the owner one short merged summary. Cleanup/hygiene only; it does NOT change skill logic, the agent's capabilities, or propose new ones.
schedule: weekly fri 18:00
requiredTools: []
runPrompt: |
  Run the weekly vault housekeeping sweep. Lint every folder against
  its contract and do the janitor work (consolidate memory, clear resolved loops,
  flag dupes, check skill consistency), actually making the fixes. Then send me one
  short merged summary of what you cleaned. Make the changes, don't just list them.
internal: true
---

# dream (weekly cleanup sweep)

While the owner sleeps, the vault gets tidied. dream is the weekly **janitor +
reporter**. The structural verification — does every folder match its contract
— is done by the `vault-lint` skill, which reads each folder's `SCHEMA.md` and
proves it in spec. dream calls vault-lint, then does the hygiene work that
isn't a per-folder contract (memory consolidation, loop clearing, skill
wiring), merges both into one short text to the owner, and stops. It is NOT
self-improvement: it does not evolve identity, prune skills, or propose
capabilities. It keeps the house clean, nothing more.

Two sources of truth it still leans on directly:
- `Memory.md` — the law for memory tiers and when something gets
  promoted/consolidated.
- `README.md` — the routing table (vault-lint enforces coverage; dream files
  per it).

Core principle: **conservative.** Auto-apply only safe, obvious fixes. Anything
ambiguous or destructive (deleting a file, merging notes that might not be
dupes) gets flagged for the owner, never done silently.

## the sweep (run every step, in order)

### 1. Verify the contracts — call `vault-lint`
Invoke the `vault-lint` skill. It fans out one checker per contract (every
`SCHEMA.md` plus every type-contract, discovered as data), auto-fixes the
mechanical violations, and returns the structured result: per-folder auto-fixes
+ flags, the meta-check (every shaped folder has a contract, every contract
maps to a real scope, README documents every folder, no sync-conflict files),
and the cross-folder consistency pass (same fact in two homes, POV across
knowledge files, dead links, contradictions). Carry its `autofixed` and
`flagged` lists into the report — do not re-do any of that work here.

### 2. Memory consolidation — per Memory.md (the part vault-lint does NOT do)
- Scan the week's `System/Conversations/` (files live in
  `System/Conversations/YYYY-MM/` monthly folders — a week can straddle two, so
  glob `System/Conversations/*/*.md` and filter to the week's dates) for
  durable facts not yet promoted: a new person fact → `People/<name>.md`; a
  stable preference/life fact → `Owner.md`; reusable setup knowledge →
  `System/Reference/`. Promote per Memory.md. Don't duplicate what's already
  filed.
- Same fact scattered across notes → consolidate to the one canonical home,
  leave the others pointing at it. (If the duplication crosses a contract
  boundary, vault-lint will already have flagged it — just resolve the clear
  ones.)
- `People/` upkeep: if someone was talked about this week, update their note's
  "last talked" / mentions.

### 3. Loop hygiene — the root files no contract owns
- `Pending.md` — clear any open loop that's been resolved; keep only live ones.
- `Tasks.md` — clear completed `## Done` items older than ~2 weeks; flag an
  Open task that's gone stale/obsolete.
- `Lists/` — flag obvious duplicates; don't merge entries without
  confirmation.

### 4. Skill consistency (hygiene only — never change a skill's logic)
Skills are not folder-contracts, so they stay dream's job. List
`.claude/skills/` and:
- Each `SKILL.md` has sane frontmatter: `name` matches its folder,
  `description` carries trigger phrases. Flag any that don't.
- Each skill that DELEGATES to a specialist (browser/email/calendar agent) has
  a matching note in that agent's brief (the harness repo's
  `src/specialists/prompts/<x>-agent.md`). Flag any half-wired skill — don't
  write the brief yourself.
- **Reference-orphan check**: any skill with a `references/` folder must have
  every `references/*.md` LINKED from its SKILL.md. Flag any orphan with the
  filename + recommendation; don't auto-wire it.

## what to auto-do vs flag
- **Auto-do** (safe, reversible, obvious): everything vault-lint marked
  `[auto]`, promoting a clear fact to its home, clearing a resolved Pending
  loop, checking off a done task.
- **Flag for the owner** (judgment or destructive): everything vault-lint
  marked `[flag]`, deleting any file, merging notes that might not be dupes,
  resolving a duplicate-file conflict.

## the report (text the owner after the sweep)
One short, skimmable text in normal voice. Merge vault-lint's findings with
dream's own:
- one line: swept the vault, here's the damage
- what got auto-tidied (a tight dash list of the meaningful stuff — fold in
  vault-lint's auto-fixes; don't list every checkbox)
- what needs their call (the flagged items, each with a recommendation)
- if everything was already in spec, say so in a line — that's a fine result,
  don't invent work. The `.state/vault-lint-log.md` line is the durable proof
  it ran.

Example shape:
```
did the weekly sweep 🧹
tidied:
- vault-lint: fixed 3 filenames + 2 missing frontmatter across People/
- promoted 2 facts to People, closed a resolved loop in pending
needs your call:
- a project folder has 4 active notes and no hub — want me to scaffold one?
nothing else out of spec.
```

## scope boundary (important)
dream does cleanup and calls the verifier. It does NOT change a skill's LOGIC,
edit SOUL.md, propose new capabilities, audit what the agent can/can't do, or
author/edit a folder-contract (changing a `SCHEMA.md`'s rules is a deliberate
owner/main-agent act, not a timer job). If a sweep reveals a genuine capability
gap or a contract that's wrong, mention it as a one-line aside in the report —
don't act on it.
