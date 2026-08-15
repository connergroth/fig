import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Page } from "playwright";

import { config } from "../core/config";

const execFileAsync = promisify(execFile);

/**
 * A login step. The injector runs these in order, INSIDE the shared Playwright page,
 * so multi-page flows work (Amazon: email → Continue → password on a second page).
 *   fill    — type a secret (resolved from Bitwarden, never seen by the model) into a selector
 *   click   — click a button (e.g. "Continue"); `optional` swallows a not-found
 *   waitFor — wait for a selector to appear (e.g. the password field after the email step)
 * Before every `fill` the injector re-verifies the live page origin and fails closed, so a
 * mid-flow redirect off the allowlist can never receive a secret.
 */
type FillStep =
  | { fill: "username" | "password" | "totp"; selector: string }
  | { click: string; optional?: boolean }
  | { waitFor: string; timeoutMs?: number };

type CredentialHandle = {
  item: string;
  allowedOrigins: string[];
  submit?: boolean;
  /** Explicit step sequence; omit for a generic single-page username+password fill. */
  steps?: FillStep[];
  /** Selectors for the default (no-steps) flow. */
  usernameSelector?: string;
  passwordSelector?: string;
  /** Submit button selector; if absent and submit is on, the injector presses Enter. */
  submitSelector?: string;
};

type BitwardenItem = {
  login?: {
    username?: string;
    password?: string;
  };
};

const handlesPath = path.join(config.configDir, "credential-handles.json");

const DEFAULT_USERNAME_SELECTOR =
  "input[type='email'], input[name='email'], input[name='username'], input[autocomplete='username'], input#ap_email, input#ap_email_login";
const DEFAULT_PASSWORD_SELECTOR = "input[type='password'], input#ap_password";

function isFillStep(v: unknown): v is FillStep {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if ("fill" in o) return o.fill === "username" || o.fill === "password" || o.fill === "totp";
  if ("click" in o) return typeof o.click === "string";
  if ("waitFor" in o) return typeof o.waitFor === "string";
  return false;
}

