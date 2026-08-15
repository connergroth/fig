# Adding a tool

One capability is defined **once**, next to its handler. Everything else — both agent lanes,
the exclusion table, the Codex fallback server, the generated inventory, skill grants — is
derived from that definition. If you find yourself writing a tool name in a second place, stop:
that second place is a bug, and it is the specific bug this layer exists to make impossible.

## Where it goes

In the module that owns the domain — `src/location/tools.ts`,
`src/tools/personal/lights/tools.ts`. **Not** in `src/tools/registry.ts`. The registry is an
index; it imports definitions and orders them. A declaration living far from the thing it
governs is what rots (lane maps, a fallback-policy array, a review table, a denylist all
drifting apart), so the declaration lives with the handler and the index just points at it.

New domain → new directory with a `tools.ts`, then one import line added to
`IN_PROCESS_SERVERS` in `src/tools/registry.ts`. That import line is the only central edit.

**Owner-specific tools** (anything wired to the owner's own accounts, devices, or money)
live under `src/tools/personal/<domain>/` instead, which is gitignored, and register
in `src/tools/personal/index.ts` (`PERSONAL_SERVERS`) rather than in the registry directly.
The registry loads that whole directory optionally, so a public checkout builds without it.

## The shape

```ts
import { z } from "zod";
import { defineServer, toSdkServer } from "../tools/define";

export const lightsServerDef = defineServer({
  key: "lights",                 // the mcp__<key>__ prefix
  kind: "direct",                // specialist | direct | external
  purpose: "turn the owner's smart lights on/off and set colour or brightness",
  exposure: "both",              // both | live-only | specialist-only
  capabilities: [
    {
      name: "control",
      purpose: "drive or read the state of the owner's lights",      // one line, for humans
      description: "…",                                             // what the model reads
      input: { action: z.enum(["on", "off"]) },                      // CANONICAL. Zod, always.
      mutates: "write",                                             // read | write
      fallback: "allow",                                            // optional; default deny
      fallbackReason: "shells out to a local lamp CLI",
      handler: async (args) => "done",                              // returns a plain string
    },
  ],
});

export const lightsServer = toSdkServer(lightsServerDef);
```

## What each field decides

| field | who reads it | what happens if you get it wrong |
| --- | --- | --- |
| `key` | lane membership, tool prefix, fallback name | two servers with one key silently shadow — checked at load |
| `kind` | inventory; `external` means the tools live in another process | an `external` server with capabilities throws |
| `exposure` | **both lanes** — `live-only` is the only thing keeping a capability out of 3am passes | a wrong `both` hands an unattended pass authority nobody granted |
| `reason` | the exclusion table, the inventory, the next person | required whenever `exposure !== "both"`; throws without it |
| `alwaysLoad` | pins into the turn-1 prompt of **every** pass; settable on the server (all its tools) or on ONE capability, where the capability wins | measured cost: 5,384 chars for the six current pins, 31,974 if everything were pinned |
| `mutates` | the read/write split a read-only grant would be built from | nothing today; wire it right anyway, it's the primitive |
| `fallback` | whether Codex (out-of-process) may call it | **defaults to `deny`** — a new tool never joins that surface by accident |
| `input` | the SDK tool schema **and** the derived JSON Schema Codex gets | it is the only schema; there is no second one to keep in sync |

## What derives automatically

You do not write any of these, and you must not:

- **Live lane** and **unattended lane** membership — computed from `exposure` in
  `src/scheduling/lane.ts`.
- **The exclusion table and its reasons** — `laneExclusions()` is a projection of the
  definitions. There is no table to edit.
- **The Codex stdio fallback** — `src/tools/fallback.ts` filters on `fallback: "allow"`, derives
  the flat name as `<server>__<tool>`, and derives the JSON Schema from the Zod shape. Codex's
  own config never changes; there is one stdio server and it is still called `fig_tools`.
- **The inventory doc** — `tsx scripts/dev/tool-inventory.ts`.
- **Skill grants** — a skill declaring `requiredTools: [lights]` resolves to every tool the
  `lights` server publishes, so adding a tool never leaves a declaration stale.

## What the lint rejects

`defineServer` throws **at module load**, so a half-declared tool cannot boot:

- a server key that isn't lowercase snake_case, or a tool name that isn't
- `exposure` other than `"both"` without a `reason`
- `exposure: "both"` *with* a reason (say it in `purpose` instead)
- a missing `purpose` or `description`
- `fallback` set without a `fallbackReason`
- a duplicate tool name within a server
- **a tool name that restates its server key.** `mcp__calendar__calendar_list` is the disease;
  `mcp__calendar__list` is the cure. If the restatement genuinely has to stay, set
  `namingException` with the reason — on the capability, not in a table somewhere else. There
  are exactly three today (`ack.ack`, `fetch.fetch_url`, `research.deep_research`) and the test
  pins that list, so a fourth is a diff someone reads.

`src/tools/registry.test.ts` additionally fails on:

- **the same handler published under more than one name** — checked by handler identity, not by
  name, which is what makes a hand-authored rename table unnecessary. Most duplicates are one
  capability wearing two names, and a name-based check cannot see them. Identity can.
- a capability missing `mutates`, or a server missing `kind`
- a naming exception without a written reason
- a seventh `alwaysLoad` pin. The six are `ack.ack` (live-only), `email.ask`, `calendar.ask`,
  `scheduled_tasks.schedule`, `scheduled_tasks.list` and `reminders.set` — the last three
  because a commitment is armed in the same turn the promise is written, and a ToolSearch
  round-trip is where a "set" that never happened goes missing. The pin is per capability, so
  `reminders.list`/`cancel` and `scheduled_tasks.cancel` stay deferred beside them.
- the derived JSON Schema drifting from the pinned fallback-schema fixture, for anything Codex
  can call
- `EMAIL_AGENT_TOOLS` / `OUTLOOK_AGENT_TOOLS` naming a gmail/outlook tool that no longer exists

`src/scheduling/requiredTools.test.ts` fails on:

- a server that is in neither lane and carries no exposure decision (`laneServerDrift`)
- an `mcp.json` entry with no definition in `src/tools/external.ts`
- a skill with `schedule:` and no `requiredTools:` line (`requiredTools: []` is legal and means
  "needs nothing, and someone decided that")
- a `requiredTools` entry that resolves to nothing, or that still uses `|` alternation

## Naming

`mcp__<server>__<tool>`: the server is the **domain noun**, the tool is the **action**. The
name must not repeat a token across the two halves. Within a server, prefer the short verb
(`list`, `cancel`, `set`) and reach for `<verb>_<noun>` only when the verb alone is ambiguous
(`list_arrival_watches` sits beside `list` on a different server, and that's fine — the prefix
disambiguates).

Naming a server for a **vendor** is a smell: `lights`, not `govee`. Vendors get replaced;
capabilities don't.

## Things that are deliberately NOT centralised

Each sub-query owns its own `mcpServers` map (`specialists/browser.ts`, `mail/triage.ts`,
`google/triage.ts`, …). Those are not competing copies — one owner each, no duplication — and
pulling them into a central file would move a declaration away from the thing it governs,
which is the original bug wearing a tidier hat. Leave them alone.
