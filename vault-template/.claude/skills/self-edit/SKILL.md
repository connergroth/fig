---
name: self-edit
description: >-
  Edit the agent's own harness code - the server/agent runtime repo this vault pairs with. Trigger when the owner asks to fix, change, add to, or refactor how the agent itself works: "fix the bot", "edit your own code", "patch the permission flow", "add a tool", "change how the message loop works", "wire up X in the harness", or whenever a fix to the agent's behavior actually lives in the harness repo (not the vault, not a skill). NOT for editing skills (that's skill-creator) or vault notes - this is the TypeScript runtime the agent runs on.
---

# self-edit (editing my own code)

This is how I change myself. My runtime lives in the harness repo — the
TypeScript agent built on the Claude Agent SDK, checked out as a sibling of
this vault (the vault's location is the harness's `BRAIN_DIR`; the repo is
wherever it was cloned — find it from my own process if unsure, don't guess).
When a fix or feature is about how *I* work (the message loop, permissions
plumbing, a tool, a specialist, the scheduler), it's a code edit there, not a
vault note or a skill. Treat it like real engineering: read before editing,
make tight targeted changes, typecheck, and know exactly when it goes live.

## the one thing I must never forget: restart timing

The dev server runs under `tsx watch` — it **auto-restarts the moment a source
file changes**. But a restart kills the running process, and *I am that process
mid-turn*. So by design the harness defers the restart: it **auto-restarts the
instant my current loop/turn ENDS.** My edits land now, go live the moment I
stop. No human action, no manual restart.

What this means in practice:
- I can safely write code changes during a turn. The file lands now; the
  restart fires automatically at loop end.
- **Never tell the owner to restart, never ask if they'll "catch it".** The
  restart is automatic and already handled the moment my reply lands. There is
  nothing for them to do.
- By the time they read my next message, the change is effectively live. So the
  status is "done — it's live the moment I stop," NOT "staged, waiting on a
  restart you have to trigger."
- The ONE caveat is testing: I still can't *test* the new code this turn,
  because the version of me answering right now is the old code until the
  restart. So "I can't verify it this turn" is honest; "you need to restart" is
  not.
- If several fixes are written this turn, they all flip together at the one
  auto-restart at loop end. Mention that bucket when relevant.
- Never try to force a restart mid-turn to "test" something. That's the exact
  self-kill the deferral exists to prevent — and it's pointless anyway.

Edge case worth knowing: a few things aren't `tsx watch` source files and so do
NOT ride the auto-restart — notably `mcp.json` / MCP server config. Those
genuinely need a real process restart to pick up. When a change is one of
those, say so explicitly — that's the rare case where a restart is actually
pending. For ordinary `src/**` edits, it's automatic.

## what I can and can't edit

Almost the entire repo is mine to rewrite. The ONLY hard-denied paths — blocked
even with the owner's approval, by design, because they're the code that
defines my own boundary:
- `src/permissions.ts` — the enforcement logic itself
- `src/config.ts` — the config that logic reads
- anything under `config/`

These are guardrails: I can **read** them freely (to understand a permission
decision), but I **cannot write** them — not via the Write/Edit tools, not via
a bash command that mutates them (`sed`, `>`, `tee`, etc. naming those files
are caught too). If a fix genuinely requires changing one, I don't try to route
around it — I explain to the owner exactly what needs to change and they edit
it by hand.

Everything else is fair game: `src/session.ts`, `src/index.ts`, `src/agent.ts`,
the specialists, tools, scheduler, transport, etc.

## the workflow

1. **Find the real file first.** Don't guess paths or freehand from memory.
   `grep`/`glob` the harness repo to locate the actual code before editing.
   The map:
   - `src/index.ts` — entrypoint / wiring
   - `src/session.ts` — the core message loop, turn lifecycle, approval
     handling
   - `src/agent.ts` — agent setup, system prompt assembly
   - `src/permissions.ts` + `src/config.ts` — guardrails (READ-ONLY for me)
   - `src/mcp.ts`, `src/specialists/` — tools and specialist subagents
   - `src/proactive.ts`, `src/scheduler.ts` — heartbeat / cron plumbing
   - `src/transport/`, `src/messages/` — message relay in/out
2. **Read before you edit.** Read the file (and callers) so the change fits the
   existing shape. Make small, surgical edits — not whole-file rewrites.
3. **Make the change.** Prefer the Edit tool for targeted swaps.
4. **Typecheck.** Always run it after editing — it's the only safety net before
   a restart makes the code live:
   ```
   npm run typecheck   # from the harness repo root
   ```
   Clean typecheck before I call it done. If it errors, fix it — don't leave
   broken code staged to auto-restart into.
5. **Report to the owner**: what changed, which file(s), and the timing —
   "done, goes live automatically when this turn ends, nothing for you to do."
   Don't ask them to restart. If it touches the core loop, say so. If it needed
   a guardrail file I can't touch, say that plainly and hand them the exact
   edit.

## gotchas / don'ts

- Don't claim a fix is *verified working* this turn — I'm still the old code
  until the auto-restart, so I can't test it til then. But it IS live the
  moment I stop.
- Don't tell the owner to restart or ask if they'll catch it — the restart is
  automatic at loop end. The exception is non-source config (mcp.json / MCP
  servers), which does need a real restart — call those out explicitly.
- Don't force or trigger a restart mid-turn.
- Don't try to write the guardrail files (`permissions.ts`, `config.ts`,
  `config/*`) — and don't try to bash around the block. Hand those edits to the
  owner.
- Don't skip the typecheck. Auto-restart means a type error becomes a live
  crash.
- Keep edits surgical. This is the code I run on — a sloppy rewrite is a sloppy
  me.
- This skill is for the harness RUNTIME. Editing a skill = skill-creator.
  Editing vault notes = just edit them.
