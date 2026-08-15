import { redact } from "../core/config";
import { log } from "../core/log";
import type { InboundMessage, Transport } from "../transport";

/**
 * The spot-lane seam. spot is the owner's separate product (its own repo, its own
 * brain) that rides fig's iMessage line as a carrier: non-owner senders route into it,
 * and the owner can /spot-switch onto it. That is owner-specific wiring, so the whole
 * implementation lives in gitignored `src/personal/spot/` — a public checkout ships
 * without the directory and gets `NOOP_SPOT_LANE` instead: mode is always "fig",
 * /spot is not a command, and a stranger's text is dropped (fig never answers anyone
 * but the owner, lane or no lane).
 *
 * Same pattern as `loadPersonalServers` in tools/registry.ts: a static import would
 * make the private dir a build dependency for everyone, so the load is a runtime
 * `require` that treats "the seam module itself is absent" as "no spot lane". Anything
 * else — including a MODULE_NOT_FOUND from a module *inside* personal/spot/ — still
 * throws, so a broken lane fails loudly instead of silently eating strangers' texts.
 */

export type SpotMode = "fig" | "spot";

export interface SpotLane {
  /** Which brain answers the OWNER's line right now. Absent lane ⇒ always "fig". */
  getMode(): SpotMode;
  /** Handle a bare /spot, /fig, /switch — returns the confirmation to send, or null. */
  resolveModeCommand(text: string): string | null;
  /** Relay one owner message to spot's brain and return spot's reply text. */
  relayOwnerMessage(message: string, mediaPaths: string[]): Promise<string>;
  /** The owner-facing "spot's server is down" line — the recovery hint (where spot
   * runs, how to start it) is the lane's knowledge, not the harness's. */
  relayDownReply(detail: string): string;
  /** Route one non-owner inbound into spot. Fire-and-forget; must not throw. */
  routeExternal(transport: Transport, msg: InboundMessage): void;
  /** Start tailing spot's owner-outbox and delivering each line to the owner. */
  startNotify(transport: Transport, owner: string): void;
  /** Extra auto-allowed upload roots (spot's generated marketing outputs). */
  safeUploadRoots(): string[];
}

export const NOOP_SPOT_LANE: SpotLane = {
  getMode: () => "fig",
  resolveModeCommand: () => null,
  // Unreachable while getMode is pinned to "fig" — throw rather than fake a reply if
  // a future call site gets the gating wrong.
  relayOwnerMessage: async () => {
    throw new Error("no spot lane loaded");
  },
  relayDownReply: (detail) => `spot's not answering — ${detail}`,
  routeExternal: (_transport, msg) => {
    // Silent to the sender by design; loud in the log so an owner who EXPECTED the
    // lane (dir missing by accident, not by choice) can see where the text went.
    log(`✗ no spot lane — dropped non-owner inbound from ${redact(msg.from)}`);
  },
  startNotify: () => {},
  safeUploadRoots: () => [],
};

/** True only when the failed resolve is the seam module itself. Only the FIRST line of
 * a MODULE_NOT_FOUND names the module that failed; the "Require stack:" lines below it
 * name the requirers, which would false-match a missing dep *inside* personal/spot/. */
export function isSeamAbsence(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  return err?.code === "MODULE_NOT_FOUND" && String(err.message).split("\n")[0].includes("personal/spot");
}

function loadSpotLane(): SpotLane {
  try {
    return (require("../personal/spot") as { SPOT_LANE?: SpotLane }).SPOT_LANE ?? NOOP_SPOT_LANE;
  } catch (e) {
    if (isSeamAbsence(e)) return NOOP_SPOT_LANE;
    throw e;
  }
}

export const spotLane: SpotLane = loadSpotLane();
