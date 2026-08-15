import "dotenv/config";

import { activeBrowserPage, ensureBrowserChrome } from "../../src/browser/chrome";
import { startHandoffBridge } from "../../src/browser/handoff-bridge";

/**
 * Dev entrypoint for the browser handoff streaming bridge (P1).
 *
 *   npm run handoff:demo
 *
 * Boots (or reattaches to) the bot's shared Chrome, picks the tab currently in focus,
 * and streams it to a phone web app. Open the printed URL on a phone on the SAME LAN,
 * drive the live tab (taps/keys forwarded over CDP), then tap "Done" to end the session.
 */
async function main(): Promise<void> {
  const ctx = await ensureBrowserChrome();
  const page = await activeBrowserPage(ctx);

  // Navigate to a target so there's something real to drive. Pass a URL as the first
  // arg, else default to Google's reCAPTCHA demo (exercises taps + the soft keyboard).
  const target = process.argv[2] || "https://www.google.com/recaptcha/api2/demo";
  await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});

  const { url, onDone, stop } = await startHandoffBridge(page, {
    status: "drive this one step, then tap Done",
  });

  console.log(`\n  Handoff bridge live. Open on your phone (same Wi-Fi):\n\n    ${url}\n`);
  console.log("  Waiting for you to tap Done …\n");

  await onDone;
  console.log("\n  Done — tearing down the bridge.");
  await stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
