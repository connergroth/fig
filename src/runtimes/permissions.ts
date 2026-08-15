import fs from "node:fs";
import path from "node:path";

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../core/config";
import { acquireFileLock, isHotFile } from "../core/fileLock";
import { getAccounts } from "../mail/accounts";
import { describeEvent } from "../google/calendar";
import { getDraft, getMessage } from "../google/gmail";
import { log } from "../core/log";
import type { Approver } from "../specialists/approval";
import { spotLane } from "../spot/lane";
import { buildOrderApproval, orderPlaceInvocation } from "../webExport/orderGate";

/**
 * Three-tier permission model, enforced in code (not in the prompt, so the model
 * can't talk its way past it):
 *
 *   1. AUTO-ALLOW  — reads anywhere; ordinary writes/edits/bash anywhere.
 *   2. ASK         — sensitive outward-facing actions: sending email, spending money, etc.
 *   3. HARD-DENY   — a static blocklist, regardless of any approval.
 */

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookRead",
  "BashOutput",
  "Monitor", // purely observational — waits on / watches a background job, no side effects
]);

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Commands that are never allowed, even with approval. Matched against the Bash command string. */
const HARD_DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+-rf\s+(?:--no-preserve-root\s+)?\/(?:\s|$)/, // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /security\s+(?:dump-keychain|find-generic-password|find-internet-password)/,
  /\bdefaults\s+delete\b/,
  /curl[^|&;]*\|\s*(?:sudo\s+)?(?:ba)?sh/, // curl ... | sh
  /\b:\(\)\s*\{\s*:\|:&\s*\}/, // fork bomb
];

/** Resolve a tool path the way the agent means it: relative to ITS cwd (the vault), not the daemon's. */
function resolveAgentPath(p: string): string {
  return path.resolve(config.brainDir, p);
}

/**
 * The agent's own guardrails: the files that define what it's allowed to do. The
 * repo is in writable territory (it edits its own code freely), so these are carved
 * back out as a HARD-DENY for writes — it can rewrite any of its source EXCEPT the
 * code that defines its safety boundary, even with approval. Changing these is a
 * by-hand job for the owner. Git is the undo for everything else.
 */
const GUARDRAIL_FILES = new Set([
  path.join(config.repoRoot, "src", "runtimes", "permissions.ts"),
  path.join(config.repoRoot, "src", "core", "config.ts"),
]);

/**
 * These paths are the whole boundary, so a typo or a moved file silently disarms it
 * (exactly what the src/ reorg did — they pointed at src/permissions.ts long after it
 * moved to src/runtimes/). Assert they exist at boot: a guardrail aimed at nothing is
 * worse than no guardrail, because it still reads as protection.
 */
for (const f of GUARDRAIL_FILES) {
  if (!fs.existsSync(f)) {
    throw new Error(
      `guardrail file missing: ${f} — permissions.ts is pointed at a path that doesn't exist, ` +
        `so writes to the real file would be unguarded. Fix GUARDRAIL_FILES before starting.`,
    );
  }
}

/** True if writing this path would touch a guardrail file or anything under config/. */
function isGuardrailPath(p: string): boolean {
  const abs = resolveAgentPath(p);
  if (GUARDRAIL_FILES.has(abs)) return true;
  return abs === config.configDir || abs.startsWith(config.configDir + path.sep);
}

/** Bash commands that MUTATE a guardrail file (reads like `cat permissions.ts` stay free). */
const GUARDRAIL_REF = /(?:^|[\s/'"])(?:src\/)?(?:permissions|config)\.ts\b|(?:^|[\s/'"])config\/\S/;

/**
 * A redirect only counts when it points AT a guardrail file. Matching a bare `>`
 * anywhere in the line is what denied a string of pure reads: `2>/dev/null`,
 * `2>&1`, and `awk 'NR>=600'` all "wrote" a guardrail file as far as the old
 * pattern was concerned. The operation is the redirect target, not the character.
 */
const REDIRECT_TO_GUARDRAIL = />>?\s*(?:\S*\/)?(?:permissions|config)\.ts\b|>>?\s*\S*config\/\S/;

/** Commands that mutate a file they name. Paired with GUARDRAIL_REF in the same segment. */
const BASH_MUTATION =
  /\btee\b|\bsed\b[^|]*\s-\w*i|\bperl\b[^|]*\s-\w*i|\bdd\b|\bmv\b|\bcp\b|\brm\b|\bln\b|\btruncate\b|\bpatch\b|\binstall\b/;

/**
 * True if a bash command both names a guardrail target and looks like it writes to one.
 * Judged per sub-command: a compound line like `grep X config.ts; awk 'NR>=6' y.ts`
 * reads a guardrail file in one segment and uses `>` in a different one, and testing
 * the whole string conflates them into a write that isn't there.
 */
function bashTouchesGuardrail(cmd: string): boolean {
  return cmd
    .split(/\|\||&&|[;|&\n]/)
    .some((seg) => REDIRECT_TO_GUARDRAIL.test(seg) || (GUARDRAIL_REF.test(seg) && BASH_MUTATION.test(seg)));
}

/**
 * Render a guardrail edit as something the owner can actually read on a phone.
 * An approval they can't see the contents of is a rubber stamp, so this is the
 * whole reason guardrail writes can ask at all instead of being denied.
 */
const GUARDRAIL_DIFF_LINES = 14;
function guardrailDiff(toolName: string, input: Record<string, unknown>): string {
  const clip = (s: string, tag: string) =>
    s
      .split("\n")
      .slice(0, GUARDRAIL_DIFF_LINES)
      .map((l) => `${tag} ${l}`)
      .join("\n") +
    (s.split("\n").length > GUARDRAIL_DIFF_LINES
      ? `\n${tag} … +${s.split("\n").length - GUARDRAIL_DIFF_LINES} more lines`
      : "");

  if (toolName === "Edit" || toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Record<string, unknown>[])
      : [input];
    return edits
      .map((e, i) => {
        const old = typeof e.old_string === "string" ? e.old_string : "";
        const next = typeof e.new_string === "string" ? e.new_string : "";
        const head = edits.length > 1 ? `edit ${i + 1}/${edits.length}\n` : "";
        return `${head}${clip(old, "-")}\n${clip(next, "+")}`;
      })
      .join("\n\n");
  }
  const content = typeof input.content === "string" ? input.content : "";
  return `overwrites the whole file:\n${clip(content, "+")}`;
}

/** Pull candidate filesystem paths out of a tool's input for guardrail checks. */
function inputPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string") paths.push(v);
  }
  if (toolName === "MultiEdit" && typeof input.file_path === "string") {
    paths.push(input.file_path);
  }
  return paths;
}

