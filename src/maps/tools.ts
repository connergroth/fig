import { z } from "zod";

import { pollOwnerLocation } from "../location/findmy";
import { FIX_STALE_MS, getCachedLocation, humanizeAge } from "../location/store";
import { defineServer, toSdkServer } from "../tools/define";
import { formatRoute, lookupRoute, TRAVEL_MODES, type TravelMode } from "./directions";

/**
 * Drive time, live traffic, and route choice.
 *
 * Named `maps`, not `google_maps`: Google is the vendor behind the current Directions call, not
 * the capability (same rule as `lights` over `govee`). The tool is `route` — server is the
 * domain noun, tool is the action, and neither half restates the other.
 *
 * WHY IT'S A TOOL AND NOT A SKILL SCRIPT: the Directions call already existed, as a python
 * script inside the vault's commute skill. Nothing in the always-loaded prompt said traffic
 * questions map to it, and the commute skill itself isn't in the injected skill list, so
 * "how's traffic home" got answered by opening Google Maps in the BROWSER — slower, needs a
 * browser agent, and gives a number that can't be reproduced. Discoverability was the actual
 * bug, so the capability moved to where the brain already looks: the tool surface, plus one
 * line in the prompt pointing at it (`session/agent.ts`).
 *
 * `exposure: "both"` because the commute watch runs unattended on a weekday-afternoon schedule
 * and its whole job is this lookup. It's a read-only GET against an API we already pay for, so
 * an unattended pass calling it grants nothing a 3am pass shouldn't have.
 *
 * `fallback` is deliberately left UNSET (= deny). Codex-as-main reaches this through the tool
 * bridge (`runtimes/toolBridge.ts`), which derives its surface from `exposure` and therefore
 * picks this up automatically; the in-child stdio fallback is the DEGRADED path and is pinned
 * to the pre-rewrite 16 by `tools/registry.test.ts`. Nothing here needs that path.
 */
export const mapsServerDef = defineServer({
  key: "maps",
  kind: "direct",
  purpose: "live drive time, traffic delay, and route choice via the Google Directions API",
  exposure: "both",
  capabilities: [
    {
      name: "route",
      purpose: "one traffic-aware ETA between two places, defaulting the origin to where the owner is",
      mutates: "read",
      description:
        "Live drive time + traffic between two places (Google Directions, departing now). USE THIS for any traffic / drive-time / ETA / 'how long to X' / 'when should I leave' question — it is the default source of truth, not the browser. `origin` defaults to the owner's current Find My location, so 'how's traffic home' needs only destination. origin/destination take an address, a place name, or a bare 'lat,lng'. Returns minutes with live traffic, the delay vs free-flow (the traffic signal — near 0 is clear), distance, route summary, and a json line. Driving is traffic-aware; walking/transit/bicycling return plain duration.",
      input: {
        destination: z.string().describe("where they're going — address, place name, or 'lat,lng'"),
        origin: z
          .string()
          .optional()
          .describe("starting point; omit to use the owner's current location"),
        mode: z.enum(["driving", "walking", "transit", "bicycling"]).optional().describe("default driving"),
      },
      handler: async (args) => {
        const destination = String(args.destination ?? "").trim();
        if (!destination) return "route needs a destination.";
        const mode = (TRAVEL_MODES.includes(args.mode) ? args.mode : "driving") as TravelMode;

        let origin = String(args.origin ?? "").trim();
        let note: string | undefined;
        if (!origin) {
          const resolved = await currentOrigin();
          if (!resolved) {
            return "No origin given and no usable live location for the owner — pass `origin` explicitly (their home, work, or an address).";
          }
          origin = resolved.origin;
          note = resolved.note;
        }

        const result = await lookupRoute({ origin, destination, mode });
        if (!result.ok) {
          // Say it failed rather than inventing a number. The prompt's escalation from here is
          // the browser, which is the one case a browser traffic lookup is the right move.
          return `Directions lookup failed: ${result.error}`;
        }
        return formatRoute(result.read, note);
      },
    },
  ],
});

/**
 * The owner's current position as a `lat,lng` origin.
 *
 * Cache first, poll second: the location poller keeps a warm fix (it's the same one injected
 * into the turn's "right now" block), so the common case costs nothing. A stale fix is USED but
 * NAMED — the commute question is nearly always asked from the office, and an origin that's a
 * few miles off changes the ETA by a minute, but silently pretending a frozen fix is live is
 * the failure `location/tools.ts` already refuses to commit.
 */
async function currentOrigin(): Promise<{ origin: string; note?: string } | null> {
  const cached = getCachedLocation();
  if (cached) return { origin: `${cached.lat},${cached.lng}`, note: originNote(cached.address) };

  const pos = await pollOwnerLocation();
  if (!pos) return null;
  const ageMs = pos.timestamp ? Date.now() - pos.timestamp : undefined;
  const stale = ageMs !== undefined && ageMs > FIX_STALE_MS;
  return {
    origin: `${pos.lat},${pos.lng}`,
    note: stale
      ? `⚠️ origin is the owner's last known fix, ${humanizeAge(ageMs!)} old — their phone may have stopped sharing, so say you assumed where they're starting from.`
      : originNote(pos.coarseAddress),
  };
}

function originNote(address?: string): string {
  return `(origin = the owner's current location${address ? `: ${address}` : ""})`;
}

export const mapsServer = toSdkServer(mapsServerDef);
