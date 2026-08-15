---
name: reflect
description: >-
  Daily memory-write pass - reads the day's transcript and saves only TRULY durable, important long-term memories to the vault, filing each at the right temperature per Memory.md. The "scribe" to dream's "janitor": reflect captures + promotes, dream cleans + prunes. Runs on a daily schedule (end of day) or on demand when the owner says "run reflect", "save memories", "what'd you learn today", "update your memory", or "remember today".
schedule: daily 22:00
requiredTools: []
runPrompt: |
  Run your reflect pass — read today's transcript and actually SAVE the truly
  durable, important memories to the vault, each filed at the right temperature per Memory.md.
  Write the files; don't just describe what you'd save. Stay quiet unless something's worth
  flagging.
internal: true
---

# reflect (daily memory scribe)

At day's end, reflect reads what actually happened and decides what's worth
keeping forever. It is the engine that finally runs `Memory.md`'s promotion
rules — the law for where memory goes already exists, reflect is the habit that
executes it.

The whole job in one line: **capture the few durable things, file them right,
and save almost nothing.** A bloated memory is worse than a sparse one — a
wrong or stale "fact" makes the agent confidently wrong, while a missing detail
just gets re-learned. So the default is DON'T save.

This is a WRITE/capture skill only. It does not clean, dedup, prune, or
consolidate existing notes — that's `dream`'s job (the janitor). reflect
writes; dream tidies. Never do cleanup here, never let dream do capture there.
Clean division of labor.

Two sources of truth it obeys:
- `Memory.md` — the law for memory tiers (hot/warm/cold) and the filing +
  promotion rules. reflect does not invent its own routing logic; it runs
  Memory.md's.
- `README.md` — the routing table for which folder a given kind of note lives
  in.

## the bar (a candidate must clear BOTH tests to be written)

Bias hard toward skipping. Before writing anything, run it through both gates:

1. **Durable** — will this still be true or relevant in a month? Standing
   facts, stable preferences, life/relationship changes, recurring patterns =
   yes. Today's mood, a one-off meal, passing chatter, anything time-boxed =
   no.
2. **Load-bearing** — would NOT having it make the owner repeat themselves, or
   make the agent get something wrong later? If the agent would do fine without
   it, skip it.

Fails either gate → do not write. When genuinely torn, don't save — it'll
resurface in `System/Conversations/` if it matters, and a future reflect can
promote it once it actually recurs. Most days should produce 0-2 saved
memories. Zero is a valid, common, correct result.

What clears the bar (examples): "the owner switched gyms" (durable +
load-bearing), a sibling's name (person fact), "they prefer X over Y and
corrected me on it" (preference/feedback), "started a new project that keeps
coming up." What does NOT: what they ate today, that they were tired, passing
chatter about the weather — all ephemeral, already in the log.

## the workflow (run every step, in order)

### 1. Pull the day's raw material
- Get today's date: `date +%F`.
- Read today's `System/Conversations/YYYY-MM/YYYY-MM-DD*.md` (monthly folder)
  — the full transcript, both directions. This is the primary input.
- Optionally skim today's `System/reflect/YYYY-MM/YYYY-MM-DD.md` if it exists,
  for anything the log doesn't capture.

### 2. Extract candidates
- Pull out the handful of things that might be durable memory: facts about the
  owner, people, preferences, projects, life/state changes, corrections they
  gave the agent.
- Ignore everything that's clearly ephemeral or already lives somewhere
  structured (a Pending loop already filed, a note already written).

### 3. Gate each candidate
- Run BOTH tests from "the bar" above. Drop anything that fails either. Be
  strict.

### 4. Dedup BEFORE writing (mandatory)
- For each survivor, READ the note it would go into FIRST (the
  `People/<name>.md`, the topic note, the relevant `Owner.md` section). Never
  write blind.
- If the fact is already there → skip it, no duplicate.
- If a softer version is there and it's now stronger/always-true →
  promote/update in place rather than adding a second line.
- Only genuinely new information gets written.