function bashCommand(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command : "";
}

/** " for $XX.XX" if the input carries an amount_cents, else "" — for AgentCard approval prompts. */
function moneyAmount(input: Record<string, unknown>): string {
  const cents = input.amount_cents;
  return typeof cents === "number" && cents > 0 ? ` for $${(cents / 100).toFixed(2)}` : "";
}

// The SDK's runtime schema requires `updatedInput` on an allow result (the TS type
// marks it optional, but Zod rejects it when absent). Pass the original input back
// unchanged to mean "allow as-is".
const allow = (input: Record<string, unknown>): PermissionResult => ({
  behavior: "allow",
  updatedInput: input,
});

/**
 * How long to hold a hot-file path lock after approving a write. The built-in Write/Edit
 * tools run inside the SDK harness (out-of-process), so canUseTool has no callback for
 * "the write finished" — we approve, then release the lock a bounded beat later, by which
 * point a small-markdown write has landed on disk. Advisory + best-effort by design (see
 * core/fileLock.ts). Only ever adds latency when BOTH lanes hit the SAME hot file within
 * the window — the rare case this whole thing exists for.
 */
const HOT_WRITE_SETTLE_MS = Math.max(0, Number(process.env.HOT_WRITE_SETTLE_MS || 1500));

/**
 * Serialize an approved write to one or more hot files across concurrent fig lanes (main
 * loop + a /btw background instance). Acquires each path's lock (sorted → stable order, no
 * cross-lane deadlock), approves, and schedules the release after the settle window.
 */
async function allowHotWrite(paths: string[], input: Record<string, unknown>): Promise<PermissionResult> {
  const uniq = [...new Set(paths)].sort();
  const releases = await Promise.all(uniq.map(acquireFileLock));
  setTimeout(() => {
    for (const r of releases) r();
  }, HOT_WRITE_SETTLE_MS);
  return allow(input);
}

const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

// --- Browser (Playwright MCP) permissions -----------------------------------
//
// One rule: STOP AT THE ONE-WAY DOOR. Everything else on the open web is free.
//
//   • Read, navigate, click, type, fill, scroll on ANY site: free, no prompt.
//   • Spending money or destroying something asks first — code, so an injected
//     page can't talk past it, and it can't be lowered by anything else in here.
//   • Credential/card/SSN entry asks (it rides a logged-in profile).
//   • Hard-deny (never, even with approval): non-http(s) schemes (file:, data:,
//     javascript:) and private/loopback/internal hosts — so a hijacked page can't
//     reach the relay, the mini, the LAN, or local files (SSRF).
//
// Deliberately NOT gated: getting to checkout (including "Buy now", which opens the
// review page), ticking/unticking items, changing the address or the card, filling a
// form. All pre-commit, all undone by another click. Prompting on those is what makes
// the real prompt worthless — seven 👍 for one small order is a gate you approve on
// reflex, which is not a gate.

/** Browser tools that only observe — never allowed to change anything. Always auto-allowed. */
const BROWSER_READ_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_tabs",
  "browser_wait_for",
  "browser_resize",
  "browser_install",
  "browser_close",
  "browser_navigate_back",
  "browser_find",
]);

/** Tools that act on the live page (the ones whose `element` text we frisk for one-way actions). */
const BROWSER_ACTION_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_file_upload",
  "browser_handle_dialog",
]);

/** Peekaboo tools that observe macOS state without directly changing it. */
const PEEKABOO_READ_TOOLS = new Set([
  "see",
  "image",
  "list",
  "tools",
  "capture",
  "sleep",
  "inspect_ui", // pure AX-tree observation — reads UI structure, changes nothing
]);

/** Peekaboo tools that mutate desktop/app state. */
const PEEKABOO_ACTION_TOOLS = new Set([
  "click",
  "type",
  "press",
  "hotkey",
  "paste",
  "scroll",
  "swipe",
  "drag",
  "move",
  "set_value",
  "perform_action",
  "window",
  "app",
  "space",
  "menu",
  "menubar",
  "dock",
  "dialog",
]);

