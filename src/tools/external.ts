import { defineServer, type ServerDefinition } from "./define";

/**
 * The `mcp.json` servers, declared here so they live under the SAME contract as the
 * in-process ones.
 *
 * These are the blind spot in any table of exclusions: they're spread in from a JSON file the
 * vault owns, so a new entry there used to join BOTH lanes without anyone touching a line of
 * TypeScript. That's silent drift in the inclusion direction — the same failure mode as the
 * six-week missing-server bug, pointed the other way. It used to be handled by a second table
 * (`FILE_MCP_REVIEWED`) that existed purely to say "yes, this one was looked at"; that table is
 * gone, because a review note and an exclusion are the same statement — "which lanes, and why"
 * — and splitting them across two tables is how one of them goes stale.
 *
 * Their tools are not statically enumerable (they live in another process), so `kind:
 * "external"` definitions carry no capabilities. Everything else about them is declared.
 */
export const EXTERNAL_SERVERS: readonly ServerDefinition[] = [
  defineServer({
    key: "browser",
    kind: "external",
    purpose: "raw Playwright MCP, pointed at the one shared headed Chrome over CDP",
    exposure: "specialist-only",
    reason:
      "raw Playwright MCP — connected on demand inside the browse specialist's own sub-query, never in an orchestrator's context",
  }),
  defineServer({
    key: "agent-cards",
    kind: "external",
    purpose: "fig's own prepaid virtual Visa cards (AgentCard), for checkout inside a browse run",
    exposure: "specialist-only",
    reason:
      "mcp.json scopes it to the browse specialist; virtual-card issuance never belongs in main context, attended or not",
  }),
  defineServer({
    key: "peekaboo",
    kind: "external",
    purpose: "macOS screen capture and full desktop control — the only path to non-browser Mac apps",
    exposure: "specialist-only",
    reason:
      "full macOS desktop control — click/type/hotkey/dialog/window plus its own autonomous `agent` loop. Specialist-only because fig's operating rules route desktop control through the `browse` specialist, which attaches peekaboo inside its own sub-query (specialists/browser.ts): a live-lane copy would be a second door to a capability that already has one. It charges real money for that door — 27 tool names in the deferred registry every turn, plus a slow external handshake at turn-1, which is why peekaboo's tools routinely aren't searchable on a session's first turn. Same shape as `browser` and `agent-cards`: mounted where the work happens, absent from every orchestrator context. An unattended pass can still reach peekaboo's READ tools through browse (an unattended launch snapshots a null approver so write tools auto-deny, but see/image/capture allow silently); narrowing that is narrowing the browse specialist, a separate call",
  }),
];
