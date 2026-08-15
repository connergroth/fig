import assert from "node:assert/strict";

import { isUsageCommand, refreshEnv, runUsageCommand, type UsageDeps } from "./slash";
import { bar, fmtReset, jwtExpiryMs, tokenLooksExpired } from "./tools";

/** base64url JWT with just an exp claim — enough for the expiry probe. */
function fakeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
}

/** The scan-bar: 10 same-width glyphs, rounded to the nearest segment, clamped, absent on junk. */
function barRendering(): void {
  assert.equal(bar(0), "░░░░░░░░░░ ");
  assert.equal(bar(6), "▓░░░░░░░░░ ", "small-but-nonzero rounds to one segment");
  assert.equal(bar(57), "▓▓▓▓▓▓░░░░ ");
  assert.equal(bar(75), "▓▓▓▓▓▓▓▓░░ ", "75 rounds up");
  assert.equal(bar(100), "▓▓▓▓▓▓▓▓▓▓ ");
  assert.equal(bar(140), "▓▓▓▓▓▓▓▓▓▓ ", "clamped above 100");
  assert.equal(bar("57"), "", "non-number → no bar, line still reads");
  assert.equal(bar(undefined), "");
}

/**
 * Reset times render on the OWNER'S clock, not the provider's billing zone. This shipped
 * pinned to America/Los_Angeles, so every reset read an hour early for a Mountain-time
 * owner — a wrong number that looks exactly as authoritative as a right one.
 */
function resetRendersInOwnerZone(): void {
  // 2026-08-13 22:59Z = 4:59pm Denver, 3:59pm LA. Same instant, different clocks.
  const at = "2026-08-13T22:59:00Z";
  assert.equal(fmtReset(at, "America/Denver"), "4:59 PM");
  assert.equal(fmtReset(at, "America/Los_Angeles"), "3:59 PM", "zone is what moves it, not the parse");
  assert.equal(fmtReset(at, "America/New_York"), "6:59 PM");
  // epoch seconds and epoch millis take the same path
  assert.equal(fmtReset(Date.parse(at) / 1000, "America/Denver"), "4:59 PM");
  assert.equal(fmtReset(Date.parse(at), "America/Denver"), "4:59 PM");
  assert.equal(fmtReset("not a date", "America/Denver"), "unknown");
  assert.equal(fmtReset(undefined, "America/Denver"), "unknown");
  // >20h out picks up the weekday/date so a far reset isn't mistaken for today
  const far = new Date(Date.now() + 40 * 3600 * 1000).toISOString();
  assert.match(fmtReset(far, "America/Denver"), /^[A-Z][a-z]{2}, \d+\/\d+, /);
}

/** The command is the whole word at the start, nothing fuzzier — same bar as /model. */
function parsing(): void {
  assert.equal(isUsageCommand("/usage"), true);
  assert.equal(isUsageCommand("  /USAGE  "), true, "trimmed + case-insensitive");
  assert.equal(isUsageCommand("/usage now pls"), true, "trailing words don't unmatch it");
  assert.equal(isUsageCommand("/usages"), false, "prefix of another word isn't the command");
  assert.equal(isUsageCommand("usage"), false);
  assert.equal(isUsageCommand("what's my /usage"), false, "mid-sentence isn't a command");
}

/** Proactive expiry check: known-past (or within 30s) → stale before any fetch. */
function expiryDetection(): void {
  const now = 1_000_000_000_000;
  assert.equal(tokenLooksExpired(undefined, now), false, "no recorded expiry → can't call it stale");
  assert.equal(tokenLooksExpired(now - 1, now), true);
  assert.equal(tokenLooksExpired(now + 29_000, now), true, "inside the 30s buffer counts as expired");
  assert.equal(tokenLooksExpired(now + 120_000, now), false);
}

/** Codex's expiry lives inside its JWT; junk must read as "unknown", never as "expired". */
function codexExpiryDetection(): void {
  const now = Date.now();
  assert.equal(jwtExpiryMs(fakeJwt(Math.floor(now / 1000) + 600)), (Math.floor(now / 1000) + 600) * 1000);
  assert.equal(jwtExpiryMs("not-a-jwt"), undefined);
  assert.equal(jwtExpiryMs("a.!!!notbase64!!!.c"), undefined);
  assert.equal(jwtExpiryMs(`a.${Buffer.from(JSON.stringify({})).toString("base64url")}.c`), undefined, "no exp claim");
  assert.equal(tokenLooksExpired(jwtExpiryMs("not-a-jwt")), false, "unreadable expiry never counts as stale");
}