/**
 * THE STOP LIST. One-way doors only: it spends real money, it destroys something,
 * or it says something publicly as the owner. Matched against the human-readable bits
 * of a browser/desktop action (element description, typed text, form values).
 *
 * The bar for adding a phrase here: if it fires and the owner 👍s without reading, the
 * list is too long. Every entry should be a button you'd want to be sure about.
 * Anything reversible by another click belongs nowhere near this list.
 *
 * Split into two halves (money/destroy, and speaks-outward) only so the auth-context
 * narrowing below can apply to the second WITHOUT ever touching the first. Ask the
 * combined question through isOneWayAction().
 */
const MONEY_OR_DESTROY = new RegExp(
  "\\b(?:" +
    [
      // spends money
      "place (?:your |the )?(?:order|bid)",
      "complete (?:your )?(?:purchase|order|payment)",
      "confirm (?:and pay|purchase|order|payment|booking|reservation)",
      "submit (?:order|payment)",
      "pay now",
      "make (?:a )?payment",
      "start (?:subscription|membership|plan|trial)",
      "subscribe",
      "donate",
      "book now",
      "reserve now",
      // destroys something
      "delete",
      "deactivate",
      "close account",
      "cancel (?:order|subscription|membership|plan|reservation|booking)",
      "transfer",
      "withdraw",
      "send money",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * The third door: it says something outward, as the owner, to someone else. Same bar as the
 * other two — a tweet can't be untweeted.
 *
 * `email` is deliberately NOT in the send-alternation. Actually sending mail as them is
 * gated a layer up by TOOL NAME (mcp__gmail__send, send_draft, mcp__agentmail__send_email
 * all ask, unconditionally), so this line was never the thing standing between fig and an
 * outbound email. What it did catch was a button literally labelled "Send email" on
 * GrubHub's login-code page — which mails the owner a 6-digit code, costs nothing, and
 * un-does itself in ten minutes. Note a bare `button "Send"` (gmail web's compose button)
 * never matched here either, so dropping `email` doesn't open a door that was shut.
 *
 * `post` carries a `(?!-)` because the hyphenated prefix is never the verb: "post-government",
 * "post-offer", "post-secondary", "post-graduate" are adjectives that show up all over job
 * applications and legal attestations. Without it, a plain dropdown on an employment
 * questionnaire fires a 🔐, and a stop list that cries wolf on a form field is a stop list the
 * owner starts 👍-ing without reading — which is the only real way this gate fails.
 */
const SPEAKS_OUTWARD = /\b(?:publish|post(?!-)|tweet|send (?:message|dm|invite))\b/i;

/**
 * "Buy now" is the ENTRANCE to checkout, not the purchase. On Amazon, eBay, Shopify and every
 * standard cart it lands on a review page, and that page's real button — "Place your order",
 * "Complete purchase", "Pay now", "Confirm and pay" — is still in MONEY_OR_DESTROY above. So
 * gating both spends two 👍 on one order, and the first one is a reflex approval on a page where
 * nothing has happened yet, which is exactly how the owner learns not to read the second.
 *
 * The one shape where it IS the money door is one-click ordering: "Buy now with 1-Click" charges
 * the card with no review page behind it. That stays gated, and it's the only reason a buy-now
 * pattern still exists in here.
 */
const ONE_CLICK_ORDER = /\b(?:buy|order|purchase)\b.{0,24}?\b(?:1|one)[- ]?click\b/i;

/**
 * Sign-in / verification / one-time-code context. Nothing here is a one-way door: mailing
 * yourself a login code is free and reverses itself, and none of it speaks to another
 * person as the owner.
 *
 * Scoped to SPEAKS_OUTWARD only — it can never wave through money or destruction, so a
 * checkout page that happens to say "verify" still stops at "Place your order". Entering
 * an actual code/password is a different gate (CREDENTIAL_FIELD) and still asks.
 */
const AUTH_CONTEXT =
  /\b(?:one[- ]?time (?:code|passcode|password)|otp|2fa|two[- ]factor|verification|verify|confirmation code|security code|login code|log[- ]?in code|sign[- ]?in code|magic link|resend|sign in|sign[- ]?in|log in|log[- ]?in|authenticat\w*)\b/i;

/**
 * The stop list as one question: is this a one-way door?
 *
 * `speaksOutward: false` drops only the third door, structurally — for a control that CANNOT
 * publish no matter what its options are labelled. Money and destruction are never narrowed by
 * anything, on any site.
 */
function isOneWayAction(text: string, opts: { speaksOutward?: boolean } = {}): boolean {
  if (MONEY_OR_DESTROY.test(text)) return true;
  if (ONE_CLICK_ORDER.test(text)) return true;
  if (opts.speaksOutward === false) return false;
  return SPEAKS_OUTWARD.test(text) && !AUTH_CONTEXT.test(text);
}

/**
 * A `<select>` can't speak outward. Picking an option changes local form state and nothing
 * leaves the page until a separate submit — which is itself an action tool, frisked in full. So
 * an employment questionnaire whose dropdown reads "Post-offer" or a country list containing
 * "Postal" stops raising a 🔐 that means nothing. Structural, not site-specific: it holds
 * everywhere because it's a fact about the control, not about the page.
 */
const NEVER_SPEAKS_OUTWARD = new Set(["browser_select_option"]);

/** Credential / payment-detail fields — the agent should never enter these without a 👍. */
const CREDENTIAL_FIELD = /\b(password|passcode|passphrase|cvv|cvc|security code|card number|credit card|debit card|expiration|\bssn\b|social security|routing number|account number|\bpin\b|one[- ]?time code|2fa|verification code)\b/i;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A private/loopback/internal host the browser must never reach (SSRF protection). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 — Tailscale (the relay + this box live here)
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback/link-local/ULA
  return false;
}

/** Why a navigation target is forbidden, or null if it's a fine public http(s) URL. */
function navTargetBlock(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.toLowerCase() === "about:blank") return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null; // unparseable/relative — let the tool deal with it
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return `${scheme}: links aren't allowed`;
  if (isPrivateHost(u.hostname)) return `${u.hostname} is a private/internal address`;
  return null;
}

/** Pull the human-readable strings out of a browser action's input for pattern matching. */
function browserActionText(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["element", "text", "value", "key"]) {
    const v = input[k];
    if (typeof v === "string") parts.push(v);
  }
  // browser_select_option passes `values: string[]` — the option text, which is the only
  // place a dropdown says what it does. Without this the money/destroy half never saw a
  // `<select>` at all.
  const values = (input as any).values;
  if (Array.isArray(values)) {
    for (const v of values) if (typeof v === "string") parts.push(v);
  }
  // browser_fill_form passes an array of {name, value}; sweep those too.
  const fields = (input as any).fields;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && typeof f === "object") {
        for (const v of Object.values(f)) if (typeof v === "string") parts.push(v);
      }
    }
  }
  return parts.join(" ");
}

