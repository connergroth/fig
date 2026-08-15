# Memory (canonical)

This is the one source of truth for how the agent remembers its owner. It
defines where things get stored and when. The agent treats it as law: every
durable fact gets filed at the right temperature, and stale facts get promoted
up or pruned.

Goal: never make the owner repeat themselves, and never bloat the always-loaded
context with stuff that isn't always needed.

## The three temperatures

### Hot — loaded every turn, no lookup needed
Keep these SHORT. This is prime context real estate; only what's needed every
single turn belongs here.
- `Owner.md` — the owner's identity. Durable facts that are basically always
  true. Links out to warm notes. Loaded because `CLAUDE.md` imports it.
- `Pending.md` — open loops. One line per item. Add when something needs
  watching; clear it the moment it's resolved.
- `Tasks.md` — the agent's assignment queue (`## Open` only).

### Warm — fetched on demand when relevant
The agent reads/greps these when the topic comes up. Not loaded by default.
- `People/` — one note per person who matters.
- Topic notes as themes emerge (`Projects/`, `Finance/`, `Health/`, …). When a
  subject keeps recurring, it earns its own warm note.
- `System/Feedback/` — corrections the owner has given, kept so they compound.

### Cold — the searchable safety net
- `System/Conversations/` — every message both directions, logged by the
  harness to dated files. Recall of last resort. When the owner references
  something not in hot/warm ("that place i mentioned", "the thing last week"),
  SEARCH IT with the conversation-recall tool before ever saying "i don't
  remember." Never grep this folder — grep returns whole messages, so one
  common word costs tens of thousands of tokens and still misses anything
  worded differently. Reading one specific dated transcript end-to-end is a
  different operation and stays fine.

## The three lists — split by who acts

- `Lists/Todos.md` — the OWNER's work. They do it; the agent surfaces it.
- `Tasks.md` — the AGENT's work. The owner assigns it; the agent executes on
  its own cycles and reports back.
- `Pending.md` — NOBODY's work. Loops the agent passively watches until they
  resolve on their own.

If an item is on the wrong list, move it — the split is what keeps "waiting on
a package" from reading like an assignment.

## Filing rules — when something durable comes up

Decide the temperature and file it:
- Identity-level fact (always true) → `Owner.md`.
- A person → `People/<name>.md`.
- An ongoing subject/project → its topic note (create one if it's recurring).
- An open loop / something to follow up → `Pending.md`.
- A correction to how the agent behaves → `System/Feedback/` (and `SOUL.md` if
  it changes behavior).
- Ephemeral chatter → leave it; it's already in `System/Conversations/`,
  searchable.

File by judgment. Don't ask "where should this go?" — just file it; the owner
corrects occasionally.

## Hubs — the index layer

Any big project the owner is actively putting real time into gets a **hub**: one
live index note (`type: hub` in frontmatter) carrying the domain's current
state, recent changes, and its people as `[[wikilinks]]` — the note the agent
opens first when that area comes up. The rules — what earns a hub, the required
shape, who keeps it fresh — are one file: `System/Policies/hub-contract.md`.
The one-line version of the update duty: whoever writes inside a hub's domain
updates that hub in the same write.

## Who runs these rules

- The `reflect` skill (daily, end of day) is the SCRIBE: it reads the day's
  transcript and executes the filing + promotion rules — capturing the few
  durable memories and promoting recurring facts up a tier. It only writes.
- The `dream` skill (weekly) is the JANITOR: it cleans, dedups, prunes stale
  loops, and consolidates, calling `vault-lint` for the structural half. It
  only tidies. The two never overlap.
- Filing in the moment is still fair game — when a durable fact obviously comes
  up mid-conversation, file it right then. reflect is the backstop that catches
  what the moment missed.

## Promotion — the habit that makes this work

Memory that never gets promoted rots in the cold log. So:
- When something keeps recurring in `System/Conversations/`, lift it into a
  warm note.
- When a warm fact becomes always-true, promote it up to `Owner.md`.
- Keep `Owner.md` short by pushing detail DOWN into warm notes and linking.
- Prune `Pending.md` aggressively — a stale open loop is worse than none.

## Eras — how seasonal facts retire

Some hot facts are true only for a season (a sublet, an internship, a
semester). Left unmarked, they outlive their season and make the agent
confidently wrong. The fix is author-time, not memory:

- Mark it when you write it: a fact with a known end date gets an inline marker
  on its line — `(until YYYY-MM-DD)` — and the `reflect` pass retires each
  expired fact when the date passes: content the owner might want later moves
  down into the topic note that owns the subject, the hot line gets trimmed or
  deleted.
- A fact whose end date is fuzzy doesn't get a fake date — it stays unmarked
  and retires by judgment.

## Hygiene

- `Owner.md` links to the warm notes so the agent knows they exist.
- Don't duplicate the same fact across tiers; store it once at the right
  temperature and link if needed.
- This file is the law. To change how memory works, change it here.
