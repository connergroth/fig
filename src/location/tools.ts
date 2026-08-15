import { z } from "zod";

import { config } from "../core/config";
import { defineServer, toSdkServer } from "../tools/define";
import {
  appleMapsPin,
  forwardGeocode,
  pollLocationFresh,
  pollOwnerLocation,
  requestLocationShare,
  reverseGeocode,
} from "./findmy";
import { addWatch, cancelWatch, FIX_STALE_MS, humanizeAge, listWatches, setCachedLocation } from "./store";

const OWNER = config.ownerNumbers[0] ?? "";
const OWNER_NAME = (process.env.OWNER_NAME ?? "").trim().toLowerCase();
const DEFAULT_RADIUS_M = 150;

/** Resolve a "who" argument to a Find My address. Empty / me / self / the owner's name → the owner. */
function resolveAddress(person?: string): string {
  const p = (person ?? "").trim().toLowerCase();
  if (!p || p === "me" || p === "self" || p === "owner" || (OWNER_NAME && p === OWNER_NAME)) return OWNER;
  return person!.trim();
}

/**
 * Live-location tools (Find My). The agent uses these for "where am I / where's X", to stage
 * directions from the owner's real position, and to set arrival pings. Ambient location (their
 * current whereabouts) is already injected into the prompt each turn by the poller — these are
 * for fresh/precise lookups, other people, and arrival watches.
 *
 * One capability, one definition, one name: these live here and nowhere else. A second copy of
 * `where_is` on another surface is how a fix-staleness check gets skipped and a frozen fix gets
 * reported as current.
 */
export const locationServerDef = defineServer({
  key: "location",
  kind: "direct",
  purpose: "the owner's live Find My location, other people's if they share, and arrival watches",
  exposure: "both",
  capabilities: [
    {
      name: "where_is",
      purpose: "one live Find My fix for the owner or someone sharing with them",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "a read of one location; was fallback-published before the rewrite as fig_tools.where_is",
      description:
        "Get someone's current live location via Find My. `person` defaults to the owner themselves; pass a phone/email to locate someone who shares their location with them. Returns the address, coordinates, and a tappable Apple Maps pin. Use the owner's result as the origin for directions and 'near me'.",
      input: {
        person: z.string().optional().describe("phone/email to locate; omit for the owner themselves"),
      },
      handler: async (args) => {
        const address = resolveAddress(args.person);
        if (!address) return "No owner number configured, and no person given.";
        // For the owner themselves, walk their handle list (their phone shares under their Apple-ID
        // gmail, not their number); for anyone else, poll the given handle directly.
        const pos = address === OWNER ? await pollOwnerLocation() : await pollLocationFresh(address);
        if (!pos) {
          return `Couldn't get a location for ${args.person ?? "the owner"}. They may not be sharing location with the mini's Apple ID (use request_share), or Find My had no fix.`;
        }
        const addr = (await reverseGeocode(pos.lat, pos.lng)) ?? pos.coarseAddress ?? `${pos.lat}, ${pos.lng}`;
        // Keep the ambient cache warm when we just located the owner.
        if (address === OWNER) {
          setCachedLocation({
            lat: pos.lat,
            lng: pos.lng,
            address: addr,
            fixAt: pos.timestamp ? new Date(pos.timestamp).toISOString() : undefined,
          });
        }
        // Surface the REAL fix age, and shout if it's stale — a frozen fix looks
        // identical to a live one except for this number, so never hide it.
        let freshness = "";
        if (pos.timestamp) {
          const ageMs = Date.now() - pos.timestamp;
          freshness =
            ageMs > FIX_STALE_MS
              ? `\n⚠️ STALE: this fix is ${humanizeAge(ageMs)} old (last real update from their phone). Their device likely stopped sharing — do NOT treat this as their current location.`
              : `\nfix age: ${humanizeAge(ageMs)} (live)`;
        } else {
          freshness = "\n⚠️ no fix timestamp — can't confirm how fresh this is.";
        }
        return `${args.person ?? "the owner"} is at: ${addr}\ncoords: ${pos.lat}, ${pos.lng}${freshness}\n${appleMapsPin(pos.lat, pos.lng, addr)}`;
      },
    },
    {
      name: "watch_arrival",
      purpose: "text the owner a note when they get within N metres of a place",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "file-backed local watch; the eventual outbound text is the harness's, not the caller's",
      notes: "File-backed local watch; eventual outbound text is handled by harness.",
      description:
        "Ping the owner when they reach a place. Give the destination as a name or address; when their live location comes within `radius_m` of it, they get `note` as a text. Use for 'tell me when I'm home', 'let me know when I'm 5 min out', etc.",
      input: {
        place: z.string().describe("destination name or address"),
        note: z.string().describe("the message to text them on arrival, in your voice"),
        radius_m: z.number().optional().describe(`trigger radius in meters (default ${DEFAULT_RADIUS_M})`),
      },
      handler: async (args) => {
        const geo = await forwardGeocode(args.place);
        if (!geo) return `Couldn't resolve "${args.place}" to a location (no Maps key or no match).`;
        const w = addWatch(geo.address, geo.lat, geo.lng, args.radius_m ?? DEFAULT_RADIUS_M, args.note);
        return `Arrival watch set (${w.id}): when they're within ${w.radiusM}m of ${geo.address}, I'll text "${w.note}".`;
      },
    },
    {
      name: "list_arrival_watches",
      purpose: "show the arrival watches currently armed",
      mutates: "read",
      fallback: "allow",
      fallbackReason: "reads local watch state",
      description: "List active arrival watches.",
      input: {},
      handler: async () => {
        const list = listWatches();
        if (!list.length) return "No arrival watches set.";
        return list.map((w) => `${w.id} | ${w.label} (${w.radiusM}m) | "${w.note}"`).join("\n");
      },
    },
    {
      name: "cancel_arrival_watch",
      purpose: "disarm one arrival watch by id",
      mutates: "write",
      fallback: "allow",
      fallbackReason: "local and reversible — the watch can be re-armed",
      description: "Cancel an arrival watch by id.",
      input: { id: z.string().describe("arrival watch id") },
      handler: async (args) => (cancelWatch(args.id) ? `Cancelled ${args.id}.` : `No watch ${args.id}.`),
    },
    {
      name: "request_share",
      purpose: "send someone the native Find My share-your-location prompt",
      mutates: "write",
      fallback: "deny",
      fallbackReason:
        "not in the pre-rewrite fallback surface, and it pushes a prompt to a third party's phone — an out-of-process coding runtime has no business initiating that",
      description:
        "Send someone the native Find My 'share your location' prompt, so the owner can locate them afterward. `person` defaults to the owner (to onboard their own sharing with the mini).",
      input: { person: z.string().optional().describe("phone/email; omit for the owner") },
      handler: async (args) => {
        const address = resolveAddress(args.person);
        if (!address) return "No address to request sharing from.";
        const ok = await requestLocationShare(address);
        return ok ? `Sent a location-share request to ${args.person ?? "the owner"}.` : "Couldn't send the share request.";
      },
    },
  ],
});

export const locationServer = toSdkServer(locationServerDef);