function toolInputText(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(input);
  return parts.join(" ");
}

/** The label shown in the 🔐 — the raw button/element text, not a model's paraphrase. */
function actionLabel(input: Record<string, unknown>, text: string, fallback: string): string {
  const el = typeof input.element === "string" ? input.element.trim() : "";
  return el || text.trim().slice(0, 80) || fallback;
}

/**
 * File uploads to a webpage can exfiltrate data off the machine, so external/unknown
 * paths always confirm. But our OWN generated files — carousel slides, generated
 * images, anything under ~/scratch — are safe, and prompting once per image on every
 * post makes autonomous posting impossible. So an upload is auto-allowed only when
 * EVERY path in the call resolves inside a safe root.
 */
const SAFE_UPLOAD_ROOTS: string[] = (() => {
  const home = process.env.HOME || "";
  if (!home) return [];
  return [
    path.resolve(home, "scratch"), // fig's scratch/temp workspace (carousel out, generated images)
    path.resolve(home, "Documents/Resumes"), // apply-pipeline resume builds — fig-generated, uploaded to job portals constantly
    // Personal-lane roots (the spot repo's marketing outputs) come through the seam so
    // a public checkout doesn't carry a safe root for a repo it doesn't have.
    ...spotLane.safeUploadRoots(),
  ];
})();

/** Pull every absolute/~-rooted filesystem path out of a tool input, field-name-agnostic. */
function extractUploadPaths(input: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s.startsWith("/") || s.startsWith("~/")) found.push(s);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(input);
  return found;
}

/** True only if the path resolves (after normalizing `..`) inside a safe upload root. */
function isSafeUploadPath(p: string): boolean {
  const home = process.env.HOME || "";
  const expanded = p.startsWith("~/") && home ? path.join(home, p.slice(2)) : p;
  const norm = path.resolve(expanded); // collapses any ../ traversal
  return SAFE_UPLOAD_ROOTS.some((root) => norm === root || norm.startsWith(root + path.sep));
}

/**
 * Reddit outreach carve-out. fig runs a dedicated throwaway reddit account for
 * hand-to-hand user outreach; its whole job is upvoting and posting helpful comments, so
 * prompting the owner on every single one makes the account unusable — and
 * "post"/"send"/"delete" are exactly the tokens that fly on reddit.
 *
 * So auto-allow ONLY the two low-stakes outreach actions — upvoting and submitting a
 * comment/reply — and ONLY on the main reddit web app. Everything else on reddit still
 * asks: DMs/chat, deleting, account-settings changes, reporting, moderation. And this is
 * scoped to reddit.com alone — no effect on any other site.
 *
 * NOTE: the permission gate can't read the logged-in username from the action input, so
 * this keys on host + action type, not the account literally. That holds only because fig's
 * Chrome profile has ONLY the outreach account signed into reddit (the owner's personal
 * reddit is not logged into this browser) — so a reddit action here IS the outreach account
 * by construction. Sign the owner's own account into this profile and the carve-out is wrong.
 */
const REDDIT_OUTREACH_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"]);
/** Upvote button, or a comment/reply submit button. */
const REDDIT_ALLOWED_ACTION = /\b(upvote|comment|reply)\b/i;
/** Anything that must still ask, even if the same text also mentions comment/reply. */
const REDDIT_STILL_ASK =
  /\b(downvote|dm|message|chat|send|delete|remove|deactivate|close account|settings|report|block|ban|mod|subscribe|premium|award|gild|save card|payment)\b/i;

