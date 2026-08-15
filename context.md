# context.md — bot

The iMessage-native personal agent (fig) built on the Claude Agent SDK, with the
sibling Obsidian vault at `../brain` as its memory. Daemon entry point:
`src/index.ts`. This file is the shared vocabulary — read it before working here so
you're arguing about the real decisions, not the terms.

## Glossary

- **vault / brain** — the sibling Obsidian repo at `../brain` (override `BRAIN_DIR`).
  It's the agent's cwd, so memory/archive/daily-logs are just files it greps + edits.
  No database, no embeddings. Its own git repo, separate from code history.
- **turn** — one run of the agent loop for one inbound message: resume session →
  `query()` → chunked reply. `src/session/session.ts` owns the loop.
- **session** — the resumed Claude Agent SDK conversation. Resumed per turn so
  context persists; `src/session/agent.ts` builds the `query()`.
- **transport** — the channel abstraction the daemon talks to instead of any
  specific messenger. `TRANSPORT` is a comma-separated list (e.g. `imsg,telegram`);
  first entry is primary.
- **imsg** — the live primary transport: the agent's iMessage line via the `imsg` CLI
  (OpenClaw/imsg). Drives Messages.app directly — reads `chat.db`, sends through the
  injected IMCore bridge (typing indicators, tapbacks, send effects). Inbound is a
  long-running self-healing `imsg watch --json` stream. `relay.ts` (the HTTP
  **relay** transport) is dead code: present in the tree, never selected. Don't wire
  new work through it.
- **Find My / location** — reads the owner's live location off an injected dylib
  over a trigger-file protocol, not over any HTTP relay.
  `src/location/{findmy,bridge}.ts`.
- **dual-dylib injection** — Messages.app is launched with TWO adhoc-signed dylibs in
  `DYLD_INSERT_LIBRARIES` (SIP off): the imsg messaging bridge + the findmy.dylib
  Find My reader. An OS/app update relaunches Messages clean (no dylibs), silently
  killing BOTH messaging and Find My — a watchdog re-injects, health-signalled by the
  Find My dylib's ~2s heartbeat file. `src/transport/inject.ts`.
- **specialist** — a scoped sub-query with its own tool set (browse, claude-code,
  codex). Only a **thin delegator** for each loads into the main context; the heavy
  tools live inside the sub-query. `src/specialists/`. It earns its place when the
  work is long and its output is big. Mail and calendar are deliberately NOT
  specialists — they're plain deferred tools the agent calls itself, because one call
  and one answer doesn't justify an extra LLM run, or the lossiness of reading prose
  instead of the tool's own output.
- **skill** — a `../brain/.claude/skills/*/SKILL.md` instruction file. Frontmatter
  (name+description) is injected every turn as an index; the BODY lazy-loads on
  invoke (progressive disclosure). No embeddings — "matching" is fig reading the
  descriptions in-context.
- **SOUL.md** — the agent's voice, a plain vault file appended to the system prompt
  **every turn** (re-read each turn, so edits go live). Editable by the agent.
- **HARNESS_RULES** — the mechanical operating rules (iMessage formatting, vault,
  permission model) in `src/session/agent.ts`. Kept in code so they can't be edited
  away by accident, unlike SOUL.md.
- **permission model** — tiered approve-over-iMessage gating, enforced in
  `canUseTool` (code, not prompt). Three tiers: **auto-allow** (reads, ordinary
  writes/edits/shell), **ask** (sensitive outward actions → 🔐 text, 👍/👎, 120s→deny),
  **hard-deny** (static blocklist: sudo, rm -rf /, keychain dumps…).
- **territory** — the "ask" tier: sensitive outward-facing actions (send email,
  spend money, reveal payment details, destructive calendar/mail) that prompt first.
- **ack** — the opener tool (`src/ack`): fig's first user-visible line before it
  goes to work. Only the ack text + the final reply reach the user; everything
  between is suppressed.
- **chunking** — tuned splitting of a reply into paced iMessage bubbles + human
  cadence. `[[split]]` forces a new bubble; bare URLs get their own bubble.
  `src/render/chunking.ts`.
- **heartbeat** — the proactive beat: the agent waking on a cron/event to check if
  anything's worth doing, then usually going quiet. `src/scheduling/proactive.ts`;
  behavior spec in the vault's `Policies/HEARTBEAT.md`. NOT the watchdog.
- **watchdog** — an external dead-man's-switch that restarts the daemon if it dies.
  Separate from the heartbeat (which runs *inside* a live daemon).
