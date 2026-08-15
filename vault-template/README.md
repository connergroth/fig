# Vault index

The map of this vault — what every folder and root file is for, and where a new
thing should go. When in doubt about where something lives, this is the answer.
This file is the SINGLE owner of that map; there is deliberately no second copy
anywhere. Keep it current: when a folder or standing file is added, add its line
here, and that's the whole edit.

Folders are created when the owner's life claims them, not before — an empty
folder is a promise the vault can't keep. The lines below are the standard homes
so a new thing files consistently; a folder that doesn't exist yet gets created
the first time something belongs in it.

## Writing convention (POV)

- **Knowledge ABOUT the owner** (Owner.md, People/, Pending.md, Projects/,
  Finance/…) → third person about the owner. The agent is the narrator of its
  own memory.
- **Instructions TO the agent** (`.claude/skills/`, `System/Policies/`,
  `SOUL.md`, `Memory.md`, this README) → second person to the agent.
- **The owner's own living lists** (`Lists/`) → imperative task lines are fine.

## Root files (loaded every turn or read by the harness at a fixed path)

- `CLAUDE.md` — the always-loaded contract, and ONLY that: it imports `Owner.md`
  and points at the files that own everything else. Keep it tiny.
- `Owner.md` — who the owner is, and ONLY that. Durable facts, always loaded.
  If a line is a rule, it belongs in `SOUL.md`.
- `SOUL.md` — the agent's voice AND its standing behavior rules. Loaded every
  turn.
- `Pending.md` — the agent's PASSIVE open-loop tracker: things it's watching,
  nothing to do. Open section loaded every turn. NOT the owner's todo list.
- `Tasks.md` — the agent's assignment queue: jobs the owner hands it to go DO,
  then move to `## Done` and report back. Open section loaded every turn.
  The three lists: the owner does it → `Lists/Todos.md`; the owner assigns it →
  `Tasks.md`; just watch → `Pending.md`.
- `Memory.md` — canonical law for how memory works. Read it when deciding where
  something gets stored.
- `README.md` — this index.

## Folders

- `.claude/skills/` — skills, one folder + SKILL.md each. New skills go here
  via `skill-creator`.
- `People/` — one note per person who matters: who they are, last talked,
  birthday, what they mentioned. Person notes only — an event goes in a dated
  note in its own domain, not here.
- `Projects/` — working docs for the owner's builds and ideas, one folder per
  project, each big one with a hub note (`System/Policies/hub-contract.md`).
- `Work/` (or `Career/`) — the job/school domain: role docs, brag-doc,
  applications, whatever the owner's work life generates.
- `Finance/` — the financial picture: overview, cards/accounts, anything money
  that outgrows `Owner.md`'s one-liners.
- `Health/` — everything about the owner's body: logs, routines, stats.
- `Travel/` — trips and one-off plans. A real trip gets a folder
  (`Travel/<YYYY-MM-slug>/`); a one-off local plan is a single flat note
  (`Travel/YYYY-MM-DD-<slug>.md`).
- `Lists/` — the owner's living lists. Ships with `Todos.md`; add others
  (shopping, reading…) as the owner's life asks for them.
- `Wiki/` (optional) — a durable, compounding knowledge base for world
  knowledge worth keeping months out. Only create it if the owner wants one.

### System/ (the machine layer — how the agent works, not what the owner's life is)

- `System/Policies/` — standing policies with teeth. Ships with
  `hub-contract.md`; grows as rules earn a file.
- `System/Reference/` — the durable lookup layer: operating manuals and fact
  cards. Contract: `System/Reference/SCHEMA.md`.
- `System/Feedback/` — the record of the owner's corrections, so they compound.
- `System/Conversations/` — the full message log, both directions, written by
  the harness (`YYYY-MM/YYYY-MM-DD.md`). The agent's recall of last resort —
  search it with the recall tool, never grep. Gitignored: it's the owner's raw
  life, not something to sync to a remote by default.
- `System/reflect/` — the agent's own dated work log (`YYYY-MM/YYYY-MM-DD.md`):
  what it saved, changed, and learned each day. Machine-written, read by
  search, not browsed.
- `System/Reviews/` — dated review records (weekly reviews and the like), if
  the owner wants them.

## Where does a new thing go? (quick routing)

- Something the OWNER needs to do → `Lists/Todos.md`
- A job the owner ASSIGNS the agent → `Tasks.md`
- A loop to passively watch, no work to do → `Pending.md`
- A person fact → `People/<name>.md`
- An identity-level, always-true fact → `Owner.md`
- A correction to the agent → `System/Feedback/` (and `SOUL.md` if it changes
  behavior)
- Durable how-it-works knowledge or a standing fact card → `System/Reference/`
- A trip → `Travel/<trip>/`; a one-off plan → flat `Travel/` note
- A recurring action worth standardizing → a skill (`skill-creator`)
