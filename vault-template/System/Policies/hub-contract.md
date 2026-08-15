---
type: type-contract
applies_to: "frontmatter type: hub"
verifier: vault-lint
---

# Hub contract

The constitution for **hubs**. A hub is the one live index note for a big
project or a job — the note the agent opens first when that area comes up, and
the note every other note in that area hangs off. It should contain current
state, recent changes across all inbound sources, and the people involved as
`[[wikilinks]]`.

This is a **type-contract**, not a folder-contract: hubs live inside their own
domain (`Work/`, `Projects/<name>/`), not in a shared folder, so the contract is
scoped by `type: hub` in frontmatter rather than by path. It is otherwise
identical in shape to a `SCHEMA.md` and `vault-lint` executes its `## Checks`
block the same way.

## Why this exists

The hub layer is what makes a vault a graph instead of a pile. Where an
explicit link rule exists, a graph grows; where it doesn't, files accumulate
with zero inbound links and nobody can answer "where does this stand?" without
reading the whole folder. This contract is that rule, made checkable.

## What earns a hub

A **big project** or a **job/role**: something the owner is actively putting
real time into, that generates notes across more than one place, and that they'd
expect the agent to have a current picture of at any moment.

The mechanical trigger (what `vault-lint` flags as a candidate): a domain with
**3+ related notes** and **activity in the last 30 days** and **no hub**. The
judgment on top: a hub is worth it when the area's state lives in more than one
place and a person would otherwise have to read several notes to answer "where
does this stand?"

Not every folder gets one. A single note that fully describes its own subject is
already its own index — a hub over one note is overhead. Dated append-logs
(`System/Conversations/`, `System/reflect/`, `Health/` day-files) never get one.

## Location and naming

- The hub lives **inside its domain**: `Projects/<name>/<name>-hub.md`. When
  the domain is a flat folder shared with other subjects, name the hub for the
  domain.
- `domain:` frontmatter is what resolves a hub, never its filename.

## Frontmatter

```yaml
---
name: <the domain, in the owner's words>
type: hub                         # what makes this a hub; the only selector
domain:                           # globs this hub indexes — see below
  - Projects/thing/**/*.md
updated: YYYY-MM-DD               # bumped every time the hub is touched
---
```

`domain:` is the load-bearing field and the reason this contract is checkable at
all. It declares, as globs, exactly which notes belong to this hub. That single
declaration makes two otherwise-unverifiable rules mechanical:

- **Freshness** — compare the hub's `updated` against the newest mtime across
  its domain. Domain moved, hub didn't → the map is provably behind the
  territory.
- **Completeness** — every note matching the globs must be reachable from the
  hub. A note in the domain that nothing links to is exactly how the pile forms.

Globs are relative to the vault root. A glob prefixed `!` **excludes** — use it
for child notes that hang off a linked note rather than off the hub
(transcripts, generated briefs), so the completeness check doesn't demand a
bullet for every artifact. The hub itself is always excluded. Two hubs must not
claim the same note (`vault-lint` flags an overlap) — one note, one hub, same as
one person, one file.

**Shared, subject-agnostic folders are not globbed at all.** Some folders are
keyed by *what a note is* rather than *whose area it belongs to* (a shared
meetings folder is the classic case). A path glob there cannot distinguish one
domain's notes from another's, so it would swallow every future note belonging
to a second hub and guarantee an overlap. In that situation the hub links those
notes directly from its own index section instead of extending its globs — and
the skill that writes such a note owes the hub bullet explicitly, since no glob
means the push duty below won't fire off the path match.

## Note shape

A hub is an **index**. Detail lives in the linked note; the hub points. If a
section is growing paragraphs of specifics, that content belongs in a child note
with a wikilink left behind.

Required sections, in this order:

- **`## Snapshot (as of YYYY-MM-DD)`** — the current state, in prose, in the
  present tense. Where this stands *right now* and what's next. This is the part
  the owner reads. It gets rewritten, not appended to — a snapshot that accretes
  is a changelog wearing a snapshot's hat.
- **`## Recent`** — dated one-liners of what actually moved, newest first, drawn
  from **all inbound sources**: conversations, email, calendar, commits,
  whatever touched the domain. Each line points at the note or link holding the
  detail. Keep ~10-15 lines; older lines age out (the child notes are the
  permanent record, not this).