/**
 * The bug that broke /usage on 2026-08-12: a refresh spawn that inherits fig's own env
 * gets an ambient token, answers with it, and never rotates the credential on disk.
 */
function refreshEnvStripsAmbientTokens(): void {
  const env = refreshEnv({
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
    ANTHROPIC_API_KEY: "sk-ant-x",
    ANTHROPIC_AUTH_TOKEN: "x",
    OPENAI_API_KEY: "sk-x",
    PATH: "/usr/bin",
    HOME: "/Users/fig",
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin", "everything else survives — the CLI still needs its PATH");
  assert.equal(env.HOME, "/Users/fig", "HOME especially: it's where the credentials being rotated live");
}

function deps(overrides: Partial<UsageDeps>): UsageDeps {
  return {
    fetchClaude: overrides.fetchClaude ?? (async () => ({ text: "claude code: session 10% used", staleToken: false })),
    fetchCodex: overrides.fetchCodex ?? (async () => ({ text: "codex: session 5% used", staleToken: false })),
    refreshClaude: overrides.refreshClaude ?? (async () => true),
    refreshCodex: overrides.refreshCodex ?? (async () => true),
    sleep: overrides.sleep ?? (async () => {}),
  };
}

/** Healthy tokens → both halves reported, zero CLI runs spawned on either side. */
async function freshNoRefresh(): Promise<void> {
  let refreshes = 0;
  const out = await runUsageCommand(
    deps({
      refreshClaude: async () => (refreshes++, true),
      refreshCodex: async () => (refreshes++, true),
    }),
  );
  assert.equal(refreshes, 0, "a healthy fetch must never spawn a CLI run");
  assert.match(out, /claude code: session 10% used/);
  assert.match(out, /codex: session 5% used/);
}

/** The heal path: stale → one refresh run → one retry → real numbers. */
async function staleHealed(): Promise<void> {
  let refreshes = 0;
  let fetches = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () =>
        ++fetches === 1
          ? { text: "claude: token expired", staleToken: true }
          : { text: "claude code: session 22% used", staleToken: false },
      refreshClaude: async () => (refreshes++, true),
    }),
  );
  assert.equal(refreshes, 1);
  assert.equal(fetches, 2, "exactly one retry after the refresh");
  assert.match(out, /session 22% used/);
}

/** Refresh ran but the token's still bad → bounded settle reads, honest error, codex half intact. */
async function staleUnhealed(): Promise<void> {
  let refreshes = 0;
  let fetches = 0;
  let sleeps = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () => (fetches++, { text: "claude: usage endpoint returned 401", staleToken: true }),
      fetchCodex: async () => ({ text: "codex: week 40% used", staleToken: false }),
      refreshClaude: async () => (refreshes++, true),
      sleep: async () => {
        sleeps++;
      },
    }),
  );
  assert.equal(refreshes, 1, "one refresh attempt per invocation, ever");
  assert.equal(fetches, 4, "initial read + 3 bounded settle reads, never a loop");
  assert.equal(sleeps, 2, "settle waits between re-reads, none before the first");
  assert.match(out, /didn't rotate it/);
  assert.match(out, /real `claude` run in a terminal/, "failure message names the move that actually works");
  assert.doesNotMatch(out, /raced/, "no invented cause — say what was tried, not why it might have failed");
  assert.match(out, /codex: week 40% used/, "codex half still shows when claude is down");
}

/** Codex is a first-class heal now, not a dead end — this is the half that was broken since 8/7. */
async function codexStaleHealed(): Promise<void> {
  let refreshes = 0;
  let fetches = 0;
  const out = await runUsageCommand(
    deps({
      fetchCodex: async () =>
        ++fetches === 1
          ? { text: "codex: token expired", staleToken: true }
          : { text: "codex\nweek 12%", staleToken: false },
      refreshCodex: async () => (refreshes++, true),
    }),
  );
  assert.equal(refreshes, 1, "a stale codex token spawns a codex run, not nothing");
  assert.equal(fetches, 2);
  assert.match(out, /week 12%/);
  assert.match(out, /claude code: session 10% used/, "claude half untouched");
}

