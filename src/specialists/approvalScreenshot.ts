import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Page } from "playwright";

import type { ApprovalPrompt, Approver } from "./approval";
import { cdpEndpoint } from "../browser/chrome";
import { log, warn } from "../core/log";
import { makeCanUseTool } from "../runtimes/permissions";

const run = promisify(execFile);

/**
 * Show the owner what they're approving.
 *
 * The problem this fixes: a browse/desktop job blocks mid-tool-call on a 🔐 ("Act on
 * chase.com?", "Confirm browser action: Place your order") and they have NO idea what's actually on
 * screen. Which page, which tab, which dialog, what's in the cart. They're approving blind, from a
 * sentence. The one moment a picture is worth the most is the one moment nothing was sending them
 * one.
 *
 * Why the SYSTEM does this and not the agent:
 *   - it's deterministic. Every browser/desktop 🔐 gets a shot, always, in the same shape. An
 *     agent that "decides a picture would help here" is exactly the thing that won't do it on
 *     the turn it matters — and this is a safety surface, so "usually" is the wrong reliability
 *     class.
 *   - it can't be talked out of it. Page content is untrusted (see the prompt-injection rule in
 *     prompts/browser-agent.md); a page that can influence the model can't influence this.
 *   - it needs no tool, so it costs nothing in any context window and adds no surface a
 *     sub-agent could misuse.
 *
 * Which surface gets photographed, and why that order:
 *
 * A browse job that HAS a bound tab (browser.ts hands its Page down) gets a screenshot of THAT
 * page, first and without trying anything else. `screencapture` photographs the frontmost Chrome
 * WINDOW, which with two jobs in the shared Chrome is regularly another job's tab — on 2026-08-13
 * the owner was shown a picture of one site while approving an action on another, which is worse
 * than no picture: it's a confident wrong answer on a safety surface. Certainty about WHICH page
 * beats the one thing a page screenshot gives up, which is the native layer (a file picker, a
 * basic-auth sheet, a download bar) sitting on top of it.
 *
 * With no bound tab — a peekaboo/desktop 🔐, or a browse run whose shared Chrome never came up —
 * nothing changed: `screencapture` of the Chrome window (or the whole display), because there's no
 * specific page to be right about and the native layer is frequently the whole reason a 🔐 fired.
 *
 * Why there's a CDP fallback under it anyway: `screencapture` needs macOS Screen Recording,
 * which is a TCC grant only a human clicking System Settings on the machine itself can give.
 * A headless mini the owner isn't standing next to makes "go grant it" not a fix available
 * right now — capture fails with "could not create image from display" on EVERY 🔐, and
 * because failure is silent by design, every browser approval quietly degrades to text.
 *
 * The fallback is a page screenshot pulled straight off Chrome's own debug port, which needs no
 * OS permission at all. Two things make that safe here despite the browser being mid-tool-call:
 * canUseTool fires BEFORE the tool runs, so nothing is actually in flight and the page is idle;
 * and this opens its OWN short-lived CDP socket rather than asking the blocked MCP server to do
 * anything. It's second, not first, so the day Screen Recording IS granted the better capture
 * wins back automatically with no code change.
 *
 * Everything here is best-effort and time-boxed. An approval is NEVER blocked, delayed
 * meaningfully, or failed by a screenshot: any error, any timeout, any missing permission just
 * yields null and the 🔐 goes out as text exactly as it did before.
 */

/** Which kind of surface a 🔐 is guarding — decides what we capture. */
export type ApprovalVisual = "browser" | "desktop";

/**
 * The tool-name prefixes permissions.ts routes to its browser/desktop gates. Matched on the
 * OPERATION (the tool being gated), never on the question text — a question is prose that gets
 * reworded, and scoping a behaviour to a string someone might rephrase is the drift shape this
 * codebase keeps getting bitten by. These two prefixes are the same literals permissions.ts
 * branches on; a rename there just means no screenshot, never a wrong one.
 */
const BROWSER_PREFIX = "mcp__browser__";
const PEEKABOO_PREFIX = "mcp__peekaboo__";

/**
 * Screenshot-worthy or not. Scoped deliberately narrow: an email-send, a calendar-delete, a
 * card mint or a file write gets NO screenshot — the question text is the whole story there and
 * a picture of the desktop would be noise (and a small privacy leak) for no information.
 */