- **detach-on-interrupt** — interruptible specialist tools: a correction arriving
  mid-turn aborts the live turn and the in-flight specialist detaches, its eventual
  result re-injected later instead of blocking the fix. `src/specialists/detach.ts`.
- **background injection** — a synthetic inbound (a detached specialist's result, a
  proactive nudge). Flagged so the auto-ack backstop stays silent on non-user turns.
- **scheduled task** — a file-backed one-off timed job that survives restarts and
  catches up if the box was down at fire time. `src/scheduling/scheduledTasks.ts`.
- **fig-tools MCP** — the in-process MCP exposing fig's own tools (reminders,
  location, scheduled tasks, etc). `src/runtimes/fig-tools-mcp.ts`.
- **credential injector** — browser-only login that fills an allowlisted site
  without the model ever seeing the secret; model references a handle (`amazon`),
  gets back only `{ok:true}`. `docs/credential-injector.md`.
- **fallback chain** — ordered model/provider fallback on exhaustion (opus → sonnet
  → opus prior). `src/runtimes/fallback.ts`, `src/runtimes/registry.ts`.
- **compaction / rollover** — trimming context as a session grows, carrying working
  state across a context rollover. `src/session/compaction.ts`.
- **second-persona lane** — an optional lane for a second product that shares the
  agent's iMessage line: non-owner senders route into it, gated + rate-limited.
  `src/spot/lane.ts` is the seam; the implementation is owner-specific and lives in
  gitignored `src/personal/`, so a checkout without it drops stranger texts instead.

## Key nouns & how they relate

The **daemon** (`index.ts`) receives an inbound over a **transport** and hands it
to the **session**, which runs one **turn** through the Agent SDK's `query()`. That
query is armed by `agent.ts` (system prompt = **HARNESS_RULES** + **SOUL.md** +
vault **CLAUDE.md** + open loops) and gated by the **permission model** in
`canUseTool`. Heavy capabilities are **specialists** (scoped sub-queries) so the
main context stays thin; recurring workflows are **skills** the agent reads on
demand. The **heartbeat** fires turns proactively; **scheduled tasks** fire timed
ones. Replies get **chunked** into bubbles and sent back out the transport.

## Where things live

- `src/index.ts` — daemon entry / bootstrap.
- `src/session/session.ts` — the turn loop: enqueue, abort-on-new-message, flush,
  and the stripping of heavy specialist/MCP tools from the main context.
- `src/session/agent.ts` — builds the `query()`; holds `HARNESS_RULES`.
- `src/runtimes/permissions.ts` — `canUseTool`, the tiered gate.
- `src/render/chunking.ts` — bubble splitting + cadence.
- `src/specialists/` — one thin delegator per specialist (browse/claude-code/codex
  + jobs/detach/approval). `prompts/*.md` holds their system prompts, plus the mail
  triage brief. They live in the repo, not the vault, so they ship in the same commit
  as the tools they describe instead of going stale next to them.
- `src/transport/` — imsg (live), telegram (backup), fanout; relay.ts is dead code.
- `src/location/` — Find My via injected dylib (findmy.ts, bridge.ts).
- `src/scheduling/` — proactive (heartbeat), scheduledTasks, reminders, watches,
  reconcile, goals.
- `src/core/config.ts` — config + `DEFAULT_AGENT_NAME`. **Hand-edit only** (see gotchas).
- `mcp.json` (repo root) — MCP servers, Claude Code format, `${VAR}` substitution.

## Conventions & gotchas

- **Log timestamps are UTC.** Subtract for Pacific before reasoning about "what
  time did this happen."
- **`config.ts` is hand-edit-only.** The source-change watcher resolves its path
  from `__dirname` in that file, so relocating config silently breaks hot reload
  (it ends up watching `src/src`). Don't move it to "fix" a path.
- **`session.ts` strips `browser` and `agent-cards` from the main context** — those
  connect on demand inside the browse specialist; payments never touch main context.
- **SOUL.md is re-read every turn** — behavior changes go there (or HARNESS_RULES),
  not into `Feedback/` (that vault folder is a record, not auto-loaded).
- **Scrub external text before it enters context** — `stripLoneSurrogates` guards
  the fetch/tool-result and background-injection choke points; an orphaned surrogate
  from a sliced web page can 400 the next API call.
- **Only the ack + final reply reach the user.** Progress/narration between them is
  suppressed by the harness — don't rely on mid-turn text being seen.

## Deeper docs

- `docs/adding-a-tool.md` — how a capability is declared, and what derives from it.
- `docs/credential-injector.md` — the browser-login security boundary.
