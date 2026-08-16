---
name: setup
description: >-
  Build this vault WITH its owner, by interview — ask one question at a time, write what they answer, and author only the skills they'll actually use. Trigger on first run against an empty vault, and any time the owner says "set up my vault", "add a skill for X", "what else should you be doing for me", "I keep doing X manually", or describes a recurring chore they'd rather hand off. This is the cold-start engine and the ongoing one: the vault keeps growing, so this skill stays installed. NOT skill-creator (that WRITES a skill once the shape is decided — this decides what's worth writing), NOT vault-lint (that verifies structure).
---

# setup

The vault ships empty on purpose. A template full of folders someone else needed is
the exact bloat this whole thing refuses. So the vault gets built by conversation,
and nothing exists in it until its owner has said out loud that they want it.

Two modes, same loop:

- **Cold start** — first run. Structure, then pillars, then the first two or three
  skills. Ends with a working agent, not a finished one.
- **Ongoing** — every later run. One chore, one skill, back to work.

## The loop

1. **One question per message.** Short, single-faceted, open-ended. Never stack two.
2. **Write their answer into the vault before asking the next one.** The file is the
   output of the conversation, built incrementally — not a draft they react to at the
   end.
3. **Their words, not yours.** Light cleanup is fine. Never professionalize, never
   pad an empty section with plausible-sounding content to make it look finished.
4. **Stop early.** Three good skills they use beats twelve they don't. When they start
   answering flatly, close it out and offer to continue later.

## Cold start, in order

For steps 1, 2, and 4 the question craft — one-question rhythm, persona contrasts,
the idea bank — lives in the `interview` skill: run those through it rather than
re-deriving the questions here.

**0. The channel.** They're already texting, so one channel works. What's undecided
is whether they want the other one on top, and that answer costs real setup, so it
comes before anything gets written to the vault. Ask it as one question, then act on
whichever case they're in:

- **On Telegram, not on a Mac.** iMessage, FaceTime and Find My are macOS-only. Say
  it once, don't sell it, move to step 1.
- **On Telegram, on a Mac.** Offer iMessage and price it honestly. Tier 0 is
  `brew install steipete/tap/imsg` plus Full Disk Access, and it costs a dedicated
  Apple Account for the agent — no separate phone line, its email is the handle. Tiers 1 and 2 need SIP disabled, which is
  a real reduction in the machine's security posture and belongs only on a machine
  whose whole job is being this agent. `npm run doctor` reports the current tier and
  what the next one needs: walk one tier at a time and prove each one works before
  starting the next.
- **On iMessage.** Offer Telegram as a second channel anyway. It's a bot token and
  nothing else, it has no Apple dependency, and it's the way back in when the Mac
  goes deaf — an OS update breaking the injection, iCloud signing itself out.
  `TRANSPORT` takes a comma-separated list and the agent loop is identical across
  channels, so running both costs nothing and removes a single point of failure.

Never run the Apple setup silently. Every step of it needs their hands on the
machine, so the job here is walking them through it, not doing it.

**1. Who they are.** Enough for the agent to be useful on turn one: name, where they
live, what they're doing with their days right now, who's around them. Goes in the
always-loaded owner file. Keep it short — it's paid for on every single turn, and
detail belongs in linked notes, not here.

**2. How the agent should act.** Voice, formality, how blunt, when to shut up. This
becomes the soul file and it's the highest-leverage thing in the whole setup. Ask for
examples rather than adjectives: "send me a message the way you'd want me to text you"
beats "how casual should I be?"

**3. What their life actually has in it.** The pillar sweep — work, school, health,
money, people, projects, whatever they're building. Each pillar they claim gets a
folder and a hub note; each one they don't is never created. An empty folder is a
promise the vault can't keep.

**4. Skills — extract before you suggest.** This is the part that decides whether the
agent is theirs or generic:

> *"What do you find yourself doing over and over that you'd rather just hand off?"*

Sit in that question. Their own answer, however mundane, is worth more than anything
on the menu, because a skill built from their real chore gets used and a suggested one
usually doesn't.

**Only when they're blank** — and people usually are, because nobody has a mental model
of what an agent can do — open the `interview` skill's idea bank
(`.claude/skills/interview/references/idea-bank.md`) and offer **three**
archetypes, chosen for what they've already told you. Not a list of twenty. Three, each
in one plain sentence, each with the question that would confirm it. The bank also runs
in the background the whole time: when they describe a chore, match it against the
archetypes so it gets built in a shape that's already been proven to work.

Then hand each confirmed one to `skill-creator`, and **use it in the same session** —
a skill that hasn't fired once is a guess.

**5. Close.** Tell them what exists now, what's deliberately empty, and that the way to
grow it is to say "I keep doing X manually" whenever they notice it.

## Rules

- **Never install a skill they didn't ask for.** Not even a small one. The whole claim
  of this project is that an unused capability doesn't exist in context — one helpful
  default breaks it.
- **Never ask two questions in one message**, including a question with "and also".
- **Suggest three, never a menu.** A wall of options gets answered "all of them",
  which is the same as none.
- **The failure mode is a beautiful empty vault.** Structure they didn't ask for is
  worse than missing structure. When in doubt, don't create it.
- **Deletion is part of setup.** If they mention a skill they never use, offer to
  delete it. It's git; nothing is lost.