/** True only for the outreach account's benign actions: upvote + comment/reply on reddit.com. */
function isRedditOutreachAction(host: string | null, text: string): boolean {
  if (!host || !REDDIT_OUTREACH_HOSTS.has(host)) return false; // chat.reddit.com etc. deliberately excluded → still asks
  if (REDDIT_STILL_ASK.test(text)) return false; // DMs/deletes/settings/etc. always ask
  return REDDIT_ALLOWED_ACTION.test(text);
}

/**
 * Decide a browser tool call. `getDomain`/`setDomain` thread the "current page
 * domain" through the turn: navigate sets it, actions are judged against it. Only
 * the reddit carve-out reads it now — the stop list is domain-independent on purpose,
 * because a purchase button is a purchase button wherever it lives.
 */
async function decideBrowser(
  toolName: string,
  input: Record<string, unknown>,
  askOwner: (q: string) => Promise<boolean>,
  getDomain: () => string | null,
  setDomain: (d: string | null) => void,
): Promise<PermissionResult> {
  const name = toolName.slice("mcp__browser__".length);

  if (BROWSER_READ_TOOLS.has(name)) return allow(input);

  // browser_evaluate: free. The prompt it used to raise was noise — the truly
  // consequential paths (the one-way stop list, credential entry, and SSRF nav
  // targets) are gated by their own checks below, so a confirm on "this JS looks
  // mutating" just got waved through every time without adding real protection.
  if (name === "browser_evaluate") return allow(input);

  // Same treatment as browser_evaluate — the arbitrary-JS path. Used by the
  // derive-a-client exporters.
  if (name === "browser_run_code_unsafe") return allow(input);

  // Issues an HTTP request from the page's session. Free for public http(s) targets
  // (this is how the exporters pull authed data); hard-deny private/internal/non-http
  // so a hijacked page can't SSRF the LAN/relay.
  if (name === "browser_network_request") {
    const url = typeof input.url === "string" ? input.url : "";
    const blocked = url ? navTargetBlock(url) : null;
    if (blocked) {
      log(`HARD-DENY network_request: ${blocked}`);
      return deny(`Can't hit that — ${blocked}.`);
    }
    return allow(input);
  }

  if (name === "browser_navigate") {
    const url = typeof input.url === "string" ? input.url : "";
    const blocked = navTargetBlock(url);
    if (blocked) {
      log(`HARD-DENY navigate: ${blocked}`);
      return deny(`Can't open that — ${blocked}. The browser is limited to public web pages.`);
    }
    setDomain(hostnameOf(url)); // open web: free to read/navigate
    return allow(input);
  }

  // File uploads (file-picker or drag-drop). Auto-allow only when every path in the
  // call is our own generated file inside a safe root; anything external still asks.
  if (name === "browser_file_upload" || name === "browser_drop") {
    const paths = extractUploadPaths(input);
    if (paths.length > 0 && paths.every(isSafeUploadPath)) {
      log(`auto-allow upload (safe local dir): ${paths.map((p) => path.basename(p)).join(", ")}`);
      return allow(input);
    }
    log(`ask: ${name}${paths.length ? " (external/unverified path)" : " (no path in input)"}`);
    const ok = await askOwner("Let the browser upload a file to this page?");
    return ok ? allow(input) : deny("You declined the upload.");
  }

  if (BROWSER_ACTION_TOOLS.has(name)) {
    const text = browserActionText(input);

    // Credential / payment-detail entry — never without a 👍 (it rides your logged-in profile).
    if (CREDENTIAL_FIELD.test(text)) {
      log("ask: credential/payment field entry");
      const ok = await askOwner("The browser wants to enter sensitive info (password/card/code). Allow?");
      return ok ? allow(input) : deny("You declined entering credentials.");
    }
    // Reddit outreach carve-out: the outreach account's upvotes + comment/reply submits on
    // reddit.com auto-allow (they'd otherwise trip the stop list on "post"/"reply").
    // Tightly scoped — DMs/deletes/settings and every other site still fall through.
    if (isRedditOutreachAction(getDomain(), text)) {
      log(`auto-allow reddit outreach action: "${text.slice(0, 60)}"`);
      return allow(input);
    }
    // The one-way door: spends money, destroys something, or speaks outward. Always asks.
    if (isOneWayAction(text, { speaksOutward: !NEVER_SPEAKS_OUTWARD.has(name) })) {
      const label = actionLabel(input, text, name);
      log(`ask: one-way browser action "${label}"`);
      const ok = await askOwner(`Confirm browser action: "${label}"?`);
      if (!ok) log(`denied: one-way action "${label}"`);
      return ok ? allow(input) : deny("You declined that action.");
    }
    // Everything else on the open web is free.
    return allow(input);
  }

  // Unknown browser tool we haven't classified — judged by the same stop list, since
  // "is this a one-way door" is the only question this gate answers.
  const text = browserActionText(input) || toolInputText(input);
  if (isOneWayAction(text)) {
    const label = actionLabel(input, text, name);
    log(`ask: one-way action via unclassified browser tool ${name} — "${label}"`);
    const ok = await askOwner(`Confirm browser action: "${label}"?`);
    return ok ? allow(input) : deny(`You declined ${name}.`);
  }
  return allow(input);
}

