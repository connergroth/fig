/**
 * Push `config/vapi-assistant.json` to the Vapi assistant named by VAPI_ASSISTANT_ID.
 *
 * The assistant (persona, greeting, tools, endpointing, voicemail handling) lives on
 * Vapi's servers, so without this it is config that exists nowhere in the repo: nobody
 * can see what the caller is actually told to do, and a dashboard edit is invisible in
 * git. The JSON file is the source of truth; this makes the server match it.
 *
 *   npm run vapi:sync           # push
 *   npm run vapi:sync -- --diff # show what would change, push nothing
 *
 * Anything not named in the JSON is left untouched on Vapi.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://api.vapi.ai";
// Run via `npm run vapi:sync`, so cwd is the package root.
const CONFIG = path.resolve(process.cwd(), "config", "vapi-assistant.json");

async function api(method: "GET" | "PATCH", id: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/assistant/${id}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY!.trim()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${method} /assistant/${id} → ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/**
 * Stable JSON — object key ORDER is not a difference. Vapi echoes keys back in its own
 * order, so a plain JSON.stringify compare reports every nested object as changed
 * forever, and a sync tool that always claims work to do is a sync tool nobody reads.
 */
function canon(v: unknown): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, walk(x[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

/** One line per top-level key that would change, with a short before/after. */
function diff(live: any, desired: any): string[] {
  const short = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? "(unset)" : s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };
  const out: string[] = [];
  for (const [k, want] of Object.entries(desired)) {
    const have = live?.[k];
    if (canon(have) !== canon(want)) {
      out.push(`  ${k}\n    live:    ${short(have)}\n    desired: ${short(want)}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const id = process.env.VAPI_ASSISTANT_ID?.trim();
  if (!process.env.VAPI_API_KEY?.trim() || !id) {
    throw new Error("Set VAPI_API_KEY and VAPI_ASSISTANT_ID (see .env.example).");
  }

  const desired = JSON.parse(await readFile(CONFIG, "utf8"));
  const live = await api("GET", id);
  const changes = diff(live, desired);

  if (!changes.length) {
    console.log("assistant already matches config/vapi-assistant.json — nothing to push.");
    return;
  }

  console.log(`${changes.length} field(s) differ:\n${changes.join("\n")}\n`);
  if (process.argv.includes("--diff")) {
    console.log("(--diff: nothing pushed)");
    return;
  }

  await api("PATCH", id, desired);
  console.log("pushed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
