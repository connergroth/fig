# Installing fig — the runbook for the agent doing it

You are an agent in a fresh clone and the human wants this running on their machine.
That is a different job from the rest of `CLAUDE.md`, which assumes an installed
instance and an owner who already has one. While you are installing:

- **`.env` is yours to write.** The off-limits rule protecting it exists so a delegate
  can't silently reconfigure a live instance. There is no live instance yet.
- **Never invent an owner.** `OWNER_NAME`, the phone number, the channel — every one of
  those comes from them out loud, not from a guess or from anything you find on the
  machine.
- **You do not do the macOS half.** Full Disk Access, SIP, the Apple ID: those need
  their hands and their password. You explain and wait.

## The order it has to happen in

The channel is first and it is not a preference question — it decides how much setup
the next hour holds.

**Default to Telegram, and say why in one sentence:** it's a bot token, it works on any
machine, and it gets them to a working agent in minutes. iMessage is what this project
is for, but it costs a Mac, a dedicated Apple ID, a dedicated phone number, and for the
rich lanes, disabling SIP. Offer it as the thing to add once the agent is real to them,
not as the price of trying it.

If they say iMessage up front, that's fine — walk `npm run doctor` tier by tier. Just
don't let them think it's required.

## Steps

```bash
npm install
cp -R vault-template ../brain && git -C ../brain init
cp .env.example .env
```

The vault is a **separate git repo on their own private remote**, and it is their life,
not part of this tree. Initialize it, don't add a remote for them, and never commit
vault changes from this repo.

Then fill `.env` with them:

- `OWNER_NAME` — what the agent calls them.
- **Model auth.** A Claude Code OAuth token from `claude setup-token`, or the Codex CLI
  if they're on ChatGPT. Either rides their existing plan; neither is a metered API key.
- `TRANSPORT` — `telegram`, `imsg`, or both comma-separated.
- **Telegram**, if that's the channel: `TELEGRAM_BOT_TOKEN` from @BotFather. The chat id
  is two-phase and it confuses people, so front-run it: start the daemon, have them text
  the bot once, take the chat id it logs into `TELEGRAM_OWNER_CHAT_ID`, restart.
- **iMessage**, if that's the channel: `OWNER_NUMBERS`, plus `brew install
  steipete/tap/imsg` and Full Disk Access granted by hand in System Settings.

`npm run doctor` reports where the machine stands. On a Telegram-only install the Apple
tiers all read ✗ and that is the correct, healthy result — say so before they see it and
think it's broken.

Then `npm start` and have them text it.

## Where your job ends

The moment it answers a text, stop installing. The vault is still empty on purpose, and
it gets filled by conversation with the agent itself, not by you writing files into it
from out here.

Hand off in one line: tell them to text it **"set up my vault"**. That runs fig's own
`setup` skill, which interviews them into an owner file and a voice, builds the first
two or three skills from chores they actually have, and — if they started on Telegram —
is where adding iMessage later gets walked.

Anything you write into that vault yourself is content they didn't ask for, which is the
one thing this project refuses.
