<p align="center">
  <img src="assets/fig-mark.png" width="110" alt="fig">
</p>

<h1 align="center">fig</h1>

**Give your agent its own Mac.** fig is a personal agent that runs as an
always-on daemon on a Mac of its own, with its own Apple ID and its own phone
number, signed into your accounts, holding your context, on the same machine
tomorrow. It can do anything you can do on a computer, and you reach it the way
you reach a person: a text thread and a phone call. It runs on the Claude Agent
SDK or on OpenAI's Codex, swappable live with `/model`, riding your existing
subscription either way. Its memory is a folder of plain markdown you own.

Most agents are a model with a browser in a sandbox. This one has the hands that
setup usually leaves out, packaged together:

| Lane | What it does |
| --- | --- |
| <img src="assets/icons/messages.png" width="36" align="middle"> **iMessage** | Lives in a real text thread. Tapbacks, effects, typing indicators, read receipts, link cards, audio messages. No web UI, no app. |
| <img src="assets/icons/facetime.png" width="36" align="middle"> **FaceTime** | Calls you and talks, with the voice session pre-warmed so it's already speaking when you pick up. Hard-locked to dialing only you. |
| <img src="assets/icons/findmy.png" width="36" align="middle"> **Find My** | Live location feeding its context. Where you are shapes what it says, and geofences fire real actions. |

A persistent machine with a persistent identity is what makes the rest work:
schedules that fire at 6am, watches that poll for weeks, background jobs that
run while you sleep, a browser holding your logins.

## Architecture

```
iMessage ──→ transport ──→ daemon (src/index.ts)
                             ├─ Agent SDK query() with session resume    (src/session/)
                             ├─ tiered approve-over-iMessage permissions (src/runtimes/permissions.ts)
                             ├─ tuned chunking + human cadence           (src/render/chunking.ts)
                             └─ MCP servers from the vault's mcp.json    (src/runtimes/mcp.ts)
                                        │
                             ../brain  (its memory: an Obsidian-compatible
                                        vault, its own git repo)
```

A personal agent is four things. A harness, a memory, the skills and tools you
actually use, and a surface you actually live in. This repo is those four things
and nothing else.

### The harness (`src/`)

Pure TypeScript, one daemon, entry point `src/index.ts`:

- **Sessions** (`src/session/`): one long-lived streaming session with resume,
  context-budget rollover, and compaction, so a busy day doesn't grow unbounded
  and a restart doesn't lose the thread.
- **Permissions** (`src/runtimes/permissions.ts`): enforced in `canUseTool`,
  in code rather than in the prompt. Three tiers: auto-allow for ordinary work
  (reads, writes, shell); approve-over-iMessage for sensitive outward actions,
  which arrives as a 🔐 question you 👍 or 👎 and denies on timeout (sending
  email, spending money, destructive calendar and mail actions); and a hard
  denylist no approval can override (`sudo`, keychain dumps,
  curl-pipe-to-shell). The permission code itself is write-denied to the agent,
  so changing the safety boundary stays a by-hand job.
- **Scheduling** (`src/scheduling/`): scheduled tasks, reminders, and watches,
  so "remind me" and "check this every morning" are armed mechanisms instead of
  promises.
- **Background jobs** (`src/specialists/`): delegated coding and browsing
  agents run on a job board and owe a report when they finish. Codex ships as a
  second delegate for independent review (`CODEX_ENABLED`, `CODEX_MODEL`).
- **Transport** (`src/transport/`): the daemon talks to a `Transport`
  interface, never to a channel. iMessage is the one this was built for: it
  watches chat.db for inbound, sends through Messages, and keeps an APNS
  keepalive so a headless Mac doesn't go deaf. Telegram is a full second channel
  with no Apple dependency at all, and reactions, typing, photos, files and
  audio map onto the same primitives. `TRANSPORT` is a comma-separated list, and
  the agent loop is identical across all of them.

### The memory (the vault)

The agent's working directory is a sibling folder of markdown, its "brain",
instantiated from `vault-template/` in this repo and kept as its **own git repo
on your own private remote** (`BRAIN_DIR`, default `../brain`). It is never part
of this repo's tree. It's your life; this is the machine.

The vault is contractual, not a pile of notes:

- `CLAUDE.md` is the always-loaded contract: who the owner is, plus pointers to
  everything else. Deliberately tiny, because it's paid for on every turn.
- `SOUL.md` is the agent's voice and judgment, plain markdown appended to the
  system prompt and re-read from disk so edits apply live. The persona half
  ships **blank** and gets filled from your answers. The judgment half ships
  written: rules about how an agent behaves when it's wrong, uncertain, or
  debugging. Anything mechanical about the harness itself lives in code, where a
  persona rewrite can't break it.
- Folder contracts (`System/Reference/SCHEMA.md`,
  `System/Policies/hub-contract.md`) come with a verifier. The `vault-lint`
  skill proves each folder is in spec against its own written contract.
- On top of the files sits a semantic recall index (`src/memory/`): sqlite plus
  in-process ONNX embeddings over the vault and the full conversation log. No
  embedding service, and nothing leaves the machine.

