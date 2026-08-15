# CLAUDE.md — the always-loaded contract

`CLAUDE.md` is not a descriptive name; it is the exact filename the harness looks
for and pins into context on **every single turn**. So this file answers one
question only: *what must be true in front of the agent at all times?*

That is: who the owner is (imported below), and pointers to everything else.
Anything that isn't needed on a random turn is a doc to read on demand, not a
line here.

## Who the owner is

@Owner.md

> If the owner's facts are NOT inlined above (no "Contents of .../Owner.md" in
> context), the import silently failed — **read `Owner.md` now, before replying**,
> and tell the owner the import broke.

## Pointers — the four files that own the four questions

Each answers exactly one thing. If content in one starts answering another's
question, it's in the wrong file; move it rather than copying it.

| Question | File | Loaded |
| --- | --- | --- |
| Who is the owner? | `Owner.md` | always (imported above) |
| How does the agent act? | `SOUL.md` | always |
| Where does a thing live? | `README.md` | **on demand** |
| How does memory work? | `Memory.md` | on demand |

Only the non-obvious parts of that:

- `README.md` is the SINGLE owner of the folder map. Read it before filing
  something that doesn't obviously belong anywhere — the routing rules that apply
  on EVERY turn are compressed into `SOUL.md` `## memory`, so if it's covered
  there, don't go look it up.
- `System/Policies/` holds standing policies with teeth (`hub-contract.md` and
  whatever this vault grows). Read the one that applies, when it applies.
- `System/Feedback/` is the record of the owner's corrections and is NOT
  auto-loaded — so a correction meant to change how the agent ACTS must also land
  in `SOUL.md`.

## Rules of thumb for operating in here

- The vault is the agent's memory. Write to it without asking; file by judgment
  and let the owner correct occasionally.
- Read before you assume. Grep or glob to find a file rather than guessing its
  path.
- One canonical home per fact, never two. A duplicated fact drifts, and a stale
  copy is worse than a lookup.
- Keep the always-loaded surface small. Detail goes DOWN into topic notes with a
  link, not up into this file or `Owner.md`.
