import path from "node:path";

import { config } from "../core/config";
import { readJson, writeJson } from "../core/jsonStore";
import { resolveOwnerTz } from "../location/timezone";
import { warn } from "../core/log";

interface CodexFallbackState {
  active?: boolean;
  sinceISO?: string;
  resetAfterISO?: string;
  lastError?: string;
}

const FILE = path.join(config.stateDir, "codex-fallback.json");

export function loadCodexFallback(): CodexFallbackState {
  return readJson<CodexFallbackState>(FILE, {});
}

export function codexFallbackActive(now = new Date()): { active: boolean; shouldProbeClaude: boolean } {
  const state = loadCodexFallback();
  if (!state.active) return { active: false, shouldProbeClaude: false };
  if (!state.resetAfterISO) return { active: true, shouldProbeClaude: false };
  return { active: true, shouldProbeClaude: new Date(state.resetAfterISO).getTime() <= now.getTime() };
}

export function markCodexFallbackActive(error: string | undefined): void {
  const resetAfterISO = parseClaudeResetISO(error);
  writeJson(FILE, {
    active: true,
    sinceISO: new Date().toISOString(),
    ...(resetAfterISO ? { resetAfterISO } : {}),
    ...(error ? { lastError: error.slice(0, 500) } : {}),
  } satisfies CodexFallbackState);
}

export function clearCodexFallback(): void {
  writeJson(FILE, { active: false } satisfies CodexFallbackState);
}

function parseClaudeResetISO(error: string | undefined): string | undefined {
  const raw = error ?? "";
  const m = raw.match(/\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return undefined;

  const hourRaw = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  const tz = normalizeTz(m[4]) ?? resolveOwnerTz();
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) return undefined;

  let hour = hourRaw;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  try {
    const now = new Date();
    let reset = zonedDateToday(hour, minute, tz, now);
    // If the printed reset time has already passed in that timezone, it means the
    // next occurrence tomorrow.
    if (reset.getTime() <= now.getTime()) {
      reset = zonedDateToday(hour, minute, tz, new Date(now.getTime() + 24 * 60 * 60 * 1000));
    }
    return reset.toISOString();
  } catch (e) {
    warn(`couldn't parse Claude reset time "${raw.slice(0, 120)}": ${e}`);
    return undefined;
  }
}

function normalizeTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  const s = tz.trim();
  if (/^[A-Za-z_]+\/[A-Za-z_]+/.test(s)) return s;
  if (/Denver/i.test(s)) return "America/Denver";
  if (/Los[_ ]Angeles|Pacific/i.test(s)) return "America/Los_Angeles";
  return undefined;
}

function partsInTz(d: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function zonedDateToday(hour: number, minute: number, tz: string, anchor: Date): Date {
  const { year, month, day } = partsInTz(anchor, tz);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const actual = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(utcGuess);
  const get = (type: string) => Number(actual.find((p) => p.type === type)?.value);
  const actualAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const wantedAsUTC = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(utcGuess.getTime() + (wantedAsUTC - actualAsUTC));
}
