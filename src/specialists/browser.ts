import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { BrowserContext, Page } from "playwright";

import { agentmailServer } from "../agentmail/tools";
import { browserSystemPrompt } from "../session/agent";
import {
  cdpAlive,
  cdpEndpoint,
  closeJobTab,
  ensureBrowserChrome,
  openJobTab,
  resetBrowserChrome,
} from "../browser/chrome";
import { makeCredentialsServer } from "../credentials/tools";
import { bindJobTab, type JobTabBinding } from "../browser/jobTabs";
import { holdTab } from "../browser/stagedTabs";
import { makeHandoffServer } from "./handoff";
import { log, warn } from "../core/log";
import { loadMcpServers } from "../runtimes/mcp";
import { withFreshAgentCardToken } from "../runtimes/agentCard";
import { captureApprovalScreenshot, makeCanUseToolWithApprovalShots } from "./approvalScreenshot";
import { isHeadlessAgentPass } from "../core/agentPassContext";
import { currentApprover, type Approver } from "./approval";
import { launchJob } from "./jobs";
import { defineServer, toSdkServer } from "../tools/define";
import { runSpecialist } from "./run";

/**
 * Long browser jobs need way more headroom than the 2-min specialist default.
 *
 * ⚠️ This is also the real ceiling on how long a mid-job 🔐 can wait. APPROVAL_TIMEOUT_MS
 * (session/approvalPrompt.ts) is 10 min — exactly this budget — and the job's clock started
 * first, so a live browse job hits ITS deadline before a full-length approval window closes.
 * Practical effect: mid-browse, the answerable window is "whatever the job has left", not
 * the full 10. Noted in both files rather than left to silently conflict. If it starts
 * costing real approvals, the lever is raising this number (or passing timeoutMinutes on
 * the job), not shortening the approval window back down to a terminal's number.
 */
const DEFAULT_BROWSER_JOB_TIMEOUT_MIN = 10;
/** Ceiling — even a "give it more time" job can't run forever (protects the box + the jobs board). */
const MAX_BROWSER_JOB_TIMEOUT_MIN = 20;
const MIN_BROWSER_JOB_TIMEOUT_MIN = 1;

function minutesEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Headless scheduled skills sometimes do slow browser harvests (e.g. image/contact-sheet
// collection). Keep live browse calls snappy, but let unattended passes wait long enough
// to return the real result inline.
const DEFAULT_HEADLESS_BROWSER_JOB_TIMEOUT_MIN = minutesEnv("FIG_HEADLESS_BROWSER_TIMEOUT_MINUTES", 90);
const MAX_HEADLESS_BROWSER_JOB_TIMEOUT_MIN = minutesEnv("FIG_HEADLESS_BROWSER_MAX_TIMEOUT_MINUTES", 180);

/** Clamp a caller-supplied timeout, using roomier defaults only inside headless passes. */
function resolveBrowserTimeoutMs(timeoutMinutes: number | undefined, headless: boolean): number {
  const defaultMinutes = headless ? DEFAULT_HEADLESS_BROWSER_JOB_TIMEOUT_MIN : DEFAULT_BROWSER_JOB_TIMEOUT_MIN;
  const maxMinutes = headless ? MAX_HEADLESS_BROWSER_JOB_TIMEOUT_MIN : MAX_BROWSER_JOB_TIMEOUT_MIN;
  const minutes =
    typeof timeoutMinutes === "number" && Number.isFinite(timeoutMinutes)
      ? Math.min(maxMinutes, Math.max(MIN_BROWSER_JOB_TIMEOUT_MIN, Math.round(timeoutMinutes)))
      : Math.min(maxMinutes, Math.max(MIN_BROWSER_JOB_TIMEOUT_MIN, defaultMinutes));
  return minutes * 60 * 1000;
}

/**
 * Browser specialist — scoped sub-query with ONLY the Playwright browser connected,
 * so its ~21 tools stay out of the main context. canUseTool is the shared permission
 * model, so the full browser gating still applies INSIDE the sub-query: open-web read
 * is free, guarded sites + money/irreversible actions route a 🔐 to the owner, and
 * private/internal hosts are hard-denied (SSRF).
 *
 * Named "browse" (not "browser") on purpose: the delegation tool is mcp__browse__use,
 * which must NOT match the `mcp__browser__` gate that guards the raw browser actions.
 */
/**
 * AgentCard (agent-cards) MCP exposes ~23 tools, but the browse specialist only needs the
 * ones for paying at checkout: see/mint/inspect/close a card and read balance/transactions/
 * plan/mode. We deny the rest so they don't bloat the sub-query's context — account admin
 * (payment methods, plans, billing, KYC, support, approvals) is deliberate human/CLI work,
 * and the extension-only checkout tools (detect_checkout/fill_card/pay_checkout) can't run
 * here anyway (no AgentCard Chrome extension in Playwright — fig fills via get_card_details
 * + browser_type). Kept: list_cards, create_card, check_balance, get_card_details, close_card,
 * list_transactions, get_plan, get_mode, set_mode.
 */
const AGENT_CARDS_DENY = [
  "setup_payment_method",
  "remove_payment_method",
  "list_payment_methods",
  "set_default_payment_method",
  "upgrade_plan",
  "cancel_plan",
  "submit_user_info",
  "approve_request",
  "start_support_chat",
  "send_support_message",
  "read_support_chat",
  "detect_checkout",
  "fill_card",
  "pay_checkout",
].map((t) => `mcp__agent-cards__${t}`);

/**
 * Point @playwright/mcp at the bot's shared Chrome over CDP instead of letting it launch
 * its own. This is what lets the credential injector and the specialist drive the SAME
 * tab: the injector reuses that browser's page in-process for the origin-bound DOM fill.
 * We strip --user-data-dir (CDP attaches to the already-running profile) and preserve any
 * other flags the owner set in mcp.json.
 */
function toCdpBrowserConfig(base: McpServerConfig): McpServerConfig {
  const b = base as { command?: string; args?: unknown };
  const baseArgs = Array.isArray(b.args) ? (b.args as string[]) : ["-y", "@playwright/mcp@latest"];
  const args: string[] = [];
  for (let i = 0; i < baseArgs.length; i++) {
    // Drop --user-data-dir (CDP attaches to the running profile) and any stale
    // --cdp-endpoint — the config value below is authoritative for the port.
    if (baseArgs[i] === "--user-data-dir" || baseArgs[i] === "--cdp-endpoint") {
      i++; // skip the flag and its value
      continue;
    }
    args.push(baseArgs[i]);
  }
  args.push("--cdp-endpoint", cdpEndpoint());
  return { ...(base as object), command: b.command ?? "npx", args } as McpServerConfig;
}

/**
 * Idempotency guard for the mid-run reconnect (below). A browse job may only be auto-retried
 * if the specialist hadn't yet done anything that could change server-side state — otherwise a
 * blind re-run could double-fire it (resubmit a form, re-click "buy", re-post a comment).
 *
 * We classify each progress one-liner (from progress.ts's summarizeToolUse) as replay-safe or
 * not. Replay-safe = pure navigation/reads + the specialist's own scratch-file bookkeeping
 * (the checkpoint Write it's instructed to keep). EVERYTHING else — clicks, typing, form fills,
 * key presses, option selects, uploads, dialogs, page scripts, drags, and any unrecognized or
 * card/credential tool — is treated as potentially side-effecting, so seeing even one blocks
 * the retry. The default is deliberately "not safe": if progress.ts ever adds a new action we
 * don't recognize here, it counts as unsafe and we surface instead of risking a double-fire.
 */
const REPLAY_SAFE_ACTION = /^(navigating|hovering|reading |taking a screenshot|waiting on the page|managing browser tabs|writing |editing |listing files|searching for|running bash)/;
function isReplaySafeAction(summary: string): boolean {
  return REPLAY_SAFE_ACTION.test(summary.trim());
}

export const browseServerDef = defineServer({
  key: "browse",
  kind: "specialist",
  purpose: "delegate anything needing a real logged-in browser or desktop control to the browse specialist",
  exposure: "both",
  capabilities: [
    {
      name: "use",
      purpose: "delegate anything needing a real logged-in browser or desktop control to the browse specialist",
      mutates: "write",
      description:
        "Delegate to the browser specialist: drive a real logged-in Chrome to open sites, read JS-rendered/paywalled/login-walled pages (X, Instagram, Reddit threads, etc.), search, fill forms, compare products, add to carts. It can also sign up for accounts using fig's OWN burner email (AgentMail), fill approved logins through the credentials injector without seeing passwords, and pay at checkout with fig's OWN prepaid virtual card (AgentCard), which it can mint for the exact amount. Anything fetch_url can't reach. It never completes a purchase, spends money, or other irreversible action without the owner's 👍. Pass the task/URL in natural language. Live interactive turns RUN ASYNC: this returns a job handle immediately and does NOT block — the result arrives as a follow-up when it finishes, and survives across new messages. Headless scheduled/proactive passes BLOCK and return the real browser result inline so the pass can finish end-to-end. Don't relay a live-turn handle as the answer.",
      input: {
        request: z.string().describe("what to do in the browser, with the URL or site and the goal"),
        timeoutMinutes: z
          .number()
          .optional()
          .describe(
            "optional; how long the browser job may run before it's aborted. Live default 10, max 20. Headless scheduled default is FIG_HEADLESS_BROWSER_TIMEOUT_MINUTES (90 if unset), max FIG_HEADLESS_BROWSER_MAX_TIMEOUT_MINUTES (180 if unset).",
          ),
        stageForReview: z
          .boolean()
          .optional()
          .describe(
            "set true when the POINT of the job is to leave filled work on the page for the owner rather than finish it — a tier-1 application filled but not submitted, a cart staged for their approval. Keeps the tab open after the run ends instead of cleaning it up.",
          ),
        resumeTab: z
          .string()
          .optional()
          .describe(
            "pick up work already staged for the owner instead of starting over: a staged tab id, its full URL, or just its host (e.g. 'myworkday.com'). The run binds to that existing tab with everything already typed into it still there. Only set this when continuing work you know is staged — otherwise leave it off and a fresh tab is opened.",
          ),
      },
      handler: async (args) => {
        const headless = isHeadlessAgentPass();
        const jobTimeoutMs = resolveBrowserTimeoutMs(args.timeoutMinutes, headless);
        const servers = loadMcpServers();
        const browserBase = servers.browser;
        if (!browserBase) return "The browser MCP isn't configured in mcp.json.";
        // Snapshot the approver NOW, while we're still in-turn. This job is fully async and
        // outlives the launching turn, so by the time it hits an add-to-cart / checkout 🔐 the
        // per-turn approver is already cleared to null — which silently auto-denied and never
        // prompted the owner (the "I never got the approvals" bug). Capturing askOwner here keeps
        // the 🔐 reaching them for the whole job.
        //
        // The snapshot alone proved fragile (2026-08-13: a live-turn launch snapshotted null and
        // 13 asks in a row auto-denied in <1s — the owner never saw a single 🔐 and the job read
        // it as "the harness declined"). Two hardenings, both in the direction of MORE asks
        // reaching the owner, never fewer:
        //   - if the snapshot is null, retry currentApprover() AT ASK TIME — a live turn running
        //     right then can still carry the 🔐 to their phone. Asking is strictly safer than a
        //     silent deny; the deny-when-unattended rule was only ever "nobody's there to see it".
        //   - every auto-deny on this path logs loudly, so a dead approver reads as the plumbing
        //     failure it is instead of masquerading as the owner saying no.
        const approverSnapshot = currentApprover();
        if (!approverSnapshot) {
          log("browse launch: no approver snapshot (unattended or bridge broken) — 🔐s will retry live lookup at ask time");
        }
        const approver: Approver = async (question, prompt) => {
          const fn = approverSnapshot ?? currentApprover();
          if (!fn) {
            log(`🔐 AUTO-DENY (no approver at launch OR ask time): "${question.slice(0, 80)}"`);
            return false;
          }
          return fn(question, prompt);
        };
        // agent-cards = fig's own virtual Visa cards (AgentCard). Connected here so the
        // specialist can create a card and pay at checkout. The mcp.json entry carries the
        // url + a placeholder header; we inject a FRESH access token here (resolved live from
        // the CLI's ~/.agent-cards config, which auto-rotates the ~5-min JWT) instead of a
        // frozen env token that goes stale. Returns undefined if AgentCard isn't logged in,
        // so the server is simply omitted (optional).
        const cards = withFreshAgentCardToken(servers["agent-cards"]);
        // Peekaboo = macOS-level screen capture + UI automation. Keep it scoped to
        // this specialist for visual browser work and desktop/app control, alongside
        // Playwright's structured DOM automation.
        const peekaboo = servers.peekaboo;

        // Stateful run file: the browser is otherwise fully stateless — the runtime returns
        // "" on a timeout/abort (claude.ts catch → { text: "" }), and its findings only
        // become the returned "answer" at the very end when it writes the summary. So a run
        // killed by the 10-min cap mid-work loses EVERYTHING it gathered. Fix: give it a
        // scratch file to checkpoint findings into as it goes. Two payoffs — a timed-out run
        // is recovered from the file instead of returning "(no answer)", and fig (or the owner)
        // can Read this file mid-run to watch live progress.
        const runFile = join(homedir(), "scratch", "browser-runs", `browser-${Date.now()}.md`);
        // Identity for this run's tab claims (jobTabs.ts). Its own id, not the job board's:
        // the headless path never creates a job, and a retry inside runOnce must keep the
        // same owner so its second attempt doesn't fight its first for a tab.
        const tabOwnerId = `browse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // The specialist's own working directory — NOT the vault. Its system prompt already
        // tells it to use absolute ~/scratch/ paths, but that's an instruction it can miss;
        // this is the structural backstop. Any relative-path Write/Bash/peekaboo output the
        // specialist makes now lands here by default instead of littering the vault root.
        const browserCwd = join(homedir(), "scratch", "browser");
        try {
          mkdirSync(join(homedir(), "scratch", "browser-runs"), { recursive: true });
          mkdirSync(browserCwd, { recursive: true });
        } catch {
          /* best-effort; if scratch is unwritable the run still works, just without recovery */
        }
        // The prompt half of the concurrency fix. openJobTab() hands this run a fresh focused
        // tab, but @playwright/mcp's current-tab pointer isn't settable from out here, so the
        // model has to hold the discipline: stay on your own tab, and re-check the URL before
        // trusting what's on it. Structure narrows the window where two jobs collide; this
        // closes it, because the failure mode is a silent WRONG READ, not a crash — a page
        // that belongs to another job looks exactly like a page that belongs to this one.
        const resumingTab = typeof args.resumeTab === "string" && args.resumeTab.trim() !== "";
        const tabDisciplineInstruction =
          `\n\n---\nTAB DISCIPLINE — you are not alone in this Chrome. Other automations may be driving OTHER TABS in the same browser at the same time.\n` +
          (resumingTab
            ? `- RESUMED TAB: you have been bound to a tab that was already staged for the owner, with work ALREADY TYPED INTO IT. It is focused. Do not open a fresh tab for this task and do not start the form over — read what's on the page first and continue from there. Anything you re-enter from scratch is work thrown away.\n`
            : `- A fresh tab has already been opened and focused for you. Work in that one. Do NOT switch to a tab you didn't open yourself, and don't "clean up" other tabs.\n`) +
          `- If you need a second page, open it with browser_tabs (new) — never reuse a tab that was already sitting there.\n` +
          `- Before you act on or report what's on a page, confirm the URL is the one YOU navigated to. If a snapshot shows a site you didn't ask for, another job moved under you: re-navigate to your own URL and take a fresh snapshot. Never read, click, or report from a page you didn't put yourself on.\n` +
          `- A wrong-page read is the failure that matters here. "I ended up somewhere else and re-navigated" is a fine outcome; silently reporting another job's page as your result is not.\n` +
          `- YOUR TAB IS CLOSED WHEN YOUR RUN ENDS. So if the deliverable is work left ON the page — a form filled but deliberately not submitted, a cart staged for approval — you MUST call stage_for_review before your final summary, or everything you typed is destroyed the moment you finish. Filling a form for the owner and not staging it is the same as not doing it.`;

        // Caller-declared staging: the launching skill (e.g. `apply` on a tier-1 req) already
        // knows the job's whole point is to leave a filled form for the owner. Belt to the
        // specialist's stage_for_review suspenders — the model forgetting one tool call must
        // not be what decides whether ten minutes of typing survives.
        const stageForReviewRequested = args.stageForReview === true;
        const stageIntentInstruction = stageForReviewRequested
          ? `\n\n---\nSTAGED RUN — this job is EXPECTED to end with work left on the page for the owner. Do not submit, do not finish it for them. Call stage_for_review before your summary, and report the exact URL plus every field still outstanding.\n` +
            `- The owner reads on their PHONE and cannot open the staged tab. So the staged state must come back as PICTURES, not a link: before you finish, screenshot the whole review/staged surface — scroll and take a series of legible, overlapping shots covering it top to bottom — save them to ~/scratch/ with descriptive numbered names, and list every absolute path in your summary in order. fig attaches them to the message the owner actually sees.\n` +
            `- A staged URL with no screenshots is a dead end for them. The URL is for fig to resume; the screenshots are the handoff.`
          : "";

        const checkpointInstruction =
          `\n\n---\nSTATEFUL RUN — checkpoint as you go. Write your findings to this scratch file and keep it updated the WHOLE run:\n` +
          `${runFile}\n` +
          `Use the Write/Edit tools. Append each confirmed finding the MOMENT you have it — a URL, a result, a partial answer — don't wait until the end. ` +
          `This is your safety net: there's a hard ${jobTimeoutMs / 60000}-minute cap, and if you're cut off before your final writeup, whatever's in this file is all that survives. ` +
          `Your final summary is still your real returned answer; the file is the backup, not a replacement for it.`;

        // Pull the checkpointed partial findings off disk (empty string if none). Used both as
        // the timeout-recovery fallback and as the payload we hand back when a session drops
        // mid-action and we deliberately DON'T auto-retry.
        const recoverCheckpoint = (): string => {
          try {
            return readFileSync(runFile, "utf8").trim();
          } catch {
            return "";
          }
        };

        const isEmptyRun = (result: string): boolean =>
          !result.trim() || result.includes("(no answer from the browser specialist)");

        const runBrowser = async (signal: AbortSignal, report: (action: string) => void): Promise<string> => {
          // Count side-effecting actions the specialist takes, so the mid-run reconnect below
          // knows whether a blind re-run is safe (see isReplaySafeAction). Wraps the caller's
          // progress sink — the job board still gets every one-liner, unchanged.
          let sideEffectingActions = 0;
          const countingReport = (action: string) => {
            if (!isReplaySafeAction(action)) sideEffectingActions++;
            report(action);
          };

          // One attempt: bring up the bot's shared Chrome, aim @playwright/mcp at it over CDP so
          // this specialist and the credential injector drive the same tab, and run the job. If
          // the shared Chrome can't start (e.g. playwright not installed), fall back to letting
          // @playwright/mcp launch its own browser — basic browsing still works.
          const runOnce = async (): Promise<{ result: string; sessionDied: boolean }> => {
            let browser = browserBase;
            // This job's own tab in the shared Chrome. Concurrent browse jobs (a scheduled
            // sweep + a live request, say) attach to the SAME context — that's what keeps them
            // logged in as the owner — so without a per-job tab they navigate out from under each
            // other and one can READ THE OTHER'S PAGE and report it as fact. See openJobTab.
            let context: BrowserContext | null = null;
            let jobTab: Page | null = null;
            let binding: JobTabBinding | null = null;
            try {
              context = await ensureBrowserChrome();
              jobTab = await openJobTab(context, { resume: args.resumeTab });
              // Follow the tab this run actually drives. openJobTab hands it a fresh one, but
              // @playwright/mcp binds to the OLDEST page in the shared Chrome, so "the tab we
              // opened" is a hypothesis, not a fact — see jobTabs.ts.
              binding = bindJobTab(context, tabOwnerId, jobTab);
              // The caller said up front this run exists to leave work for the owner, so hold the
              // tab from the very first navigation. If the run dies mid-fill — timeout, CDP
              // drop, crash — the partially filled page still survives for them, which is the
              // whole point. stage_for_review then adds the URL/reason detail on top.
              if (stageForReviewRequested) holdTab(jobTab);
              browser = toCdpBrowserConfig(browserBase);
            } catch (e) {
              warn(`shared Chrome unavailable, falling back to @playwright/mcp self-launch: ${e}`);
            }
            // The structural half of the tab-discipline fix. Everything that runs BESIDE
            // @playwright/mcp — staging, handoff, the credential injector, the 🔐 screenshot —
            // used to re-derive "the current tab" from whatever was frontmost in the shared
            // Chrome, so with two jobs open each one could stage, photograph or type into the
            // OTHER's page (2026-08-13: five staged tabs reported as an unrelated Oracle careers
            // page, and a 🔐 that showed the owner a different site than the one being approved).
            // Handing them this getter means they read THIS run's Page or refuse — never guess.
            //
            // It resolves through the binding, not the tab openJobTab handed us: the MCP may
            // never have adopted that tab (it binds to the oldest page in the shared Chrome),
            // and the run may have moved to a popup since. Late-resolving is what makes the
            // 🔐 screenshot photograph the page the action is actually on.
            const jobPageRef = () => binding?.current() ?? jobTab;
            // Handing the live tab to the owner (sign-in, captcha, 2FA) means the tab outlives the
            // run — closing it would yank the page out from under them mid-login.
            let handedOff = false;
            const reportWatchingForHandoff = (action: string) => {
              // Two ways a tab stops being this run's to close: it was handed to the owner
              // mid-login, or it was staged with filled work they have to finish. Both route into
              // the same hold, so cleanup has ONE rule to obey instead of a special case that
              // only remembered logins (which is exactly how a staged application got reaped).
              // Every action first: a browser_navigate names the host this run means to be on,
              // which is how adoption tells our tab from a concurrent job's.
              binding?.noteAction(action);
              if (/handoff|stag(e|ing)/i.test(action)) {
                handedOff = true;
                holdTab(jobPageRef());
              }
              countingReport(action);
            };
            try {
              const result = await runSpecialist({
              label: "browser",
              prompt: args.request + tabDisciplineInstruction + stageIntentInstruction + checkpointInstruction,
              systemPrompt: browserSystemPrompt(),
              // agentmail = fig's own email, so the specialist can spin up a burner inbox
              // for a signup and read the verification code/link back without leaving the sub-query.
              mcpServers: {
                browser,
                ...(peekaboo ? { peekaboo } : {}),
                agentmail: agentmailServer,
                credentials: makeCredentialsServer(jobPageRef),
                // NO image server here, deliberately — do not re-add one. This specialist does not
                // get a path that reaches the owner directly. A photo it sent itself would arrive
                // DETACHED from fig's words, with no guaranteed ordering against the reply that
                // explains it: they'd get a bare screenshot, then a paragraph about a picture they
                // already scrolled past. The image is the answer TO fig's message, so fig sends it
                // — the specialist hands back an absolute path (see prompts/browser-agent.md) and
                // fig attaches it to the words. That also keeps the taste gate in one place
                // instead of letting a sub-agent fire five shots it happens to find interesting.
                // For "show them what they're approving", see specialists/approvalScreenshot.ts: the
                // system attaches the shot to the 🔐 itself, no model judgment involved.
                //
                // request_handoff: hand the live tab to the owner for steps it can't automate
                // (sign-in, captcha, file upload, app-push 2FA), then resume the same session.
                handoff: makeHandoffServer(jobPageRef),
                ...(cards ? { "agent-cards": cards } : {}),
              },
              ...(cards ? { disallowedTools: AGENT_CARDS_DENY } : {}),
              cwd: browserCwd,
              // Same permission model as everywhere else (makeCanUseTool), wrapped so a 🔐 raised
              // by a browser or peekaboo tool carries a screenshot of the screen it's asking
              // about. This is the ONLY lane that mounts either server, which is why it's the
              // only one that wraps. The job's tab goes in too, so a browser 🔐 photographs the
              // page the action is on instead of the frontmost window — see approvalScreenshot.ts
              // for why the system captures it rather than the model.
              canUseTool: makeCanUseToolWithApprovalShots(approver, captureApprovalScreenshot, jobPageRef),
              signal,
              timeoutMs: jobTimeoutMs,
              onProgress: reportWatchingForHandoff,
            });
              // Signature of a mid-run Chrome/CDP death (vs. a normal timeout): the specialist
              // returned nothing usable AND the debug port has stopped answering. A timeout leaves
              // Chrome alive — CDP still responds — so this won't false-positive on a slow page;
              // a genuine in-page failure (element not found) returns real text, so isEmptyRun is
              // false and we won't retry that either. We only reconnect on a truly dead session.
              const sessionDied = isEmptyRun(result) && !(await cdpAlive());
              return { result, sessionDied };
            } finally {
              // A run declared as "leave work for the owner" holds whatever tab it ENDED on,
              // not the blank seat it was handed at the start — that tab may never have been
              // the one the model drove.
              if (stageForReviewRequested) holdTab(jobPageRef());
              // Retire this job's tabs so they don't accumulate across runs — unless one's been
              // handed to the owner (live sign-in) or staged for them (filled form they still have to
              // finish), in which case it's their tab now. closeJobTab re-checks the hold itself,
              // so the guard here is belt-and-braces rather than the only thing standing
              // between a staged application and its own run's cleanup. Both the seat and the
              // adopted tab go: an unadopted seat left open is the next run's stray leftover.
              if (context) {
                const mine = [jobPageRef(), jobTab].filter((p, i, a): p is Page => !!p && a.indexOf(p) === i);
                for (const p of mine) {
                  if (handedOff && p === jobPageRef()) continue;
                  await closeJobTab(context, p).catch(() => {});
                }
              }
              // Release claims LAST — while they stand, no concurrent job can adopt or reap
              // these tabs out from under the cleanup above.
              binding?.release();
            }
          };

          let { result, sessionDied } = await runOnce();

          // Mid-run reconnect: the CDP session dropped out from under the specialist. Retry the
          // whole ensureBrowserChrome() attach→launch cycle exactly ONCE — but only if the
          // specialist hadn't yet taken a side-effecting action. If it had, a blind re-run could
          // repeat it (double form-submit / re-purchase), so we surface instead of silently redoing.
          if (sessionDied && !signal.aborted) {
            if (sideEffectingActions === 0) {
              log(
                `browser: CDP session dropped mid-run before any side-effecting action — reconnecting and retrying once`,
              );
              resetBrowserChrome(); // clear the dead cached context so the retry re-attaches fresh
              ({ result, sessionDied } = await runOnce());
              if (sessionDied) {
                warn(`browser: reconnect retry still lost the session on ${cdpEndpoint()}`);
              }
            } else {
              warn(
                `browser: CDP session dropped after ${sideEffectingActions} side-effecting action(s) — not auto-retrying to avoid repeating them`,
              );
              const recovered = recoverCheckpoint();
              return (
                `⚠️ The browser session dropped mid-task — Chrome disconnected after ${sideEffectingActions} action(s) that may have changed state (a click, form fill, or similar). ` +
                `I did NOT auto-retry, to avoid repeating a side-effecting step. ` +
                (recovered ? `Here's what it had checkpointed before the drop:\n\n${recovered}\n\n` : ``) +
                `Re-run the request if you want to pick it back up.`
              );
            }
          }

          // If the run came back empty (timeout/abort → runtime returns "" → the
          // "(no answer)" sentinel), fall back to whatever the browser checkpointed to
          // the run file, so a cut-off run yields its partial findings instead of nothing.
          if (isEmptyRun(result)) {
            const recovered = recoverCheckpoint();
            if (recovered) {
              return (
                `⚠️ The run was cut off before it wrote a final summary (likely the ${jobTimeoutMs / 60000}-min cap). ` +
                `Recovered the partial findings it checkpointed to ${runFile}:\n\n${recovered}`
              );
            }
          }
          return result;
        };

        if (headless) {
          return await runBrowser(new AbortController().signal, () => {});
        }

        // Launch as a fully-async background job. The handler returns in milliseconds with a
        // handle, so the live turn is NEVER blocked and the job survives the turn ending or a
        // new message arriving (it lives in the jobs registry under its own AbortController,
        // not the turn's signal). Chrome bring-up happens INSIDE the job so launch stays
        // instant. When it settles, jobs.ts pushes the result back as a soft inbound.
        const job = launchJob({
          label: "browse",
          task: args.request,
          run: runBrowser,
        });

        return (
          `🌐 browser job launched in the background (id: ${job.id}). it's running detached — this turn is NOT blocked and the job survives your next messages. ` +
          `its result will arrive as a follow-up when it finishes (usually under a couple min). THIS IS NOT THE ANSWER — don't relay it as if the work is done; just let the owner know you're on it (or carry on), and you'll be pinged when it lands.\n\n` +
          `it checkpoints findings live to ${runFile} — Read that file any time to watch progress mid-run, or to recover the work if it times out.\n\n` +
          `meanwhile, the unified job board: mcp__jobs__list lists all running jobs, mcp__jobs__check (id: ${job.id}) reads its status/result, mcp__jobs__cancel (id: ${job.id}) aborts it.`
        );
      },
    },
  ],
});

export const browseServer = toSdkServer(browseServerDef);