async function decidePeekaboo(
  toolName: string,
  input: Record<string, unknown>,
  askOwner: (q: string) => Promise<boolean>,
): Promise<PermissionResult> {
  const name = toolName.slice("mcp__peekaboo__".length);

  if (PEEKABOO_READ_TOOLS.has(name)) return allow(input);

  if (name === "permissions") {
    const text = toolInputText(input);
    if (!text || /\b(status|list|check)\b/i.test(text)) return allow(input);
    log("ask: Peekaboo permissions action");
    const ok = await askOwner("Use Peekaboo permissions tool?");
    return ok ? allow(input) : deny(`You declined Peekaboo ${name}.`);
  }

  if (PEEKABOO_ACTION_TOOLS.has(name)) {
    const text = toolInputText(input);
    if (CREDENTIAL_FIELD.test(text)) {
      log("ask: Peekaboo credential/payment field entry");
      const ok = await askOwner("Peekaboo wants to enter sensitive info (password/card/code). Allow?");
      return ok ? allow(input) : deny("You declined entering credentials.");
    }
    if (isOneWayAction(text)) {
      const label = actionLabel(input, text, name);
      log(`ask: one-way Peekaboo action "${label}"`);
      const ok = await askOwner(`Confirm desktop action: "${label}"?`);
      if (!ok) log(`denied: one-way Peekaboo action "${label}"`);
      return ok ? allow(input) : deny("You declined that desktop action.");
    }
    return allow(input);
  }

  // Unknown Peekaboo tool — it drives the whole desktop, so ask once rather than guess.
  log(`ask: unclassified Peekaboo tool ${name}`);
  const ok = await askOwner(`Use Peekaboo desktop tool ${name}?`);
  return ok ? allow(input) : deny(`You declined Peekaboo ${name}.`);
}

/**
 * Build the canUseTool callback. `askOwner` sends a yes/no question over the
 * active transport and resolves true on approval. It's injected so permissions
 * stays transport-agnostic.
 *
 * Typed as `Approver` — `(question, prompt?)` — so a gate in here can attach a SYSTEM-built
 * preview to the prompt it raises (the rendered card on the ordering-CLI money path). The second
 * parameter is optional, so every existing caller passing a plain `(q) => Promise<boolean>` is
 * unchanged, and no agent surface can set it: `ApprovalPrompt` is filled in by code paths only.
 */
