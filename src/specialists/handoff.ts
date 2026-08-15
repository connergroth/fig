import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Page } from "playwright";

import { startHandoffBridge } from "../browser/handoff-bridge";
import { stageTab } from "../browser/stagedTabs";
import { log, warn } from "../core/log";
import { injectBackground } from "./detach";
import { text } from "./run";

const pexec = promisify(execFile);

/**
 * Live browser handoff (P2) — the browse specialist's escape hatch for the steps it CAN'T
 * automate: a sign-in it has no stored credential for, a captcha, a file/image upload that
 * won't go through, a human-verification wall, an app-push 2FA. Instead of failing the job,
 * the agent calls `request_handoff`: this stands up the streaming bridge (handoff-bridge.ts)
 * on the exact tab it's stuck on, texts the owner a link to drive that tab live from their phone,
 * and BLOCKS until they tap Done — then control returns to the agent to finish the job in the
 * same authenticated session.
 *
 * The text to the owner reuses the soft-inbound path (injectBackground): the message is voiced
 * by the main orchestrator, so it reads like fig telling them she needs a hand, with the link.
 */

/** Tailscale serve proxies this stable tailnet port to whatever local port the bridge grabs. */
const TAILNET_PORT = 8080;

/** Cap how long a handoff parks the job waiting on the owner (the job's own timeout is 10 min). */
const HANDOFF_WAIT_MS = 9 * 60 * 1000;

const TS_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];

