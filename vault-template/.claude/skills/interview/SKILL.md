---
name: interview
description: >-
  Get to know the owner by conversation and turn the answers into the vault:
  fill `Owner.md` and `SOUL.md`'s empty persona sections one question at a
  time, then surface the recurring loops in their life that deserve skills.
  Trigger on a fresh vault (empty sections in either file), when the owner says
  "interview me", "get to know me", "ask me about myself", "what should I tell
  you", "what skills should I have" — and scoped, any time later: "interview me
  again about health", "let's do the money section", "ask me about work". NOT
  skill-creator (that BUILDS a skill once a loop is confirmed — this finds the
  loops and hands them off), NOT setup (that owns vault structure — folders,
  pillars, hubs; this owns the conversation that fills the people-shaped
  files).
---

# interview (the cold-start conversation)

The vault ships empty and there is no library of example skills to browse —
deliberately, because a capability the owner never claimed shouldn't exist in
context. The cost of that choice is a cold start: a new owner faces empty files
with no model of what an agent could even do for them. This skill is the
answer. It carries the questions and the examples, so the vault gets filled
from a conversation — their life, their words — instead of from someone else's
defaults. Two halves, run in order: fill the empty files, then find the skills.

## how to ask (rules for every question in the run)

- **One question per message.** Message-length, conversational. Never a form,
  never ten questions in one bubble, never a question with "and also".
- **Patch as you go.** Write each answer into its file BEFORE asking the next
  question. The file is the output of the conversation, not a draft assembled
  at the end — if the run dies mid-way, everything answered so far is saved.
- **Their words, light cleanup.** Never professionalize, never pad a thin
  answer into something that looks finished.
- **Persona questions offer concrete contrasts, not open prompts.** "Dry and
  terse, or warm and chatty?" — "lowercase like a text, or proper sentences?"
  — "pushback when you're wrong, or agreement unless you ask?" beats "describe
  your ideal assistant", which nobody has an answer to. Options give them
  something to react against; reacting is easy, describing is hard.
- **A "skip" is an answer.** Leave the section empty and move on. Don't nag,
  don't circle back this run, don't fill the gap with plausible content.
- **Read the room.** When answers go flat or one-word, close out (see "the
  close") and offer to continue later. A half-done interview that resumes
  beats a complete one they resented.

## where progress lives (resume, never re-ask)

There is no state file. The vault files themselves are the progress: an empty
section is an unasked question, a filled one is settled. So every run starts
the same way —

1. Read `Owner.md` and `SOUL.md`'s persona sections (identity through
   formatting — never the judgment half).
2. Whatever's filled is done. Never re-ask it; at most confirm in passing if
   it looks stale ("still at the same job?").
3. Whatever's empty is the queue. On a fresh vault that's everything; later
   it's whatever got skipped.

Scoped runs work the same: "interview me again about health" means read what's
already there about health, then ask only in that lane — update and append,
don't restart. The skill runs early in an owner's life, but it never stops
being useful.

## half one — fill the files

### Owner.md — who they are

Work section by section, roughly in order. One or two questions each; the HTML
comment in each section says what belongs there. Keep entries SHORT — this
file loads on every turn, and detail belongs down in topic notes with a link.

- **Basics** — name and what they go by, where they live, the one-paragraph
  picture of life right now. *"Where are you, and what does a normal week look
  like?"*
- **Work / school** — what they do, where, what they're working toward.
- **Projects** — what they're building or into outside the day job.
- **Money** — only what a task would need: banks/cards in play, budgeting
  posture. Don't pry; this is the section most likely to earn a "skip", and
  that's fine.
- **People** — the handful of names that will come up constantly: partner,
  family, closest friends, boss. One line each on who they are to the owner.
- **Routines** — wake/sleep, gym, recurring commitments, when not to ping.

Write in third person about the owner — the agent is the narrator of its own
memory. Example patch, mid-conversation:

```
## People

- [[People/Sam.md|Sam]] — younger brother, in college, they talk most days
- [[People/Priya.md|Priya]] — manager at work, weekly 1:1 on Tuesdays
```