### 5. File at the right temperature (per Memory.md)
Route each survivor:
- Identity-level, basically-always-true fact → `Owner.md` (keep it SHORT; push
  detail down into a warm note and link if it's more than a line).
- A person → `People/<name>.md` (create the note if they matter and don't have
  one).
- An ongoing subject/project → its topic note (create one only if it's clearly
  recurring; a one-mention thing does not earn a note).
- A practical reference detail (confirmation/account numbers, prices, dates,
  addresses, terms) → `System/Reference/` or the relevant topic note. Keep it
  where the owner would think to look for it later.
- An open loop / future follow-up → `Pending.md` (one line).
- A correction to how the agent should behave → `System/Feedback/` (and
  `SOUL.md` as a generalized rule if it changes behavior).
- Ephemeral → leave it; it's already in `System/Conversations/`.

**Hub reconciliation (the nightly pull half of the hub update duty).** Some
domains — every big project — have a live index note, a **hub**. The rules live
in `System/Policies/hub-contract.md`; this pass is its backstop. Do NOT
hardcode which hubs exist: `grep -rl "^type: hub"` and work the list you find.

For each hub, compare its `updated` against the newest mtime across its
`domain:` globs. Domain moved, hub didn't → reconcile it:
- **Snapshot** — rewrite the line(s) today actually invalidated. Rewrite, don't
  append; bump the as-of date.
- **Recent** — add one dated line per real movement, newest first, pointing at
  the note that holds the detail. Age out the bottom past ~15 lines.
- **People** — anyone new in the domain gets a `[[wikilink]]` bullet.
- **Links** — any note matching `domain:` that nothing in the hub links to gets
  a bullet under the right section.
- Bump `updated` to today.

No movement in a hub's domain = leave it completely untouched. Keep the hub an
INDEX: point at the note that holds the detail, never copy the detail up.

**Hub creation.** If `vault-lint` flagged a hub candidate (3+ related notes,
active in the last 30 days, no hub), scaffold it here — this pass can actually
read the domain, so it writes a real Snapshot and real links, not an empty
shell. Shape per the contract. One per night at most; if a domain isn't clearly
a big project or a job, leave it as a candidate and say so in the run log.

### 5.5 Retire expired seasonal facts

Execute Memory.md's era rule. Every pass, cheap when nothing's due:
- Sweep the hot files for author-time expiry markers:
  `grep -n "until 20" Owner.md Pending.md` — the convention is
  `(until YYYY-MM-DD)` on the seasonal line or clause.
- For each marker whose date is **today or past**: move anything the owner
  might want later down into the topic note that owns the subject, then trim
  the hot line (delete the bullet, or just the seasonal clause if the rest is
  durable). Log it in the audit entry under `retired:`.
- Marker date not reached yet → leave it completely alone. No markers expired
  is the normal case.

### 6. Run the promotion habit (Memory.md's core)
- If something has been recurring across recent `System/Conversations/` (not
  just today), lift it from the cold log into the right warm note. Test
  "recurring" with the conversation-recall tool — it searches the whole log by
  meaning, so it can see a pattern today's file can't. Don't grep the folder;
  that's blocked.
- If a warm fact has become always-true, promote it up to `Owner.md` and trim
  the warm copy to a pointer so it isn't duplicated.
- Keep `Owner.md` lean — promotion means moving up, not copying.

### 7. Log the run + report
- Append an audit entry to `System/reflect/YYYY-MM/YYYY-MM-DD.md` (monthly
  folder — `mkdir -p` it) listing exactly what was written and where, so the
  owner can review/undo.
- Scheduled run: that's it — write the audit and stay quiet. Do NOT text the
  owner a nightly "saved X" / "nothing saved" summary; that's noise. Never
  invent saves.
- On-demand run ("run reflect", "what'd you learn today"): send a short summary
  in normal voice — what got saved and where, or plainly "nothing worth saving
  today" if it came up empty.

## audit log template

Append to today's `System/reflect/YYYY-MM/YYYY-MM-DD.md`:

```
## reflect (YYYY-MM-DD)
saved:
- People/<name>.md - <the fact>
- Owner.md - <the fact>
promoted:
- moved <recurring fact> from the log -> <warm note>
skipped: nothing else cleared the bar
```

If nothing was written, still log it:

```
## reflect (YYYY-MM-DD)
nothing cleared the bar today - no writes.
```

## scope boundary (important)

reflect ONLY captures and promotes. It does NOT delete, merge, prune stale
items, fix filenames, or consolidate scattered notes — if you notice that kind
of mess while reading, leave it for `dream` (mention it as a one-line aside at
most, don't act). And it does not change skills or the agent's
identity/personality — it records facts about the owner, it doesn't evolve
capabilities. Stay in your lane: write the few durable memories, file them
right, report, done.