The vault's `mcp.json` declares external MCP servers in the same format as
Claude Code, with `${VAR}` substitution; servers with unfilled placeholders are
skipped. Internal tool servers are injected in code (`src/runtimes/mcp.ts`).

### The skills and tools you actually use

**Skills live in your vault, not in this repo.** A capability you never set up
doesn't sit in a plugins folder waiting. It literally does not exist in context.
The template ships only the skills that operate the agent itself: `setup`,
`interview`, `skill-creator`, `vault-lint`, `self-edit`, `reflect`, `dream`.

The cold-start problem, "I don't know what an agent could even do for me," is
answered by conversation rather than a library of examples. The `interview`
skill fills `Owner.md` and the persona half of `SOUL.md` one question at a time,
then surfaces the recurring loops in your life that deserve skills, drawing on
an idea bank of proven archetypes when you're blank. Each skill it confirms gets
built by `skill-creator` and used in the same session.

Personal tools follow the same rule structurally. `src/tools/registry.ts`
auto-discovers `src/tools/personal/` at runtime, and a checkout without that
directory loads clean. Your one-off integrations go there, gitignored, and never
become anyone else's context or build dependency.

## Capability tiers

Richness is bought in explicit steps. Each lane detects its own dependencies at
runtime and fails loud, so a fresh install simply runs at whatever tier the
machine is set up for. `npm run doctor` reports your current tier and what the
next one needs.

| Tier | What works | What it takes |
| --- | --- | --- |
| — | everything but the three Apple lanes, over **Telegram** | a bot token from @BotFather. No Apple Account, no Full Disk Access, no SIP change. |
| 0 | plain iMessage send/receive | `brew install steipete/tap/imsg` + Full Disk Access. No SIP change. |
| 1 | rich iMessage (tapbacks, effects, typing, read receipts) | SIP disabled + the bridge dylib injected into Messages |
| 2 | live Find My location feeding context and geofences | the find-my dylib (`tools/findmy/build.sh` compiles it), riding tier 1's injection, with `FINDMY_DYLIB` pointing at the built file |
| 3 | FaceTime audio calls | the Swift call tools (`tools/call/build.sh` compiles them) + a BlackHole audio driver carrying the AEC-bypass patch |

Be clear-eyed about tiers 1 and 2: they require **disabling System Integrity
Protection**, because that's what injecting a dylib into Messages.app costs.
That is a real reduction in the machine's security posture, not a formality. Do
it only on a dedicated Mac whose job is being this agent, never on the machine
you work on. Tier 0 and tier 3 don't touch SIP.

## Requirements

This is a project you run, not a hosted product. To run it at all you need:

- **A machine that stays on.** The daemon is local; there is no cloud half.
- **A Claude subscription (or ChatGPT, for Codex).** The main agent runs on the
  Claude Agent SDK, authenticated with a Claude Code OAuth token
  (`claude setup-token`), or on OpenAI's Codex CLI, switchable at runtime with
  `/model`. Either way messages ride your plan instead of a metered API key.
- **A channel.** Either a Telegram bot token, which costs nothing and takes two
  minutes, or the iMessage setup below.

The iMessage, FaceTime and Find My lanes additionally need **a Mac** and **a
dedicated Apple Account for the agent**, so it sends and receives as itself
rather than as you. That account does **not** need a phone line of its own:
iMessage registers its email address as a handle, and a number you already own
can be its two-factor trusted number, since Apple allows one number across
multiple accounts. A separate line only buys SMS, which none of these lanes use.
This is the version the project was built for, and it's a real afternoon of
setup. It is not the version you should start with.

## Getting started

Start on Telegram. It's the same agent, the same vault, the same loop, and it
runs in about five minutes:

```bash
git clone <repo> && cd fig
npm install
cp -R vault-template ../brain && git -C ../brain init
cp .env.example .env
# in .env: OWNER_NAME, your Claude token, TRANSPORT=telegram,
#          and TELEGRAM_BOT_TOKEN from @BotFather
npm start                   # text the bot once, then paste the chat id it logs
                            # into TELEGRAM_OWNER_CHAT_ID and restart
```

Then text it. The `interview` skill fills the empty vault from a conversation:
who you are, how it should talk, and the first two or three skills worth having.
The vault ships empty on purpose. It gets built with you, not for you.

Move to iMessage when you want the Apple lanes. `npm run doctor` reports what
tier the machine is at and what the next one needs, the `setup` skill walks it
tier by tier, and adding `imsg` to `TRANSPORT` is the only code-side change.

`npm test` and `npm run typecheck` are the repo's own bar.

## What this is not

- **Not a hosted service.** There's no server to sign into and nobody in the
  loop but you.
- **Not multi-user.** One owner, one agent, one vault.
- **Not a plugin marketplace.** There is no catalog of community skills to
  install, and that's load-bearing: everything in your agent's context is
  something you put there.

It wasn't built on the big agent frameworks because starting there would have
meant doing more removing than adding. The design bias throughout is deleting
things. If a capability isn't earning its place in context, the right move is
for it not to exist.
