/**
 * restJson — the genuinely common part of every REST/JSON client in this repo:
 * do the fetch, check the status, and parse the JSON body, throwing a sensible
 * Error on failure. Each client keeps its own thin layer for base URL, auth
 * headers, and body encoding; this only owns fetch + ok-check + parse.
 *
 * Dependency-free on purpose.
 */

export interface RestJsonInit extends RequestInit {
  /**
   * Prefix for thrown error messages, e.g. "Vapi POST /call". The thrown
   * message is `${errPrefix} failed (${status}): ${detail}` on a non-2xx, or
   * `${errPrefix}: non-JSON response (${status})` when the body won't parse.
   */
  errPrefix?: string;
}

/** Pull a human-readable detail out of a typical JSON error envelope. */
function errorDetail(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const j = json as Record<string, any>;
  const m = j.error?.message ?? j.message ?? j.error ?? j.name;
  if (Array.isArray(m)) return m.join("; ");
  return m != null ? String(m) : "";
}

/**
 * Fetch `url`, require a 2xx, and return the parsed JSON body. A 204 (or any
 * empty body) resolves to `{}`. On a non-2xx, or a body that isn't JSON, throws
 * an Error tagged with `init.errPrefix`, the status, and a snippet of the body.
 */
export async function restJson<T = any>(url: string, init: RestJsonInit = {}): Promise<T> {
  const { errPrefix, ...rest } = init;
  const label = errPrefix ?? "request";

  const res = await fetch(url, rest);

  // No body to parse (e.g. 204 No Content).
  if (res.status === 204) return {} as T;

  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`${label} failed (${res.status})`);
    return {} as T;
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    if (!res.ok) throw new Error(`${label} failed (${res.status}): ${text.slice(0, 200)}`);
    throw new Error(`${label}: non-JSON response (${res.status})`);
  }

  if (!res.ok) {
    const detail = errorDetail(json) || text.slice(0, 200);
    throw new Error(`${label} failed (${res.status}): ${detail}`);
  }

  return json as T;
}