/** Codex unhealed → its own honest line, and it must not poison the claude half. */
async function codexStaleUnhealed(): Promise<void> {
  const out = await runUsageCommand(
    deps({
      fetchCodex: async () => ({ text: "codex: usage endpoint returned 401", staleToken: true }),
      refreshCodex: async () => false,
    }),
  );
  assert.match(out, /codex: token's stale and the auto-refresh run failed to start/);
  assert.match(out, /real `codex` run in a terminal/);
  assert.match(out, /claude code: session 10% used/);
}

/** Both stale at once (exactly what the owner hit) — each heals on its own, neither blocks the other. */
async function bothStaleHealIndependently(): Promise<void> {
  let claudeFetches = 0;
  let codexFetches = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () =>
        ++claudeFetches === 1
          ? { text: "claude: token expired", staleToken: true }
          : { text: "claude code\nsession 3%", staleToken: false },
      fetchCodex: async () =>
        ++codexFetches === 1
          ? { text: "codex: token expired", staleToken: true }
          : { text: "codex\nweek 12%", staleToken: false },
    }),
  );
  assert.match(out, /session 3%/);
  assert.match(out, /week 12%/);
}

/** The settle window is the fix for a raced keychain write: stale on the instant re-read, fresh one settle later. */
async function staleHealedOnSettle(): Promise<void> {
  let fetches = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () =>
        ++fetches <= 2
          ? { text: "claude: token expired", staleToken: true }
          : { text: "claude code: session 33% used", staleToken: false },
    }),
  );
  assert.equal(fetches, 3, "initial read + instant re-read + one settled re-read");
  assert.match(out, /session 33% used/, "a token that settles late still yields real numbers");
}

/** The claude spawn itself failing must not trigger a doomed retry fetch. */
async function refreshSpawnFails(): Promise<void> {
  let fetches = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () => (fetches++, { text: "claude: token expired", staleToken: true }),
      refreshClaude: async () => false,
    }),
  );
  assert.equal(fetches, 1, "no retry when the refresh run itself failed");
  assert.match(out, /auto-refresh run failed to start/);
}

/** Network errors are not staleness — never spend a claude run on them. */
async function networkErrorNoRefresh(): Promise<void> {
  let refreshes = 0;
  const out = await runUsageCommand(
    deps({
      fetchClaude: async () => ({ text: "claude: request failed (fetch failed)", staleToken: false }),
      refreshClaude: async () => (refreshes++, true),
    }),
  );
  assert.equal(refreshes, 0);
  assert.match(out, /request failed/);
}

/** A codex-side throw degrades to a line, not a lost reply. */
async function codexThrowDegrades(): Promise<void> {
  const out = await runUsageCommand(deps({ fetchCodex: async () => Promise.reject(new Error("boom")) }));
  assert.match(out, /claude code: session 10% used/);
  assert.match(out, /codex: check failed \(boom\)/);
}

/** Symmetrically: a claude-side throw can't take the reply down either. */
async function claudeThrowDegrades(): Promise<void> {
  const out = await runUsageCommand(deps({ fetchClaude: async () => Promise.reject(new Error("kaboom")) }));
  assert.match(out, /claude: check failed \(kaboom\)/);
  assert.match(out, /codex: session 5% used/);
}

async function main(): Promise<void> {
  parsing();
  barRendering();
  resetRendersInOwnerZone();
  expiryDetection();
  codexExpiryDetection();
  refreshEnvStripsAmbientTokens();
  await freshNoRefresh();
  await staleHealed();
  await staleHealedOnSettle();
  await staleUnhealed();
  await codexStaleHealed();
  await codexStaleUnhealed();
  await bothStaleHealIndependently();
  await refreshSpawnFails();
  await networkErrorNoRefresh();
  await codexThrowDegrades();
  await claudeThrowDegrades();
  console.log("usage/slash.test.ts: 17 passed");
}

void main();
