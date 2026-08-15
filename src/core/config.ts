import os from "node:os";
import path from "node:path";

/**
 * The agent's name lives here and nowhere else. Change this one line (or set
 * AGENT_NAME in the environment) and it propagates through prompts, logs, and
 * outbound copy. "bot" is a filler default — the repo name is filler too.
 */
const DEFAULT_AGENT_NAME = "fig";

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const AGENT_NAME = (process.env.AGENT_NAME || "").trim() || DEFAULT_AGENT_NAME;

/**
 * The bot repo's ROOT — the dir holding package.json, node_modules/, src/, config/.
 * This file lives at src/core/config.ts, so it's two levels up, not one. Get it wrong and
 * everything built on it — configDir, the guardrail paths, delegate cwds, the fig-tools MCP
 * command — silently points one directory too deep at `<repo>/src`. Keep this in step if
 * this file ever moves.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The vault / "brain" — the agent's home and primary store. Its own git repo, sibling to this one by default. */
const BRAIN_DIR = process.env.BRAIN_DIR
  ? path.resolve(expandHome(process.env.BRAIN_DIR.trim()))
  : path.resolve(REPO_ROOT, "..", "brain");

const EXTRA_WRITABLE = envList("EXTRA_WRITABLE_DIRS").map((p) => path.resolve(expandHome(p)));

/** Throwaway working files (renders, screenshots, downloads) — never the vault. See System/Reference/machine-layout.md. */
const SCRATCH_DIR = path.resolve(os.homedir(), "scratch");
/** Where every repo the agent works in lives (this one, the vault, and whatever else it's given). */
const CODE_DIR = path.resolve(os.homedir(), "GitHub");

export const config = {
  agentName: AGENT_NAME,
  repoRoot: REPO_ROOT,
  brainDir: BRAIN_DIR,
  stateDir: path.resolve(BRAIN_DIR, ".state"),
  /** Throwaway/feedstock working files. Never the vault — see the SCRATCH_DIR note above. */
  scratchDir: SCRATCH_DIR,

  /**
   * Policy/config that is NOT memory — security boundaries, allow/guard lists.
   * These files are still hard-denied for agent writes in permissions.ts.
   */
  configDir: path.resolve(REPO_ROOT, "config"),

  model: process.env.AGENT_MODEL || "claude-opus-4-8",
  emailTriageModel: process.env.EMAIL_TRIAGE_MODEL || "claude-haiku-4-5",

  /**
   * fig's OWN persistent email address (AgentMail) — the inbox it knows as its own and
   * uses for anything needing a stable address. Burner inboxes for one-off signups are
   * separate, minted on demand in the browse specialist. Surfaced in the system prompt
   * so fig knows its address without a lookup.
   */
  agentmailAddress: (process.env.AGENTMAIL_ADDRESS || "").trim(),

  /**
   * fig's OWN phone number — the dedicated line kept separate from any number that gets
   * The owner's personal banking/2FA. Normalized to E.164.
   */
  agentPhone: ((): string => {
    const raw = normalizeNumber(process.env.AGENT_PHONE_NUMBER || "");
    if (!raw) return "";
    if (raw.startsWith("+")) return raw;
    return raw.length === 10 ? `+1${raw}` : `+${raw}`;
  })(),

  /** E.164 numbers allowed to talk to the agent. Inbound from anyone else is dropped. */
  ownerNumbers: envList("OWNER_NUMBERS"),

  /**
   * The roots the agent may write in. Claude no longer *gates* on this set — permissions.ts
   * allows ordinary writes anywhere and hard-denies only its own guardrail files — but Codex
   * runs inside a real OS sandbox, so this IS the grant list handed to it (`--add-dir`) when
   * Codex is fig's main brain. The bot repo has to stay in here: main Codex's working root is
   * the vault, and a vault-only sandbox locked Codex out of editing its own runtime.
   */
  writableDirs: [BRAIN_DIR, REPO_ROOT, SCRATCH_DIR, CODE_DIR, ...EXTRA_WRITABLE],

  transport: {
    kind: (process.env.TRANSPORT || "imsg").trim(),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
  },

  /** No proactive (heartbeat) messages inside this window. 24h local. */
  quietHours: {
    start: Number(process.env.QUIET_START ?? 23),
    end: Number(process.env.QUIET_END ?? 8),
  },

  /**
   * Telegram — a reliable backup channel (no Mac/iCloud/phone-plan dependency). Used
   * when TRANSPORT=telegram. The transport bridges Telegram's numeric chat ids to the
   * E.164 owner model internally, so isOwner keeps working. See transport/telegram.ts.
   *   TELEGRAM_BOT_TOKEN      bot token from @BotFather
   *   TELEGRAM_OWNER_CHAT_ID  your chat id — maps to ownerNumbers[0]. Text the bot once;
   *                           it logs the chat id on first contact so you can set this.
   */
  telegram: {
    botToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    ownerChatId: (process.env.TELEGRAM_OWNER_CHAT_ID || "").trim(),
  },

  /**
   * The ONE shared Chrome the credential injector and the browse specialist both drive.
   * The bot launches a single headed Chromium on the ~/.bot-browser profile (the same
   * one `npm run browser:login` populates) with a CDP debug port. @playwright/mcp connects
   * to it over `--cdp-endpoint`, and fill_login reuses the very same in-process page object,
   * so the origin check reads page.url() of the tab the model is actually driving — not
   * whatever desktop window happened to be frontmost (the v1 security hole). DOM fill in
   * that page needs no macOS Accessibility permission and never puts the secret in argv.
   *   BOT_BROWSER_CDP_PORT        debug port (default 9333)
   *   BOT_BROWSER_USER_DATA_DIR   profile dir (default ~/.bot-browser)
   */
  browser: {
    cdpPort: Number(process.env.BOT_BROWSER_CDP_PORT || 9333),
    userDataDir: expandHome((process.env.BOT_BROWSER_USER_DATA_DIR || "~/.bot-browser").trim()),
  },
} as const;

/**
 * Canonicalize a phone handle for identity comparison: strip everything but
 * digits and a leading "+". The ONE definition every owner/peer/routing check
 * goes through — so two call sites can never normalize a number slightly
 * differently and mis-route owner vs stranger. (Email handles are matched
 * exactly+lowercased elsewhere — see core/owner.ts — never through this.)
 */
export function normalizeNumber(s: string): string {
  return s.replace(/[^\d+]/g, "");
}

export function isOwner(number: string): boolean {
  const n = normalizeNumber(number);
  return config.ownerNumbers.some((o) => normalizeNumber(o) === n);
}

/** Redact a phone number for logs — last 4 digits only. Never log full PII. */
export function redact(number: string): string {
  return `…${number.slice(-4)}`;
}