- **`## People`** — every person involved in the domain, as `[[wikilinks]]` with
  a one-line "who they are to this". This is the section that makes the graph a
  graph.

Then the domain's own link-out sections — the actual index. One bullet per child
note: what it is, one line of status, a wikilink. Group them however the domain
wants.

Optionally `## Open loops` when the area has enough live threads to be worth
listing separately from `Pending.md`.

## Update duty — how a hub stays fresh

Freshness is not a chore anyone remembers. It's two mechanisms, one push and one
pull, and the push is the one that actually works.

**1. Push — whoever writes in a hub's domain updates the hub in the same
write.** Any skill or pass that creates or materially changes a note matching a
hub's `domain:` globs must, in the same turn:
  - add a `[[wikilink]]` bullet for a **new** note under the right section (a
    new person → `## People`),
  - add one dated line to `## Recent`,
  - rewrite the `## Snapshot` line(s) the change actually invalidates — and only
    those,
  - bump `updated` to today.

Resolving which hub: match the note's path against every `type: hub` note's
`domain:` globs. No match → no hub, nothing to do. Never hardcode "the X hub"
into a skill.

**2. Pull — the nightly `reflect` pass sweeps every hub.** For each hub whose
domain has files newer than its `updated`, reconcile it: refresh Snapshot,
append what moved to `## Recent`, link any unlinked domain note, bump `updated`.
No movement, no touch. This is the backstop that catches whatever the push path
missed; it is not the primary mechanism.

**3. Create — a flagged candidate becomes a hub on the next `reflect`.** Hubs
are never auto-authored blind by lint. `vault-lint` flags the candidate domain;
the next nightly pass writes the scaffold with real links and a real Snapshot,
since it can actually read the domain.

## Checks — the runnable rulebook (`vault-lint` executes this)

Scope: every note in the vault whose frontmatter has `type: hub`, plus — for the
`hub candidate` rule only — the domains that have no hub yet. Each rule is
tagged `[auto]` (fix it and note it) or `[flag]` (surface with a recommendation,
never apply).

**Run the script, don't eyeball it.** Every rule below except `detail creep`'s
judgment half is mechanical, so it's implemented in
`.claude/skills/vault-lint/scripts/hub-check.py`. From the vault root:

```
python3 .claude/skills/vault-lint/scripts/hub-check.py
```

It prints a per-hub report and every violation, and exits non-zero if any exist.
It never edits a file — applying the `[auto]` fixes and judging the `[flag]`s is
still the checker's job. Glob-matching and mtime comparison by hand is exactly
the kind of check a model skips or fakes; the script is what makes this contract
real rather than aspirational.

- [auto] frontmatter present: `name`, `type: hub`, `domain` (non-empty list),
  `updated` (ISO `YYYY-MM-DD`, not in the future).
- [auto] required sections present: `## Snapshot`, `## Recent`, `## People`,
  with those exact headings. A missing heading is added empty with a `[flag]`
  note that it needs filling — never fabricate content to satisfy a check.
- [auto] Snapshot carries an as-of date matching `updated`.
- [flag] **stale hub**: newest mtime across `domain:` globs is more than 3 days
  newer than the hub's `updated`. Recommendation: reconcile on the next
  `reflect`.
- [flag] **unlinked domain note**: a note matching `domain:` that is not
  reachable from the hub **within one hop** — i.e. the hub doesn't link it, and
  no note the hub links to links it either. One hop is deliberate: a hub indexes
  a domain's sub-indexes, and those index their own detail. Two levels is a
  hierarchy; three is the hub trying to be the whole vault. Recommendation: add
  a bullet under the right section, link it from the sub-index that owns it, or
  narrow the glob if it genuinely doesn't belong.
- [flag] **broken hub link**: a `[[wikilink]]` in the hub resolving to no file.
- [flag] **domain overlap**: two hubs whose globs claim the same note.
- [flag] **detail creep**: a hub over ~250 lines, or a section with a
  multi-paragraph block that isn't the Snapshot. Recommendation: push the detail
  into a child note and leave a link.
- [flag] **hub candidate**: a domain with 3+ related notes, activity in the last
  30 days, and no `type: hub` note claiming it. Recommendation: name it as a
  candidate; `reflect` scaffolds it. Never auto-author.
- [flag] **orphan hub**: `domain:` globs match zero files, or the whole domain
  has been quiet 90+ days. Recommendation: archive or retire. Never
  auto-delete.