export function makeCanUseTool(askOwner: Approver): CanUseTool {
  // Per-callback (per-turn) state: the domain the browser is currently on, set by
  // navigation and read by the reddit carve-out. Reset between turns since each turn
  // gets a fresh callback.
  let browserDomain: string | null = null;

  return async (toolName, input): Promise<PermissionResult> => {
    // Tier 3: hard-deny — a static blocklist, regardless of any approval.
    if (toolName === "Bash") {
      const cmd = bashCommand(input);
      for (const re of HARD_DENY_PATTERNS) {
        if (re.test(cmd)) {
          log(`HARD-DENY bash: ${cmd.slice(0, 80)}`);
          return deny(
            "That command is on the permanent blocklist and can't be run, even with approval.",
          );
        }
      }
      if (bashTouchesGuardrail(cmd)) {
        log(`HARD-DENY bash: writes a guardrail file — ${cmd.slice(0, 80)}`);
        return deny(
          "That command writes to one of my own guardrail files (permissions.ts / config.ts / config/), which is permanently off-limits even with approval. The owner edits those by hand.",
        );
      }
    }

    // Guardrail files: ASK, with the diff shown. The repo is writable territory,
    // so the agent edits its own code freely — but the code defining its own
    // safety boundary never changes without the owner reading the change first.
    // Structured edits only (Write/Edit), because those carry the new text and
    // can be rendered. A bash mutation is opaque, so it stays hard-denied above:
    // never approve what can't be shown.
    if (WRITE_TOOLS.has(toolName)) {
      const guarded = inputPaths(toolName, input).filter(isGuardrailPath);
      if (guarded.length > 0) {
        const resolved = guarded.map(resolveAgentPath).join(", ");
        const file = path.basename(guarded[0]!);
        log(`ASK ${toolName}: guardrail file (${resolved})`);
        const approved = await askOwner(
          `Edit my own guardrail file ${file}?\n\n${guardrailDiff(toolName, input)}`,
        );
        if (!approved) {
          log(`DENIED ${toolName}: guardrail file (${resolved})`);
          return deny("the owner said no — guardrail file left alone.");
        }
        log(`APPROVED ${toolName}: guardrail file (${resolved})`);
      }
    }

    // Tier 1a: reads are always fine.
    if (READ_ONLY_TOOLS.has(toolName)) return allow(input);
    if (toolName === "Skill") return allow(input);

    // Tier 1b: ordinary filesystem writes are allowed anywhere. The permanent
    // guardrail carveout above still blocks edits to permissions/config files. A write
    // that targets a HOT file (today's Health/nutrition + Health/sleep log, the three open-loop lists)
    // is still allowed, but serialized through a per-path lock so a concurrent /btw lane
    // can't clobber the main loop's write to the same file (and vice versa).
    if (WRITE_TOOLS.has(toolName)) {
      const hot = inputPaths(toolName, input).map(resolveAgentPath).filter(isHotFile);
      if (hot.length > 0) return allowHotWrite(hot, input);
      return allow(input);
    }

    // Minting/funding an AgentCard spends real money - always confirm first.
    if (toolName === "Bash") {
      const cmd = bashCommand(input);
      if (/\bagent-cards\s+(cards\s+create|wallet\s+fund)\b/.test(cmd)) {
        log(`ask: agent-card mint/fund - ${cmd.slice(0, 80)}`);
        const approved = await askOwner("Mint/fund an AgentCard? (real money)");
        if (!approved) {
          log("denied: agent-card mint/fund");
          return deny("Card mint/fund declined.");
        }
        return allow(input);
      }
    }

    // The ORDERING CLI's money door. `~/GitHub/web-export`'s `order place` is the one Bash verb
    // on this box that charges a card, and until this landed it ran through the "Bash: lax"
    // hole below with no 🔐 at all (Pending/guardrail-gate.md, "FIFTH bug"). Read-only verbs —
    // `order cart`, `order describe`, `order menu` — are deliberately untouched: they build or
    // read a cart and nothing more, and gating them is exactly the over-prompting this gate avoids.
    //
    // This is the lane the guardrail note calls a MAPPED PATH: the gate isn't guessing at a
    // button label, it holds a named command and a cart id, so the prompt renders the real order
    // — items, store, pickup time, total, card — off the server. See webExport/orderGate.ts.
    //
    // Fails CLOSED in every direction: a 👎 denies, a timeout denies (askOwner resolves false
    // after APPROVAL_TIMEOUT_MS), an unattended lane denies (no approver → denyApprovals), and a
    // throw anywhere in building the prompt denies rather than falling through to allow.
    if (toolName === "Bash") {
      const inv = orderPlaceInvocation(bashCommand(input));
      if (inv) {
        let approved = false;
        try {
          const { question, image } = await buildOrderApproval(inv);
          log(`ask: order place (money) — ${inv.segment.slice(0, 80)}`);
          approved = await askOwner(question, { image });
        } catch (e) {
          log(`denied: order place — the gate itself failed (${e instanceof Error ? e.message : e})`);
          return deny(
            "I couldn't raise the purchase approval, so I did NOT place the order. Nothing was charged.",
          );
        }
        if (!approved) {
          log(`denied: order place — ${inv.segment.slice(0, 80)}`);
          return deny("You didn't approve the purchase, so the order was NOT placed. Nothing was charged.");
        }
        log(`approved: order place — ${inv.segment.slice(0, 80)}`);
        return allow(input);
      }
    }

    // Bash: lax for now. Anything not caught by the hard-deny blocklist above is
    // allowed without asking. Tighten later if it ever matters.
    if (toolName === "Bash") return allow(input);

    // Browser (Playwright MCP): open web is free; the one-way stop list always asks.
    if (toolName.startsWith("mcp__browser__")) {
      return decideBrowser(
        toolName,
        input,
        askOwner,
        () => browserDomain,
        (d) => {
          browserDomain = d;
        },
      );
    }

    // Peekaboo (macOS GUI automation): scoped to the browse specialist. It can see
    // and drive the whole desktop, so unknown/broad operations ask, while routine
    // fallback clicks/types remain usable.
    if (toolName.startsWith("mcp__peekaboo__")) {
      return decidePeekaboo(toolName, input, askOwner);
    }

    // MCP tools: allowed (you connected them deliberately), except outward-facing
    // ones we want a 👍 on. Sending email is hard to reverse, so confirm it.
    if (toolName.startsWith("mcp__")) {
      if (toolName === "mcp__gmail__send") {
        const to = typeof input.to === "string" ? input.to : "?";
        const subject = typeof input.subject === "string" ? input.subject : "";
        log(`ask: send email to ${to}`);
        const approved = await askOwner(`Send email to ${to}: "${subject}"?`);
        if (!approved) log(`denied: send email to ${to}`);
        return approved ? allow(input) : deny("You declined sending the email.");
      }
      // Same gate on the owner's non-Gmail accounts. The FROM address is in the prompt
      // because this one sends as a different identity than gmail does (their own domain),
      // and that's the part they'd want to catch before saying yes.
      if (toolName === "mcp__outlook__send") {
        const to = typeof input.to === "string" ? input.to : "?";
        const subject = typeof input.subject === "string" ? input.subject : "";
        const key = typeof input.account === "string" ? input.account.trim().toLowerCase() : "";
        const account = key ? getAccounts().find((a) => a.key === key) : undefined;
        const from = account ? ` from ${account.accountName}` : "";
        log(`ask: send email to ${to}${from}`);
        const approved = await askOwner(`Send email to ${to}${from}: "${subject}"?`);
        if (!approved) log(`denied: send email to ${to}`);
        return approved ? allow(input) : deny("You declined sending the email.");
      }
      // Sending a saved draft by id — same outward-facing gate as send. Look up the draft
      // so the confirm shows who/what, not just an opaque id.
      if (toolName === "mcp__gmail__send_draft") {
        const draftId = typeof input.draft_id === "string" ? input.draft_id : "";
        const account = typeof input.account === "string" ? input.account : "";
        let to = "?";
        let subject = "";
        try {
          const d = await getDraft(draftId, account);
          to = d.to || "?";
          subject = d.subject;
        } catch {
          /* fall back to the bare id in the prompt */
        }
        log(`ask: send draft ${draftId} to ${to}`);
        const approved = await askOwner(
          to === "?" ? `Send saved draft ${draftId}?` : `Send email to ${to}: "${subject}"?`,
        );
        if (!approved) log(`denied: send draft ${draftId}`);
        return approved ? allow(input) : deny("You declined sending the email.");
      }
      // AgentCard (fig's own virtual Visa cards): reads — list_cards, check_balance,
      // list_transactions, get_plan, get_mode, list_payment_methods, detect_checkout,
      // read_support_chat — are free. Anything that spends, reveals card numbers, is
      // irreversible, or touches billing/identity routes a 🔐 to the owner.
      if (toolName.startsWith("mcp__agent-cards__")) {
        const action = toolName.slice("mcp__agent-cards__".length);
        const gated: Record<string, (i: Record<string, unknown>) => string> = {
          create_card: (i) => `Mint a virtual card${moneyAmount(i)} on fig's account?`,
          pay_checkout: (i) => `Create a card${moneyAmount(i)} and pay this checkout?`,
          fill_card: () => "Fill fig's card into this checkout form?",
          get_card_details: () => "Reveal fig's full card number + CVV?",
          close_card: () => "Permanently close this card? (irreversible)",
          set_mode: (i) =>
            i.mode === "prod" ? "Switch AgentCard to PROD — real cards that draw on the real payment method?" : "",
          submit_user_info: () => "Submit fig's identity info (KYC) and accept the cardholder terms?",
          upgrade_plan: () => "Upgrade fig's AgentCard plan (paid)?",
          cancel_plan: () => "Cancel fig's paid AgentCard plan?",
          setup_payment_method: () => "Set up a new funding payment method on fig's AgentCard?",
          remove_payment_method: () => "Remove a saved payment method from fig's AgentCard?",
          set_default_payment_method: () => "Change which payment method funds fig's new cards?",
          approve_request: () => "Approve this pending AgentCard request?",
        };
        const ask = gated[action]?.(input);
        if (ask) {
          log(`ask: agent-cards ${action}`);
          const approved = await askOwner(ask);
          if (!approved) log(`denied: agent-cards ${action}`);
          return approved ? allow(input) : deny(`You declined ${action}.`);
        }
        return allow(input); // read-only / non-spending tool
      }

      // Sending from fig's own AgentMail inbox is outward-facing too — confirm it.
      // (Creating inboxes and reading mail stay free so burner signups don't pester them.)
      if (toolName === "mcp__agentmail__send_email") {
        const to = typeof input.to === "string" ? input.to : "?";
        const subject = typeof input.subject === "string" ? input.subject : "";
        log(`ask: send agentmail to ${to}`);
        const approved = await askOwner(`Send email from fig's inbox to ${to}: "${subject}"?`);
        if (!approved) log(`denied: send agentmail to ${to}`);
        return approved ? allow(input) : deny("You declined sending the email.");
      }
      // Destructive asks name the THING, never its id. An opaque id is unanswerable —
      // the owner can't approve deleting something they can't identify — so both of these
      // resolve the id to a human description first and only fall back to the id when
      // that lookup fails.
      if (toolName === "mcp__gmail__trash") {
        const id = typeof input.id === "string" ? input.id : "?";
        const account = typeof input.account === "string" ? input.account : undefined;
        let what = "";
        try {
          const m = await getMessage(id, account);
          const subject = m.subject?.trim() || "(no subject)";
          what = m.from ? `"${subject}" from ${m.from}` : `"${subject}"`;
        } catch {
          /* fall back to the bare id in the prompt */
        }
        log(`ask: trash email ${id}`);
        const approved = await askOwner(what ? `Move ${what} to trash?` : `Move email ${id} to trash?`);
        if (!approved) log(`denied: trash ${id}`);
        return approved ? allow(input) : deny("You declined trashing the email.");
      }
      if (toolName === "mcp__calendar__delete") {
        const id = typeof input.id === "string" ? input.id : "?";
        const what = await describeEvent(
          id,
          typeof input.calendar_id === "string" ? input.calendar_id : undefined,
          typeof input.account === "string" ? input.account : undefined,
        );
        log(`ask: delete event ${id}`);
        const approved = await askOwner(what ? `Delete ${what}?` : `Delete calendar event ${id}?`);
        if (!approved) log(`denied: delete event ${id}`);
        return approved ? allow(input) : deny("You declined deleting the event.");
      }
      // Creating/updating an event that emails invites is outward-facing — confirm it.
      if (
        (toolName === "mcp__calendar__create" || toolName === "mcp__calendar__update") &&
        input.notify_attendees === true
      ) {
        const summary = typeof input.summary === "string" ? input.summary : "this event";
        log(`ask: email invites for ${toolName}`);
        const approved = await askOwner(`Email calendar invites to attendees for "${summary}"?`);
        if (!approved) log(`denied: invites for ${toolName}`);
        return approved ? allow(input) : deny("You declined sending invites.");
      }
      return allow(input);
    }

    log(`ask: ${toolName}`);
    const approved = await askOwner(`Use tool ${toolName}?`);
    if (!approved) log(`denied: ${toolName}`);
    return approved ? allow(input) : deny(`You declined ${toolName}.`);
  };
}