export function approvalVisualFor(toolName: string): ApprovalVisual | null {
  if (toolName.startsWith(BROWSER_PREFIX)) return "browser";
  if (toolName.startsWith(PEEKABOO_PREFIX)) return "desktop";
  return null;
}

/**
 * The in-flight tool's visual kind, carried from the canUseTool wrapper down to the approver.
 *
 * AsyncLocalStorage rather than a module-level variable on purpose: a lane can have more than
 * one tool call in flight (parallel tool use), and a plain `let` would let a browser call's
 * scope leak onto a concurrent email approval — mis-attributing a screenshot to a 🔐 that
 * shouldn't have one. ALS keeps the scope bound to the async chain that opened it, and the
 * whole chain (canUseTool → decideBrowser → classifier → askOwner) is plain awaits, so it
 * propagates.
 */
const visualScope = new AsyncLocalStorage<ApprovalVisual>();

/** One reused path. A shot is read and sent immediately, so there's no reason to keep them and
 *  no reason to accumulate a folder of stale desktop captures in scratch. */
const SHOT_PATH = join(homedir(), "scratch", "approval-shot.png");

/** Absolute path — /usr/sbin isn't on every PATH the daemon might inherit. */
const SCREENCAPTURE = "/usr/sbin/screencapture";
const OSASCRIPT = "/usr/bin/osascript";

/** Time boxes. Worst case ~7.5s against a 120s approval window, and only on the slow path. */
const BOUNDS_TIMEOUT_MS = 1_500;
const CAPTURE_TIMEOUT_MS = 3_000;
const CDP_TIMEOUT_MS = 3_000;

/**
 * Chrome's front-window rect as `x,y,w,h` for `screencapture -R`, or null if we can't get it
 * (Chrome not running, no window, Automation permission not granted, AppleScript slow/hung —
 * all of which are just "capture the display instead", never an error anyone sees).
 *
 * `channel: "chrome"` in browser/chrome.ts means the shared browser really is Google Chrome
 * stable; the self-launch fallback is Playwright's Chromium, so we try both names.
 */
async function chromeWindowRegion(): Promise<string | null> {
  for (const app of ["Google Chrome", "Chromium"]) {
    try {
      const { stdout } = await run(OSASCRIPT, ["-e", `tell application "${app}" to get bounds of front window`], {
        timeout: BOUNDS_TIMEOUT_MS,
      });
      // AppleScript gives "left, top, right, bottom" in points, top-left origin — the same
      // coordinate space -R wants, once it's converted to width/height.
      const n = stdout
        .trim()
        .split(",")
        .map((p) => Number(p.trim()));
      if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) continue;
      const [left, top, right, bottom] = n;
      const w = right - left;
      const h = bottom - top;
      if (w <= 0 || h <= 0) continue;
      return `${Math.round(left)},${Math.round(top)},${Math.round(w)},${Math.round(h)}`;
    } catch {
      // Not running / not scriptable / timed out. Try the next name, then fall back to the display.
    }
  }
  return null;
}

/** A `page` target on the debug port, newest-used first, skipping blank/devtools tabs. */
export type CdpTarget = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };

/**
 * Pick the tab to photograph. Given a `want` (a targetId or the exact URL of the run's own tab)
 * it selects EXACTLY that one and returns null if it isn't there — no silent downgrade to the
 * most-recently-used tab, because a picture of the wrong page is the failure this argument
 * exists to prevent. With no `want` it keeps the old MRU guess, which is all a desktop 🔐 or a
 * tabless run has to go on.
 */
export function pickPageTarget(targets: CdpTarget[], want?: string): CdpTarget | null {
  const pages = targets.filter(
    (t) => t.type === "page" && !!t.webSocketDebuggerUrl && !!t.url && !t.url.startsWith("devtools://"),
  );
  if (want) return pages.find((t) => t.id === want || t.url === want) ?? null;
  // Chrome lists page targets most-recently-used first, so [0] is the tab they're looking at.
  // about:blank only wins if it's genuinely the only tab open.
  return pages.find((t) => t.url !== "about:blank") ?? pages[0] ?? null;
}

/**
 * Screenshot the active tab over Chrome's debug port. No OS permission, no MCP call, no
 * Playwright import — one raw CDP socket, opened and closed inside the time box.
 *
 * Deliberately captures the VIEWPORT, not the full scrollable page: this is a picture of what
 * they'd be looking at if they were sitting in front of it, and a 20,000px checkout page rendered
 * down to iMessage thumbnail width is worth less than the fold they actually need to read.
 */