async function tailscale(args: string[]): Promise<string> {
  let lastErr: unknown;
  for (const bin of TS_BINS) {
    try {
      const { stdout } = await pexec(bin, args, { timeout: 8000 });
      return stdout;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("tailscale CLI not found");
}

/** Grab a free local port for the bridge so a stray demo/prior handoff can't collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Point the stable tailnet URL (http://<mini>.<tailnet>.ts.net:8080) at the bridge's local
 * port and return it. The phone reaches the mini directly over the tailnet — no public
 * exposure, tailscale itself is the auth. Falls back to the bridge's LAN url if tailscale
 * isn't reachable (same-Wi-Fi only, but still works).
 */
async function publicUrl(localPort: number, lanFallback: string): Promise<string> {
  try {
    await tailscale(["serve", "--bg", `--http=${TAILNET_PORT}`, `http://127.0.0.1:${localPort}`]);
    const out = await tailscale(["status", "--json"]);
    const dns = String(JSON.parse(out)?.Self?.DNSName ?? "").replace(/\.$/, "");
    if (dns) return `http://${dns}:${TAILNET_PORT}/`;
  } catch (e) {
    warn(`handoff: tailscale serve setup failed, falling back to LAN url: ${e}`);
  }
  return lanFallback;
}

/**
 * The run's OWN tab, handed in by the browse specialist (browser.ts holds the Page that
 * openJobTab gave this job). Everything in here is out-of-band — it runs beside
 * @playwright/mcp, not through it — so before this getter existed both tools re-guessed the
 * tab with activeBrowserPage(), i.e. "whatever is frontmost in the shared Chrome". With two
 * jobs open that resolves to the OTHER job's tab: on 2026-08-13 stage_for_review reported an
 * unrelated Oracle careers page as "your staged tab" on five straight runs, and told each job
 * to give the owner that URL. Guessing is the bug; the binding is the fix.
 */
export type JobPageGetter = () => Page | null;

/**
 * The bound tab, or null if it's gone. Deliberately no activeBrowserPage fallback: staging or
 * handing over a STRANGER's tab is the failure being eliminated, and a wrong tab is reported as
 * fact while a refusal is just a retry.
 */
function boundPage(getJobPage: JobPageGetter): Page | null {
  const page = getJobPage();
  return page && !page.isClosed() ? page : null;
}

export function makeHandoffServer(getJobPage: JobPageGetter) {
  return createSdkMcpServer({
    name: "handoff",
    version: "1.0.0",
    tools: [
      tool(
        "request_handoff",
        "Hand the LIVE browser tab to the owner so THEY can do a step you genuinely cannot automate, then continue the job. Call this the moment you hit a wall: a sign-in / login you have no stored credential for, a CAPTCHA or 'verify you're human' challenge, a file or image upload that won't go through, an app-push (tap-to-approve) 2FA, or any single step that's blocking you and that a person needs to do by hand. It stands up a live view of THIS tab, texts the owner a link to drive it from their phone, and BLOCKS until they tap Done — then returns so you re-read the page and finish. Do NOT use this for things you can do yourself, for routine email/SMS verification codes (read those from fig's inbox/number), or to ask a question (just proceed). Leave the tab ON the exact page that's blocked before calling.",
        {
          reason: z
            .string()
            .describe(
              "what the owner needs to do, in plain words — e.g. 'sign in to your Amazon account', 'solve the captcha', 'upload the image from your phone', 'approve the login push'. Shown to them so they know exactly what the one step is.",
            ),
        },
        async (args) => {
          const page = boundPage(getJobPage);
          if (!page) {
            return text(
              `Couldn't open a handoff — YOUR tab is gone (closed, or this run never got one). I won't hand the owner some other job's tab. Open a new tab, navigate back to the blocked page, and try again.`,
            );
          }

          const port = await freePort().catch(() => 8723);
          const bridge = await startHandoffBridge(page, { status: args.reason, port });
          const url = await publicUrl(port, bridge.url);
          log(`handoff: requested — "${args.reason}" → ${url}`);

          // Text the owner via the soft-inbound path so fig voices it with the link.
          const delivered = injectBackground(
            `[the browser job hit a step it can't do on its own and needs the owner to take over the live tab themselves: ${args.reason}. ` +
              `Tell them now, in your voice — briefly what the one step is — and give them this link on its OWN line to open on their phone, drive the tab, and tap Done when finished. Don't alter the url:\n${url}]`,
          );
          if (!delivered) {
            // No live conversation wired (shouldn't happen for a real job) — clean up, don't hang.
            await bridge.stop();
            return text(
              `Couldn't reach the owner to hand off (no live conversation). Skip this step or fail the task; don't retry the handoff.`,
            );
          }

          // Park here until they tap Done, or the wait cap trips.
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), HANDOFF_WAIT_MS);
          });
          const outcome = await Promise.race([bridge.onDone.then(() => "done" as const), timeout]);
          if (timer) clearTimeout(timer);
          await bridge.stop();

          if (outcome === "timeout") {
            return text(
              `Handoff timed out — the owner didn't finish "${args.reason}" in time. Re-read the page: if it's still blocked, stop and report that this step needs them; don't loop the handoff.`,
            );
          }
          return text(
            `the owner finished the handoff step ("${args.reason}") and tapped Done. The tab should now be past it (logged in / captcha cleared / file uploaded). Re-read the CURRENT page state and continue the task from here.`,
          );
        },
      ),
      /**
       * The staging counterpart to request_handoff. A handoff parks the job while the owner does a
       * step; this ends the job and leaves the filled page waiting for them. Both are the same
       * underlying idea — this tab now belongs to the owner, no cleanup may touch it — which is why
       * they live together. Before this existed, tab cleanup only spared LOGIN handoffs, so a
       * staged application form was destroyed by its own run's exit (2026-08-05, Samsara).
       */
      tool(
        "stage_for_review",
        "Leave THIS tab open for the owner with your work still on it, instead of finishing and letting it be cleaned up. Call this whenever the deliverable IS the filled page: an application form you filled but must not submit, a cart awaiting their approval, a draft awaiting their eyes — anything where they take over later and the filled state cannot be rebuilt from the URL alone. Without this call the tab is closed the moment your run ends and everything typed into it is gone. Call it BEFORE you write your final summary, with the tab sitting on the exact page they should see. Not for pages they can simply re-open — only for work that dies with the tab.",
        {
          reason: z
            .string()
            .describe(
              "what is sitting on this tab and what the owner still has to do — e.g. 'Samsara new grad application, filled except resume upload / AI-policy question / current employer; do not submit'. Shown to them verbatim.",
            ),
          label: z.string().optional().describe("short tag for what staged it, e.g. 'apply' or 'errand'"),
        },
        async (args) => {
          const page = boundPage(getJobPage);
          if (!page) {
            return text(
              `Couldn't stage — YOUR tab is gone (closed, or this run never got one). Nothing was staged, and I won't stage a tab that isn't yours. Say plainly in your final summary that the filled state could NOT be preserved.`,
            );
          }
          // Read the URL off the BOUND page, so what's registered and what's reported to the owner
          // are both this job's page rather than whatever tab happened to be in front.
          const url = page.url();
          const title = await page.title().catch(() => "");
          const record = stageTab(page, { url, title, reason: args.reason, label: args.label });
          return text(
            `Staged your tab, which is sitting on ${url} (id ${record.id}). It's held for the owner and will NOT be closed when your run ends.\n` +
              `That URL is read off YOUR tab — if it isn't the page you meant to leave them, you're on the wrong page: navigate back and stage again.\n` +
              `Don't navigate it elsewhere, don't submit, don't reopen the same page in another tab. ` +
              `In your final summary say plainly that the tab is staged and waiting, give this exact URL on its own line, and list every field still left for them:\n${url}`,
          );
        },
      ),
    ],
  });
}