### SOUL.md — how the agent should act

Go section by section through the persona half (identity, voice, rhythm,
instincts, spine, banter, serious mode, formatting). Each section's italic
placeholder IS the question — turn it into a contrast the owner can react to:

- **voice** — the single best move: *"text me a message the way you'd want me
  to text you."* One real example beats any number of adjectives. Then the
  contrasts: lowercase or proper? long or clipped? swearing okay?
- **rhythm** — *"when you say 'thanks', do you want a reply at all?"*
- **spine** — *"if you're about to make a call I think is wrong — say it once,
  argue until you overrule me, or stay out of it?"*
- **banter** — *"am I allowed to roast you? what's off the table?"*
- **serious mode** — *"when you're actually stressed, do you want solutions or
  just an ear first?"*

Replace the italic placeholder with what lands, written as instructions to the
agent. Example:

```
## voice

Lowercase, clipped, like a text from a friend. Swearing fine. Never opens with
"Great question" or any assistant filler.
```

Only the persona half. The judgment half below the divider ships filled and is
not this skill's to touch.

## half two — find the skills

### probe before you suggest

Their own loop, however mundane, beats anything on a menu — a skill built from
a real chore gets used; a suggested one usually doesn't. So probe their actual
life first:

- *"What do you track — or what did you give up tracking because the app was
  too annoying?"*
- *"What do you always forget?"*
- *"What do you text or note to yourself?"*
- *"What's annoying every single week?"*
- *"What are the first apps you check in the morning?"*
- *"What did you do three times this month by hand?"*

One at a time, not the whole battery — two or three probes is usually enough.
When an answer contains a loop, reflect it back as a candidate in one line:
*"so every Sunday you re-plan the week from four different apps — want a skill
that does that sweep and hands you the plan?"* A candidate only becomes
confirmed when they say yes to a concrete sentence like that.

### when they're dry: the idea bank

Most people are dry — nobody has a mental model of what an agent can do. That
is what `references/idea-bank.md` is for: anonymous archetypes distilled from
skills that proved themselves in real daily use, grouped by area (daily
rhythm, inbox and people, work, learning, body, money, capture, thinking,
output, automation). When probing stalls, open it and offer **three**
archetypes from the group nearest whatever they just told you — each in one
plain sentence, each with the question that would confirm it. Never the whole
list; a wall of options gets answered "all of them", which is the same as
none.

The bank also runs in the background of the whole conversation: when the owner
describes a chore, match it against the archetypes so the eventual skill gets
built in a shape that's already been proven to work.

### hand off, never build

This skill does not author skills. Each confirmed loop goes to
`skill-creator`, which owns the shape, the trigger, and the writing — hand it
the loop in the owner's own words plus whichever archetype it matched. Two or
three confirmed loops is a great first session; stop suggesting once they have
that many, even if the well isn't dry.

## the close (how every run ends)

Stop when the queued sections are filled and the loops are confirmed, when
answers go flat, or when the owner says later. Then send one closing message:

- what got written where — which `Owner.md` sections are live, which persona
  sections now have a real voice behind them
- which loops got confirmed and are headed to `skill-creator`
- what's deliberately still empty, and that it stays empty until they say
  otherwise
- how to continue: "interview me again about X" any time, and "I keep doing X
  manually" is the standing trigger for a new skill

No separate report file, no state to clean up — the vault is the record.

## what this skill reads and writes

- reads: `Owner.md`, `SOUL.md` (to find what's empty),
  `references/idea-bank.md` (the archetype bank — loaded only in half two)
- writes: `Owner.md` sections, `SOUL.md` persona sections. Nothing else.

## rules

- **Never touch SOUL.md's judgment half.** Persona sections only.
- **Never install a skill they didn't claim.** Suggest three, from the bank,
  only after probing — and a suggestion declined is never re-pitched.
- **Never re-ask a filled section.** The files are the memory of the interview.
- **Don't marathon it.** Resumability is the design — a 10-minute session that
  ends warm and picks up tomorrow beats an hour that empties the well.
