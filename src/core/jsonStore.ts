import fs from "node:fs";
import path from "node:path";

/**
 * Shared file-backed JSON persistence for the small state registries under
 * `config.stateDir` (reminders, scheduled tasks, watches, goals, research jobs,
 * location). One implementation so every store reads with the same
 * missing/malformed-file fallback and writes ATOMICALLY — a crash mid-write can
 * never leave a half-written, unparseable registry behind.
 */

/** Read and parse a JSON file. Returns `fallback` if it's missing or unparseable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Read a JSON array file, returning `[]` unless the file parses to an array. */
export function readJsonArray<T>(file: string): T[] {
  const data = readJson<unknown>(file, []);
  return Array.isArray(data) ? (data as T[]) : [];
}

/**
 * Write `data` as pretty JSON atomically: ensure the parent dir exists, write to
 * a sibling temp file, then rename it over the target. The rename is atomic on
 * POSIX, so a concurrent reader never sees a partially written file. Throws if
 * the write fails — callers in hot loops that prefer to swallow (the scheduler
 * tick, the location poller) wrap this in their own try/catch.
 */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
