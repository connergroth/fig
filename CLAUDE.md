# CLAUDE.md — conventions for agents working in this repo

`CLAUDE.md` is the exact filename Claude looks for; `AGENTS.md` is the same file
symlinked for Codex. Both engines therefore read THIS document, and it is loaded on
every run in this repo — so it holds only what is true on any random task.

It does NOT hold the workflow (orient → change → test → green → commit → report).
That ships in the delegation prompt itself (`delegateWorkflow()` in
`src/specialists/delegate.ts`) so it reaches both engines in every repo. This file is
the repo-specific half: the commands, the house style, and what's off-limits here.

## What this repo is

fig — the owner's personal iMessage-native agent, built on the Claude Agent SDK, running
as a daemon on a Mac at home. Entry point `src/index.ts`. Its memory is the sibling
Obsidian vault at `../brain`, which is a SEPARATE git repo — never commit vault
changes from here.

Read `context.md` before arguing about design: it's the glossary (turn, session,
transport, lane, child, hold) and it exists so a discussion is about the real decision
rather than the terms. `README.md` is the map of where things live. `docs/` covers
individual subsystems.

**If the human is installing this rather than working on the code** — fresh clone, no
`.env`, no vault, nothing running — that's a different job with different rules. Read
`docs/install.md` and drive that rather than inferring steps from `README.md`. The rest
of this file assumes an installed instance with an owner who already has one, and the
off-limits rules below are written to protect a live setup; `docs/install.md` says which
of them don't apply during an install.

## Commands

```
npm test              # node:test over src/**/*.test.ts + scripts/**/*.test.ts
npm run typecheck     # tsc --noEmit  (src)
npm run typecheck:all # src + scripts — prefer this before committing
npm run build:call-rust  # Rust call child (tools/call/child)
npm run test:call-rust   # cargo tests + the TS↔Rust protocol test
```

Both `npm run typecheck:all` and `npm test` must pass before you commit. If you touched
anything under `tools/call/`, the two Rust commands are part of that bar too — and the
release binary must be rebuilt, or the next call still runs the old one.

## House style

- **Tests are colocated**: `foo.ts` → `foo.test.ts`, discovered by glob. Plain
  `node:assert/strict` at module top level, no framework, no describe/it.
- **Comments explain WHY, not what.** The existing comments are load-bearing: they
  record the reasoning and the failure that motivated a line. Match that register —
  and when you change behavior a comment describes, update the comment in the same
  edit. Never leave a comment describing how something *used* to work.
- **No build-order artifacts in names.** Phase/gate/step names from an implementation
  plan must not survive into filenames, identifiers, or docs. Name things for what
  they do.
- TypeScript strict, ESM, `.ts` imports resolved by tsx. zod is pinned at v3 on
  purpose — see the note in `package.json` before touching it.
- Commit subjects are lowercase, `area: what changed and why it matters`
  (e.g. `call lane: fix the live-call drop — orphan twin session, not a slow turn`).
  Read `git log` and match it. Body only when the why needs more than the subject.

## Off-limits

- **Never `git push`.** The owner pushes. Never rewrite history, amend, or revert commits
  you didn't write in this run.
- **`config/` and `.env` are the owner's** — hand-edited only. Propose the change in
  your report instead of making it.
- **`.state/` is runtime state** (sqlite index, job ledger, session files), gitignored.
  Don't commit it, don't hand-edit it.
- Don't restart the daemon. It auto-restarts when its own source changes, which also
  means you cannot test your change against the running process in the same run — say
  so plainly rather than claiming it's verified.
- Secrets never land in code, tests, or fixtures. Redact before writing a fixture.
