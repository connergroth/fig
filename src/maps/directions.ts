/**
 * Google Directions, traffic-aware — the one implementation.
 *
 * WHY THIS EXISTS IN THE BOT REPO: the drive-time lookup used to live only as a python script
 * inside the vault's commute skill (`.claude/skills/commute/scripts/directions.py`), reachable
 * only by fig noticing the skill and shelling out to it. That made the capability invisible at
 * the tool surface: an ordinary "how's traffic home" got answered by driving Google Maps in a
 * browser instead, which is slower, non-deterministic, burns a browser agent, and produced a
 * number nobody could reproduce. A capability the brain can't see is a capability it won't use,
 * so this is a real tool (`src/maps/tools.ts`) and the skill now calls the tool.
 *
 * The API key is the SAME one the Find My path already uses (`GOOGLE_MAPS_API_KEY`, read by
 * `location/findmy.ts` for geocoding) — one credential, one env var, no new wiring.
 *
 * `departure_time=now` + `traffic_model=best_guess` is what makes `duration_in_traffic` appear
 * in the response; without them Google returns only the free-flow estimate, which is exactly
 * the useless static number this is meant to replace. Driving only — the other modes have no
 * traffic model, so asking for one would silently return the same free-flow duration twice.
 */

/** Read at CALL time, not module load: `.env` is loaded by core/config, and a module-level */
/** capture here would freeze an empty string if this file were ever imported first. */
function mapsKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY?.trim() || "";
}

export type TravelMode = "driving" | "walking" | "transit" | "bicycling";

export const TRAVEL_MODES: readonly TravelMode[] = ["driving", "walking", "transit", "bicycling"];

/**
 * Delay-percentage bands. 12% is the threshold the commute skill's proactive "worth leaving
 * now" decision already used, kept HERE so the skill reads one number instead of restating it.
 */
export const CLEAR_MAX_PCT = 12;
export const MODERATE_MAX_PCT = 30;

export interface RouteRead {
  mode: TravelMode;
  /** Google's resolved addresses — worth surfacing, since a vague origin can geocode oddly. */
  from: string;
  to: string;
  distance: string;
  /** Google's route summary, e.g. "I-15 S". Empty for some short/local routes. */
  route: string;
  /** THE number: minutes with live traffic when driving, free-flow otherwise. */
  minutes: number;
  freeFlowMinutes: number;
  /** null when the response carried no traffic estimate (non-driving, or Google omitted it). */
  delayMin: number | null;
  delayPct: number | null;
  trafficAware: boolean;
}

export type RouteLookup = { ok: true; read: RouteRead } | { ok: false; error: string };

export interface RouteRequest {
  origin: string;
  destination: string;
  mode?: TravelMode;
  /** Test seam. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** "clear" / "moderate" / "heavy" for a delay percentage. */
export function trafficLabel(delayPct: number | null): "clear" | "moderate" | "heavy" | "unknown" {
  if (delayPct === null) return "unknown";
  if (delayPct <= CLEAR_MAX_PCT) return "clear";
  if (delayPct <= MODERATE_MAX_PCT) return "moderate";
  return "heavy";
}

export function directionsUrl(req: RouteRequest, key: string): string {
  const mode = req.mode ?? "driving";
  const params = new URLSearchParams({
    origin: req.origin,
    destination: req.destination,
    mode,
    key,
  });
  if (mode === "driving") {
    params.set("departure_time", "now");
    params.set("traffic_model", "best_guess");
  }
  return `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
}

/** One traffic-aware route lookup. Never throws — a failed lookup is a value, not an exception. */
export async function lookupRoute(req: RouteRequest): Promise<RouteLookup> {
  const mode = req.mode ?? "driving";
  const origin = req.origin?.trim();
  const destination = req.destination?.trim();
  if (!origin) return { ok: false, error: "no origin given, and no live location to fall back on." };
  if (!destination) return { ok: false, error: "no destination given." };

  const key = mapsKey();
  if (!key) return { ok: false, error: "GOOGLE_MAPS_API_KEY isn't set, so directions can't be looked up." };

  const doFetch = req.fetchImpl ?? fetch;
  let body: any;
  try {
    const res = await doFetch(directionsUrl({ ...req, origin, destination, mode }, key), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `Directions API returned HTTP ${res.status}.` };
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `Directions request failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const status = body?.status;
  if (status !== "OK" || !body?.routes?.length) {
    const detail = body?.error_message ? ` — ${body.error_message}` : "";
    // ZERO_RESULTS / NOT_FOUND are usually a bad address, and that's worth saying plainly so
    // the brain re-asks rather than reporting a route it never got.
    return { ok: false, error: `Directions API status ${status ?? "unknown"}${detail}` };
  }

  const route = body.routes[0];
  const leg = route?.legs?.[0];
  const freeFlowSec: unknown = leg?.duration?.value;
  const trafficSec: unknown = leg?.duration_in_traffic?.value;
  if (typeof freeFlowSec !== "number") return { ok: false, error: "Directions API returned a route with no duration." };

  const trafficAware = typeof trafficSec === "number" && trafficSec > 0;
  const minutes = Math.round((trafficAware ? (trafficSec as number) : freeFlowSec) / 60);
  const freeFlowMinutes = Math.round(freeFlowSec / 60);
  const delayMin = trafficAware ? Math.round(((trafficSec as number) - freeFlowSec) / 60) : null;
  const delayPct = trafficAware ? Math.round((((trafficSec as number) - freeFlowSec) / freeFlowSec) * 100) : null;

  return {
    ok: true,
    read: {
      mode,
      from: leg?.start_address ?? origin,
      to: leg?.end_address ?? destination,
      distance: leg?.distance?.text ?? "",
      route: route?.summary ?? "",
      minutes,
      freeFlowMinutes,
      delayMin,
      delayPct,
      trafficAware,
    },
  };
}

/**
 * The tool result: a compact human block plus one `json:` line.
 *
 * The json line is not decoration — the commute skill's proactive tick branches on an exact
 * `delay_pct`, and the field names match what the python script printed so the skill's rule
 * didn't have to be re-derived when it moved onto this tool.
 */
export function formatRoute(read: RouteRead, note?: string): string {
  const lines: string[] = [];
  const head = read.trafficAware
    ? `${read.minutes} min ${read.mode} with live traffic (free-flow ${read.freeFlowMinutes})`
    : `${read.minutes} min ${read.mode} (no live-traffic estimate available)`;
  lines.push(head);
  if (read.delayMin !== null && read.delayPct !== null) {
    const sign = read.delayMin >= 0 ? "+" : "";
    lines.push(`traffic: ${trafficLabel(read.delayPct)} — ${sign}${read.delayMin} min vs free-flow (${sign}${read.delayPct}%)`);
  }
  lines.push(`route: ${read.route || "(no summary)"}${read.distance ? ` · ${read.distance}` : ""}`);
  lines.push(`from: ${read.from}`);
  lines.push(`to: ${read.to}`);
  if (note) lines.push(note);
  lines.push(
    `json: ${JSON.stringify({
      duration_in_traffic_min: read.trafficAware ? read.minutes : null,
      duration_free_flow_min: read.freeFlowMinutes,
      delay_min: read.delayMin,
      delay_pct: read.delayPct,
      traffic: trafficLabel(read.delayPct),
      distance: read.distance,
      route: read.route,
      mode: read.mode,
    })}`,
  );
  return lines.join("\n");
}