function readHandles(): Record<string, CredentialHandle> {
  const raw = fs.readFileSync(handlesPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, CredentialHandle> = {};
  for (const [handle, value] of Object.entries(parsed)) {
    if (handle.startsWith("_")) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as Partial<CredentialHandle>;
    if (typeof v.item !== "string" || !Array.isArray(v.allowedOrigins)) continue;
    const allowedOrigins = v.allowedOrigins.filter((o): o is string => typeof o === "string");
    if (!allowedOrigins.length) continue;
    const steps = Array.isArray(v.steps) ? v.steps.filter(isFillStep) : undefined;
    out[handle] = {
      item: v.item,
      allowedOrigins,
      submit: v.submit === true,
      ...(steps && steps.length ? { steps } : {}),
      ...(typeof v.usernameSelector === "string" ? { usernameSelector: v.usernameSelector } : {}),
      ...(typeof v.passwordSelector === "string" ? { passwordSelector: v.passwordSelector } : {}),
      ...(typeof v.submitSelector === "string" ? { submitSelector: v.submitSelector } : {}),
    };
  }
  return out;
}

function normalizeOrigin(raw: string): string {
  const u = new URL(raw);
  return u.origin.toLowerCase();
}

function originAllowed(currentUrl: string, allowedOrigins: string[]): boolean {
  let current: string;
  try {
    current = normalizeOrigin(currentUrl);
  } catch {
    return false; // about:blank / non-URL — never allowed
  }
  return allowedOrigins.some((origin) => current === normalizeOrigin(origin));
}

// Cached unlocked session key for this process. Bitwarden session keys don't
// expire by clock, but a restart or an explicit lock drops them, so we mint on
// demand and reuse.
let cachedSession = "";

async function bwStatus(): Promise<"unauthenticated" | "locked" | "unlocked" | string> {
  try {
    const { stdout } = await execFileAsync("bw", ["status"], { timeout: 10_000, maxBuffer: 65_536 });
    const parsed = JSON.parse(stdout) as { status?: string };
    return parsed.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Return an unlocked Bitwarden session key, minting one if needed.
 *
 * Priority:
 *   1. A working cached session (from a prior call this process).
 *   2. BW_SESSION from env — the hand-pasted escape hatch (still supported).
 *   3. Self-unlock from env: `bw login --apikey` (BW_CLIENTID/BW_CLIENTSECRET) if
 *      unauthenticated, then `bw unlock --passwordenv BW_PASSWORD --raw`. This is
 *      the robust path for the long-running daemon — survives restarts, no stale
 *      session to babysit. None of these secrets ever enter the model context.
 */
async function ensureSession(): Promise<string> {
  if (cachedSession) return cachedSession;

  const envSession = process.env.BW_SESSION?.trim();
  if (envSession) {
    cachedSession = envSession;
    return cachedSession;
  }

  const masterPass = process.env.BW_PASSWORD?.trim();
  if (!masterPass) {
    throw new Error(
      "Bitwarden is locked and no credentials are set. Provide BW_SESSION, or BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD in .env so the injector can self-unlock.",
    );
  }

  const status = await bwStatus();
  if (status === "unauthenticated") {
    const clientId = process.env.BW_CLIENTID?.trim();
    const clientSecret = process.env.BW_CLIENTSECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error("Bitwarden is unauthenticated and BW_CLIENTID/BW_CLIENTSECRET are not set for apikey login.");
    }
    await execFileAsync("bw", ["login", "--apikey"], {
      env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
      timeout: 30_000,
      maxBuffer: 65_536,
    });
  }

  const { stdout } = await execFileAsync("bw", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
    env: { ...process.env, BW_PASSWORD: masterPass },
    timeout: 30_000,
    maxBuffer: 65_536,
  });
  cachedSession = stdout.trim();
  if (!cachedSession) throw new Error("bw unlock returned an empty session key");
  return cachedSession;
}

/** Run a `bw` read with a fresh session, dropping + re-minting once on a stale-session error. */
async function withSession<T>(run: (session: string) => Promise<T>): Promise<T> {
  const session = await ensureSession();
  try {
    return await run(session);
  } catch (err) {
    cachedSession = "";
    if (!process.env.BW_PASSWORD?.trim()) throw err;
    return await run(await ensureSession());
  }
}

async function bitwardenItem(item: string): Promise<BitwardenItem> {
  return withSession(async (session) => {
    const { stdout } = await execFileAsync("bw", ["get", "item", item, "--session", session], {
      env: { ...process.env, BW_SESSION: session },
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    return JSON.parse(stdout) as BitwardenItem;
  });
}

/** The current TOTP code for an item, computed by Bitwarden — never exposed to the model. */
async function bitwardenTotp(item: string): Promise<string> {
  return withSession(async (session) => {
    const { stdout } = await execFileAsync("bw", ["get", "totp", item, "--session", session], {
      env: { ...process.env, BW_SESSION: session },
      timeout: 15_000,
      maxBuffer: 65_536,
    });
    const code = stdout.trim();
    if (!code) throw new Error("Bitwarden returned no TOTP for this item (no 2FA seed stored)");
    return code;
  });
}

function defaultSteps(cfg: CredentialHandle): FillStep[] {
  return [
    { fill: "username", selector: cfg.usernameSelector ?? DEFAULT_USERNAME_SELECTOR },
    { fill: "password", selector: cfg.passwordSelector ?? DEFAULT_PASSWORD_SELECTOR },
  ];
}

/**
 * The browse run's OWN tab (browser.ts holds the Page openJobTab handed this job).
 *
 * The injector fills in-process, beside @playwright/mcp rather than through it, so it used to
 * re-guess the tab with activeBrowserPage() — "whatever's frontmost in the shared Chrome". With a
 * second job open that lands on someone else's page, where the origin check then fails closed and
 * the model reports "I can't type passwords here": a false capability report caused by a wrong
 * tab, not by policy (observed 2026-08-13). Binding the page removes the guess entirely; the
 * origin assert below stays exactly as it was, now guarding the right surface.
 */
export type JobPageGetter = () => Page | null;

export function makeCredentialsServer(getJobPage: JobPageGetter) {
  return createSdkMcpServer({
    name: "credentials",
    version: "2.0.0",
    tools: [
      tool("list_handles", "List credential handles available to the browser specialist. This never returns usernames or passwords.", {}, async () => {
        const handles = readHandles();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                Object.fromEntries(
                  Object.entries(handles).map(([handle, cfg]) => [
                    handle,
                    { allowedOrigins: cfg.allowedOrigins, submitsAfterFill: cfg.submit === true, multiStep: !!cfg.steps },
                  ]),
                ),
                null,
                2,
              ),
            },
          ],
        };
      }),
      tool(
        "fill_login",
        "Fill a login form with an allowed Bitwarden credential WITHOUT exposing the username, password, or 2FA code to the model. Navigate YOUR OWN tab to the real login page first (the page with the username/email field). The injector reads the URL of that tab — the one this job was given, never whichever tab is frontmost — verifies its origin against the handle's allowlist, then DOM-fills the fields there, handling multi-page flows (e.g. Amazon's email → Continue → password) and TOTP if configured. It returns only status.",
        {
          handle: z.string().describe("credential handle from config/credential-handles.json, e.g. amazon"),
          submit: z.boolean().optional().describe("override whether to submit after filling; defaults to the handle config"),
        },
        async (args) => {
          // This job's bound tab, never a guess, and checked before anything else — no tab means
          // there is nothing to origin-check, so there's nothing safe to do. No fallback to the
          // frontmost page: typing a secret into a tab that isn't yours is the failure being
          // eliminated, and a refusal the model can act on beats a fill on a stranger's page.
          const page = getJobPage();
          if (!page || page.isClosed()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Can't fill ${args.handle}: YOUR browser tab is gone (closed, or this run never got one). Nothing was typed and no secret was read. Open a tab, navigate to the login page, and call fill_login again.`,
                },
              ],
            };
          }

          const handles = readHandles();
          const cfg = handles[args.handle];
          if (!cfg) throw new Error(`unknown credential handle: ${args.handle}`);

          // Origin binding comes from the Playwright page itself — the exact tab the model
          // is driving — re-checked before every secret entry. Fail closed BEFORE any
          // Bitwarden read so no plaintext moves unless the origin is on the allowlist.
          const assertOrigin = (): string => {
            const url = page.url();
            if (!originAllowed(url, cfg.allowedOrigins)) {
              let shown = url;
              try {
                shown = normalizeOrigin(url);
              } catch {
                /* keep raw */
              }
              throw new Error(`refusing to fill ${args.handle}: active origin ${shown} is not in the allowlist`);
            }
            return normalizeOrigin(url);
          };
          const origin = assertOrigin();

          const item = await bitwardenItem(cfg.item);
          const username = item.login?.username;
          const password = item.login?.password;
          if (!username || !password) throw new Error(`Bitwarden item for ${args.handle} has no login username/password`);

          const secretFor = async (field: "username" | "password" | "totp"): Promise<string> => {
            if (field === "username") return username;
            if (field === "password") return password;
            return bitwardenTotp(cfg.item);
          };

          const steps = cfg.steps ?? defaultSteps(cfg);
          for (const step of steps) {
            if ("waitFor" in step) {
              await page.waitForSelector(step.waitFor, { state: "visible", timeout: step.timeoutMs ?? 8000 });
            } else if ("click" in step) {
              try {
                await page.click(step.click, { timeout: 5000 });
              } catch (e) {
                if (!step.optional) throw e;
              }
            } else {
              assertOrigin(); // re-verify right before typing a secret
              const value = await secretFor(step.fill);
              const loc = page.locator(step.selector).first();
              await loc.waitFor({ state: "visible", timeout: 8000 });
              await loc.fill(value);
            }
          }

          const doSubmit = args.submit ?? cfg.submit === true;
          if (doSubmit) {
            assertOrigin();
            if (cfg.submitSelector) {
              await page.click(cfg.submitSelector, { timeout: 5000 });
            } else {
              // No explicit submit button — press Enter in the focused field rather than a
              // blind global keystroke; the secret was just typed, so focus is on the form.
              await page.keyboard.press("Enter");
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, handle: args.handle, origin, submitted: doSubmit }),
              },
            ],
          };
        },
      ),
    ],
  });
}