async function captureViaCdp(want?: string): Promise<Buffer | null> {
  let socket: WebSocket | null = null;
  try {
    const res = await fetch(`${cdpEndpoint()}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const target = pickPageTarget((await res.json()) as CdpTarget[], want);
    if (!target?.webSocketDebuggerUrl) return null;

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    socket = ws;
    const data = await new Promise<string | null>((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), CDP_TIMEOUT_MS);
      ws.onerror = () => done(null);
      ws.onclose = () => done(null);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { data?: string } };
          if (msg.id === 1) done(msg.result?.data ?? null);
        } catch {
          done(null);
        }
      };
    });
    return data ? Buffer.from(data, "base64") : null;
  } catch {
    return null;
  } finally {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Photograph the tab the run is actually on. Playwright talks to that exact Page, so it can't
 * land on a neighbouring job's tab the way a window grab can. Null on any failure — a page
 * mid-navigation, a closed tab, a slow renderer — which the caller only ever retries against
 * this SAME tab, never against another one.
 */
async function captureBoundPage(page: Page): Promise<string | null> {
  try {
    if (page.isClosed()) return null;
    // The viewport, matching the CDP path: this is a picture of what they'd see sitting in front
    // of it, not a 20,000px checkout page shrunk to iMessage thumbnail width.
    await page.screenshot({ path: SHOT_PATH, timeout: CAPTURE_TIMEOUT_MS });
    const st = existsSync(SHOT_PATH) ? statSync(SHOT_PATH) : null;
    if (!st?.isFile() || st.size === 0) return null;
    log(`approval: attached a browser screenshot (bound job tab, ${st.size}B)`);
    return SHOT_PATH;
  } catch (e) {
    warn(`approval screenshot: bound-tab capture failed (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

/**
 * Capture the current screen state. Returns an absolute path, or null on ANY failure — a missing
 * binary, no Screen Recording permission ("could not create image from display"), a hung
 * AppleScript, a zero-byte write. Never throws.
 *
 * A browser 🔐 from a job with a bound tab photographs THAT tab and stops there (see the header:
 * showing them the wrong page is worse than showing them nothing). Without one it prefers the
 * Chrome window (tight, shows the page plus Chrome's own native chrome/dialogs, leaks none of
 * their other windows), falls back to the main display, and finally to a CDP page shot when the
 * OS refuses to hand us pixels at all. A peekaboo 🔐 goes straight to the display, because
 * desktop automation is by definition not confined to one window and the approval is about
 * whatever app it's driving — and it has no CDP fallback, since Chrome can't photograph an app
 * that isn't Chrome.
 */
export async function captureApprovalScreenshot(kind: ApprovalVisual, jobPage?: Page | null): Promise<string | null> {
  if (process.platform !== "darwin" && !jobPage) return null;
  // Clear first, for the same reason the OS path does: a failed capture that left the PREVIOUS
  // shot on disk would attach a picture of a different page to this approval.
  try {
    mkdirSync(dirname(SHOT_PATH), { recursive: true });
    rmSync(SHOT_PATH, { force: true });
  } catch {
    /* the capture below will fail loudly enough */
  }
  if (kind === "browser" && jobPage) {
    // A bound tab still sitting on about:blank means the binding missed — the run is driving some
    // OTHER tab and this handle never followed it. Photographing it "succeeds": a white rectangle,
    // non-zero bytes, logged as a hit. That is strictly worse than no picture, because a blank
    // image reads as "the page really is empty" rather than "the camera pointed the wrong way".
    // Gated HERE, above both capture paths, because the CDP fallback below would otherwise
    // re-photograph the same blank tab by URL and undo the check.
    if (!jobPage.isClosed() && jobPage.url() === "about:blank") {
      warn("approval screenshot: bound tab is about:blank — binding missed the run's real tab, sending the 🔐 as text");
      return null;
    }
    const bound = await captureBoundPage(jobPage);
    if (bound) return bound;
    // The bound tab is the right surface but wouldn't render — try its URL over CDP before
    // giving up. Still exact: pickPageTarget with a `want` never falls back to another tab.
    try {
      const png = await captureViaCdp(jobPage.url());
      if (png?.length) {
        writeFileSync(SHOT_PATH, png);
        log(`approval: attached a browser screenshot (cdp, bound tab url, ${png.length}B)`);
        return SHOT_PATH;
      }
    } catch (e) {
      warn(`approval screenshot: cdp capture of the bound tab failed (${e instanceof Error ? e.message : e})`);
    }
    // Deliberately no window/display fallback here: this job HAS a tab, so any other picture
    // would be a picture of someone else's page presented as theirs.
    warn("approval screenshot failed for a bound job tab (sending the 🔐 as text)");
    return null;
  }
  if (process.platform !== "darwin") return null;
  let shellFailure = "";
  try {
    const region = kind === "browser" ? await chromeWindowRegion() : null;
    const args = ["-x", "-o", ...(region ? ["-R", region] : []), SHOT_PATH];
    await run(SCREENCAPTURE, args, { timeout: CAPTURE_TIMEOUT_MS });

    const st = existsSync(SHOT_PATH) ? statSync(SHOT_PATH) : null;
    if (st?.isFile() && st.size > 0) {
      log(`approval: attached a ${kind} screenshot (${region ? "chrome window" : "display"}, ${st.size}B)`);
      return SHOT_PATH;
    }
    shellFailure = "screencapture wrote nothing";
  } catch (e) {
    // Not returned yet — a dead screencapture is exactly when the CDP path earns its keep.
    shellFailure = e instanceof Error ? e.message : String(e);
  }

  if (kind === "browser") {
    try {
      const png = await captureViaCdp();
      if (png?.length) {
        writeFileSync(SHOT_PATH, png);
        log(`approval: attached a browser screenshot (cdp page, ${png.length}B)`);
        return SHOT_PATH;
      }
    } catch (e) {
      warn(`approval screenshot: cdp fallback failed too (${e instanceof Error ? e.message : e})`);
    }
  }

  // Silent by design as far as the owner is concerned — they just get the text prompt. Logged so a
  // permanently-broken capture (e.g. Screen Recording never granted) is findable.
  warn(`approval screenshot failed (sending the 🔐 as text): ${shellFailure}`);
  return null;
}

/**
 * Build the permission callback for a lane that can reach browser/desktop tools, with the
 * screenshot attached to any 🔐 those tools raise.
 *
 * This is the whole seam. permissions.ts is guardrail-locked and needs no change: every
 * browser/peekaboo prompt it raises goes through the askOwner it was HANDED, so enriching that
 * function enriches all of them at once — including any gate added there later, for free.
 *
 * `capture` is injected (defaulting to the real one) so tests can drive both the hit and the
 * miss without a screen.
 *
 * `getJobPage` is the run's own tab. It's what makes a browser 🔐 show them the page the action is
 * actually on rather than whatever Chrome window is in front — see the header. Omitted (a lane
 * with no browse job behind it), every 🔐 behaves exactly as it did before.
 */
export function makeCanUseToolWithApprovalShots(
  askOwner: Approver,
  capture: (kind: ApprovalVisual, jobPage: Page | null) => Promise<string | null> = captureApprovalScreenshot,
  getJobPage: () => Page | null = () => null,
): CanUseTool {
  // `prompt` is forwarded, not dropped: a gate inside permissions.ts can attach its own
  // system-built preview (the rendered card on the ordering-CLI money path), and this lane must
  // not silently strip it just because it also knows how to take screenshots. A live screenshot
  // still wins for a browser/desktop 🔐 — that's the one the picture is actually about.
  const inner = makeCanUseTool(async (question: string, prompt?: ApprovalPrompt) => {
    const kind = visualScope.getStore();
    if (!kind) return askOwner(question, prompt);
    let imagePath: string | null = null;
    try {
      // Handed over even if it's closed: capture() then returns null rather than photographing
      // the frontmost window, because a job that HAD a tab is exactly the case where the window
      // in front is likely to be someone else's.
      imagePath = await capture(kind, getJobPage());
    } catch (e) {
      // capture() already swallows its own failures; this is the belt for a custom/injected one.
      warn(`approval screenshot threw (sending the 🔐 as text): ${e instanceof Error ? e.message : e}`);
    }
    return askOwner(question, imagePath ? { ...prompt, imagePath } : prompt);
  });

  return ((...args: Parameters<CanUseTool>) => {
    const kind = approvalVisualFor(args[0]);
    return kind ? visualScope.run(kind, () => inner(...args)) : inner(...args);
  }) as CanUseTool;
}
