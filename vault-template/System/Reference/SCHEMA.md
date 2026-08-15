---
type: folder-contract
folder: Reference
verifier: vault-lint
---

# Reference schema

The contract for `System/Reference/` — the vault's **durable lookup layer**. A
Reference note answers "how does this thing work?" or "what is this fact?" for
something that will still be true in six months, so the agent never re-derives
it and never guesses.

It exists because that knowledge otherwise dies in the wrong places: setup
detail written into a `Pending` loop gets deleted with the loop, and machine
facts written into a dated log are unfindable the next week. Reference is where
a fact goes to stop being time-bound.

## Domain — what belongs

Two shapes, and only two:

1. **Operating manual** — how a machine, tool, account, or piece of the agent's
   own infrastructure works. The test: the agent would otherwise have to
   re-derive it by poking at the system.
2. **Fact card** — a small set of standing facts about the owner that a task
   needs verbatim and that no log owns: an ID number, a plate, a standing
   profile.

Does NOT belong here:

- Anything **time-bound**. Live state, an open loop, "still owed" →
  `Pending.md` (with a pointer here for the durable half).
- **How the agent should behave.** A rule with teeth → `System/Policies/`. A
  voice or identity rule → `SOUL.md`. A correction the owner made →
  `System/Feedback/`.
- **A durable fact about the owner** that belongs in the always-loaded surface
  → `Owner.md`. Reference holds what's too long or too niche to pay for every
  turn.
- **A repeatable procedure the agent executes** → a skill. If it has steps, a
  trigger, and an output, it's a skill, not a reference. Mechanics for ONE
  skill's job live in that skill's own `references/` dir, never here —
  `System/Reference/` is cross-cutting knowledge; a skill's `references/` is
  that skill's private manual.
- **A second copy of anything.** One canonical home per fact. A Reference note
  may point at a repo's own README; it may not restate it.

## Shape

- **Flat.** No subfolders. One file per subject, `kebab-case.md`, named for the
  subject and not for the day it was learned.
- **Frontmatter, required on every note:**
  ```
  ---
  type: reference
  created: YYYY-MM-DD
  updated: YYYY-MM-DD
  consumer: <who reads this — a skill name, a tool, a file path, or "on demand">
  tags: [...]          # optional
  ---
  ```
- **`consumer:` is the load-bearing field.** See the next section.
- **Opens with one or two lines saying what it is and who reads it**, then the
  content. No preamble, no history of how it was discovered.
- **Terse and operational.** Commands, paths, IDs, gotchas. A note past ~250
  lines is probably two subjects or is restating a repo's docs.

## Discoverability — the rule that makes this folder real

A Reference note nobody can find is worse than no note: it is correct, unread,
and it silently competes with whatever the agent guesses instead.

- **Every note declares a `consumer:`** in frontmatter — the skill, tool,
  policy, or note that reads it.
- **Every note has at least one live inbound pointer** from that consumer: a
  `[[wikilink]]` or a `System/Reference/<name>.md` path in a skill body, a
  policy, a hub, or another Reference note. A pointer from a dated log does NOT
  count — a log records that the note was created, it isn't a route to it.
- **`consumer: on demand`** is allowed only for a fact card whose whole job is
  to be looked up when a form asks. Even then it needs one real inbound link
  from the note that owns the subject.
- **The pointer is written in the same act as the note.** Authoring a Reference
  note without wiring its consumer is an incomplete write, the same way writing
  into a hub's domain without updating the hub is.

## Supersession — when to delete instead of update

A Reference note is deleted, not archived, when the thing it documents becomes
a first-class tool. This is the folder's most common rot: the note tells the
agent to shell out to a script that a real tool now wraps, so the note is
actively misleading while looking perfectly healthy. When a tool, skill
description, or always-loaded pointer fully covers a note's job, delete the
note and keep the one surviving home. Salvage only the facts the new surface
does not carry, into the file that owns them.

## Checks — the runnable rulebook (`vault-lint` executes this)

Scope: every `.md` in `System/Reference/` except this file. Each rule is
`[auto]` (fix in place + note it) or `[flag]` (surface with a recommendation,
never auto-applied).

- [auto] flat folder: no subdirectories in `System/Reference/`.
- [auto] frontmatter present and complete: `type: reference`, `created`,
  `updated` (both ISO `YYYY-MM-DD`, neither in the future), `consumer`
  non-empty. A wrong `type` is corrected in place.
- [auto] filename is `kebab-case.md`, carries no date, and matches the subject
  in the H1.
- [flag] **orphan note**: zero inbound pointers from outside
  `System/Reference/` and outside dated logs. Recommendation: wire the declared
  `consumer`, or delete per Supersession. This is the primary check — it's the
  failure this contract was written for.
- [flag] **dead consumer**: the `consumer:` names a skill/tool/path that no
  longer exists. Recommendation: re-home or delete.
- [flag] **dead path**: a repo path, script, or vault path cited inside the
  note that no longer exists on disk.
- [flag] **superseded note**: the note instructs a CLI/manual procedure for
  something a registered tool now covers. Recommendation: delete per
  Supersession.
- [flag] **stale note**: `updated` older than 90 days AND the system it
  documents has changed since.
- [flag] **time-bound content**: live status, "still owed", "as of this week",
  an open loop. Recommendation: move that half to `Pending.md` and leave the
  durable part.
- [flag] **duplication**: a fact stated here that also lives in `Owner.md`, a
  `System/Policies/` file, or a skill's own `references/`. Recommendation: keep
  one home, replace the other with a pointer.
- [flag] **length**: past ~250 lines → recommend splitting or pointing at the
  repo's own docs instead of restating them.
