import assert from "node:assert/strict";

/**
 * Tests for the maps/route tool — the traffic lookup that replaced a python script the brain
 * could only reach by noticing a skill and shelling out to it.
 *
 * What's actually worth locking down here:
 *   1. The traffic params. `duration_in_traffic` only comes back when `departure_time=now` and
 *      `traffic_model=best_guess` are sent, and driving is the only mode they're valid for. Drop
 *      them and every answer silently degrades to the static free-flow estimate — the exact
 *      useless number this tool exists to replace, and a regression nothing else would catch.
 *   2. Failure is a VALUE, never a throw. A dead network or a ZERO_RESULTS address must come
 *      back as a string the brain can relay (and escalate to the browser from), because a throw
 *      inside a tool handler costs the whole turn.
 *   3. The delay-percentage bands, because the commute skill's proactive "worth leaving now"
 *      decision branches on them and the 12% threshold now lives in one place.
 *   4. Registry wiring: the server is in both lanes and therefore on the Codex bridge, with no
 *      second list to add it to.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

/** A Directions response with both durations, i.e. what a driving request gets back. */
function trafficBody(freeFlowSec: number, trafficSec: number) {
  return {
    status: "OK",
    routes: [
      {
        summary: "I-15 S",
        legs: [
          {
            start_address: "500 Example Pkwy, Springfield, IL 62704, USA",
            end_address: "12 Example Ave, Springfield, IL 62701, USA",
            distance: { text: "22.4 mi" },
            duration: { value: freeFlowSec, text: "30 mins" },
            duration_in_traffic: { value: trafficSec, text: "42 mins" },
          },
        ],
      },
    ],
  };
}

function fakeFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function main(): Promise<void> {
  process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "test-key";
  const { lookupRoute, formatRoute, trafficLabel, directionsUrl, CLEAR_MAX_PCT } = await import("./directions");

  console.log("maps: the traffic-aware request");

  await check("driving asks for live traffic (departure_time=now + best_guess)", () => {
    const url = directionsUrl({ origin: "a", destination: "b", mode: "driving" }, "k");
    assert.ok(url.includes("departure_time=now"), "driving must send departure_time=now");
    assert.ok(url.includes("traffic_model=best_guess"), "driving must send traffic_model=best_guess");
    assert.ok(url.includes("key=k"));
  });

  await check("non-driving modes send no traffic model", () => {
    for (const mode of ["walking", "transit", "bicycling"] as const) {
      const url = directionsUrl({ origin: "a", destination: "b", mode }, "k");
      assert.ok(!url.includes("departure_time"), `${mode} must not ask for a traffic model`);
      assert.ok(!url.includes("traffic_model"), `${mode} must not ask for a traffic model`);
    }
  });

  await check("origin/destination are url-encoded, not concatenated raw", () => {
    const url = directionsUrl({ origin: "12 Example Ave, Springfield", destination: "32.9,-117.1" }, "k");
    assert.ok(!url.includes("12 Example"), "a raw space would produce an invalid request URL");
    assert.ok(url.includes("12+Example+Ave") || url.includes("12%20Example%20Ave"));
  });

  console.log("maps: parsing");

  await check("traffic duration wins over free-flow, with the delay derived", async () => {
    const { impl } = fakeFetch(trafficBody(1800, 2520)); // 30 min free-flow, 42 with traffic
    const r = await lookupRoute({ origin: "work", destination: "home", fetchImpl: impl });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.read.minutes, 42, "the headline number is the traffic-aware one");
    assert.equal(r.read.freeFlowMinutes, 30);
    assert.equal(r.read.delayMin, 12);
    assert.equal(r.read.delayPct, 40);
    assert.equal(r.read.trafficAware, true);
    assert.equal(r.read.route, "I-15 S");
    assert.equal(r.read.distance, "22.4 mi");
    assert.equal(r.read.to, "12 Example Ave, Springfield, IL 62701, USA");
  });

  await check("no traffic estimate falls back to free-flow and says so", async () => {
    const body: any = trafficBody(1800, 2520);
    delete body.routes[0].legs[0].duration_in_traffic;
    const { impl } = fakeFetch(body);
    const r = await lookupRoute({ origin: "a", destination: "b", mode: "walking", fetchImpl: impl });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.read.minutes, 30);
    assert.equal(r.read.trafficAware, false);
    assert.equal(r.read.delayMin, null, "a made-up delay is worse than no delay");
    assert.equal(r.read.delayPct, null);
  });

  await check("a faster-than-free-flow drive reports a negative delay, not a floor of 0", async () => {
    const { impl } = fakeFetch(trafficBody(1800, 1620));
    const r = await lookupRoute({ origin: "a", destination: "b", fetchImpl: impl });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.read.delayMin, -3);
    assert.equal(r.read.delayPct, -10);
  });

  console.log("maps: failure is a value, not a throw");

  await check("a google error status comes back as ok:false with the reason", async () => {
    const { impl } = fakeFetch({ status: "ZERO_RESULTS", error_message: "no route", routes: [] });
    const r = await lookupRoute({ origin: "a", destination: "nowhere", fetchImpl: impl });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /ZERO_RESULTS/);
    assert.match(r.error, /no route/);
  });

  await check("an HTTP failure is reported, not parsed", async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 403 });
    const r = await lookupRoute({ origin: "a", destination: "b", fetchImpl: impl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /403/);
  });

  await check("a thrown fetch is caught — a tool handler must never lose the turn", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await lookupRoute({ origin: "a", destination: "b", fetchImpl: impl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /ENOTFOUND/);
  });

  await check("a route with no duration is rejected rather than reported as 0 min", async () => {
    const { impl } = fakeFetch({ status: "OK", routes: [{ summary: "x", legs: [{}] }] });
    const r = await lookupRoute({ origin: "a", destination: "b", fetchImpl: impl });
    assert.equal(r.ok, false);
  });

  await check("a missing api key fails loudly instead of calling google keyless", async () => {
    const saved = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "";
    try {
      let called = false;
      const impl = (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const r = await lookupRoute({ origin: "a", destination: "b", fetchImpl: impl });
      assert.equal(r.ok, false);
      assert.equal(called, false, "no point spending a request without a key");
      if (!r.ok) assert.match(r.error, /GOOGLE_MAPS_API_KEY/);
    } finally {
      process.env.GOOGLE_MAPS_API_KEY = saved;
    }
  });

  await check("a blank destination is caught before the request", async () => {
    const r = await lookupRoute({ origin: "a", destination: "   " });
    assert.equal(r.ok, false);
  });

  console.log("maps: the delay bands the commute watch branches on");

  await check("12% is still clear, 13% is not", () => {
    assert.equal(CLEAR_MAX_PCT, 12, "the commute skill's proactive threshold lives here now");
    assert.equal(trafficLabel(0), "clear");
    assert.equal(trafficLabel(12), "clear");
    assert.equal(trafficLabel(13), "moderate");
    assert.equal(trafficLabel(30), "moderate");
    assert.equal(trafficLabel(31), "heavy");
    assert.equal(trafficLabel(null), "unknown");
  });

  await check("formatRoute leads with the minutes and carries a parseable json line", async () => {
    const { impl } = fakeFetch(trafficBody(1800, 2520));
    const r = await lookupRoute({ origin: "work", destination: "home", fetchImpl: impl });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const out = formatRoute(r.read, "(origin = the owner's current location)");
    assert.match(out.split("\n")[0], /^42 min driving with live traffic/);
    assert.ok(out.includes("(origin = the owner's current location)"), "an assumed origin must be stated");
    const json = JSON.parse(out.split("\n").find((l) => l.startsWith("json: "))!.slice(6));
    assert.equal(json.duration_in_traffic_min, 42);
    assert.equal(json.delay_pct, 40);
    assert.equal(json.traffic, "heavy");
    assert.equal(json.route, "I-15 S");
  });

  console.log("maps: the tool handler");

  /** Run the real published handler with the global fetch stubbed. */
  async function callTool(args: Record<string, unknown>, body: unknown): Promise<string> {
    const { mapsServerDef } = await import("./tools");
    const route = mapsServerDef.capabilities.find((c) => c.name === "route")!;
    const saved = globalThis.fetch;
    globalThis.fetch = fakeFetch(body).impl;
    try {
      return await route.handler(args);
    } finally {
      globalThis.fetch = saved;
    }
  }

  await check("an explicit origin skips Find My entirely and returns the read", async () => {
    const out = await callTool({ origin: "work", destination: "home" }, trafficBody(1800, 2520));
    assert.match(out, /^42 min driving with live traffic/);
    assert.ok(!out.includes("origin = the owner's current location"), "an explicit origin isn't an assumption");
  });

  await check("a failed lookup is relayed as a failure, never as a number", async () => {
    const out = await callTool({ origin: "a", destination: "b" }, { status: "REQUEST_DENIED", routes: [] });
    assert.match(out, /^Directions lookup failed:/);
    assert.match(out, /REQUEST_DENIED/);
    assert.ok(!/\d+ min/.test(out), "a failure must not carry an invented ETA");
  });

  await check("an unknown mode degrades to driving instead of erroring", async () => {
    const out = await callTool({ origin: "a", destination: "b", mode: "teleport" }, trafficBody(1800, 2520));
    assert.match(out, /driving/);
  });

  await check("a missing destination is refused without a request", async () => {
    const { mapsServerDef } = await import("./tools");
    const route = mapsServerDef.capabilities.find((c) => c.name === "route")!;
    assert.match(await route.handler({ destination: "  " }), /needs a destination/);
  });

  console.log("maps: registry wiring");

  await check("the tool is published as mcp__maps__route and nowhere else", async () => {
    const { allCapabilities } = await import("../tools/registry");
    const mine = allCapabilities().filter((c) => c.server.key === "maps");
    assert.deepEqual(
      mine.map((c) => c.name),
      ["mcp__maps__route"],
    );
    assert.equal(mine[0].capability.mutates, "read");
  });

  await check("it's in BOTH lanes, so the scheduled commute watch can call it", async () => {
    const { inLane } = await import("../scheduling/lane");
    const { serverByKey } = await import("../tools/registry");
    const def = serverByKey("maps")!;
    assert.ok(def, "maps must be registered");
    assert.equal(inLane(def.exposure, "live"), true);
    assert.equal(inLane(def.exposure, "unattended"), true);
  });

  await check("codex gets it automatically through the bridge, both lanes", async () => {
    const { bridgeToolList } = await import("../runtimes/toolBridge");
    for (const lane of ["live", "unattended"] as const) {
      const names = bridgeToolList(lane).map((t) => t.name);
      assert.ok(names.includes("maps__route"), `maps__route missing from the ${lane} bridge surface`);
    }
  });

  await check("it did NOT join the pinned in-child fallback surface", async () => {
    // The degraded path is frozen at the pre-rewrite 16 (tools/registry.test.ts). Codex reaches
    // this tool through the bridge instead, so `fallback` stays unset — asserted here so a later
    // "helpful" flip has to argue with a test.
    const { fallbackAllows } = await import("../tools/fallback");
    assert.equal(fallbackAllows("maps__route"), false);
  });

  await check("the derived schema is strict and requires only a destination", async () => {
    const { bridgeToolList } = await import("../runtimes/toolBridge");
    const schema = bridgeToolList("live").find((t) => t.name === "maps__route")!.inputSchema as any;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["destination"], "origin must stay optional — it defaults to where they are");
    assert.deepEqual(schema.properties.mode.enum, ["driving", "walking", "transit", "bicycling"]);
  });

  console.log(`\n${ran - failures}/${ran} passed`);
  if (failures) process.exit(1);
}

void main();
