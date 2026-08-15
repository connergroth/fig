import fs from "node:fs";
import path from "node:path";
import { config, isOwner } from "./config";
import { warn } from "./log";

/**
 * The owner reaches the agent from MORE than the configured numbers: iMessage also
 * delivers from the email handles on the same Apple ID (OWNER_EMAILS), picking
 * whichever handle it likes per message. So the email path has to count as the owner
 * too — otherwise email-delivered texts fall through to spot's external line, and
 * read receipts / routing only work on the number. Exact, lowercased match (NOT
 * digit-normalized like isOwner) so it can never collide with a stranger's handle —
 * which is why these stay out of OWNER_NUMBERS and never pass through
 * normalizeNumber. Both inbound routing (index.ts) and read receipts
 * (transport/imsg.ts) go through this. Spot is still reached the normal way, via /spot.
 */
export function parseOwnerEmails(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const OWNER_ALIASES: readonly string[] = parseOwnerEmails(process.env.OWNER_EMAILS);

export function isOwnerOrAlias(from: string): boolean {
  return isOwner(from) || OWNER_ALIASES.includes(from.trim().toLowerCase());
}

/**
 * Proactive/automation outputs (briefing, wake, reminders, scheduled skills, heartbeat,
 * email + calendar pings, research TLDRs, location arrivals, spot notifications) follow
 * the handle the owner last texted from, so they land in whatever thread they're actually using
 * — not pinned to the number. We persist it so the choice survives the overnight restart
 * that precedes the morning briefing/wake; on a cold start with no record yet, it falls
 * back to the configured owner number.
 */
const ACTIVE_HANDLE_FILE = path.join(config.stateDir, "owner-handle.json");
let activeOwnerHandle: string | null = loadActiveHandle();

function loadActiveHandle(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVE_HANDLE_FILE, "utf8"));
    return typeof raw?.handle === "string" ? raw.handle : null;
  } catch {
    return null;
  }
}

/** Record the handle an owner inbound came from — called for every owner message. */
export function noteOwnerInbound(from: string): void {
  if (!from || from === activeOwnerHandle) return;
  activeOwnerHandle = from;
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(ACTIVE_HANDLE_FILE, JSON.stringify({ handle: from }, null, 2));
  } catch (e) {
    warn(`noteOwnerInbound: persist failed: ${e}`);
  }
}

/** Where proactive/automation output should go: last active owner handle, else the number. */
export function proactiveOwnerTarget(): string {
  return activeOwnerHandle ?? config.ownerNumbers[0] ?? "";
}
