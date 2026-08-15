import "dotenv/config";

import { getAccounts, type MailAccount } from "../../src/mail/accounts";
import {
  ensureTaxonomyFolders,
  getMessage,
  isTransientMailError,
  listInboxHeads,
  listMailboxes,
  messageLink,
  transportLabel,
  TAXONOMY_FOLDERS,
} from "../../src/mail/driver";
import { closeImapConnections } from "../../src/mail/imapClient";
import { loadPollState } from "../../src/mail/pollState";

/**
 * One DRY poll pass against every configured account, whichever transport it uses —
 * smoke test for after an Apple Mail account's initial sync settles, and the way to
 * check a NEWLY added account before it goes live.
 *
 *   npm run outlook:test                      (or: npx tsx scripts/dev/outlook-poll-test.ts)
 *   npm run outlook:test -- --ensure-folders  (also CREATES the missing taxonomy folders)
 *
 * Read-only by default: prints each account's folders, the newest inbox heads, what
 * the poller WOULD treat as new vs already-seen, and a body preview of the newest
 * message. It never triages, never moves/marks anything, and never writes poll state.
 * `--ensure-folders` is the one exception — it creates the taxonomy folders up front,
 * so a brand-new IMAP account's first real `file` isn't also its first write.
 */

const ENSURE_FOLDERS = process.argv.includes("--ensure-folders");

async function checkAccount(account: MailAccount): Promise<void> {
  console.log(`\n— mail dry poll [${account.key}] "${account.accountName}" (${account.label}) via ${transportLabel(account)} —`);

  const state = loadPollState(account.key);
  if (state) {
    console.log(`state: watermark=${new Date(state.watermark * 1000).toISOString()}, seen=${state.seen.length}`);
  } else {
    console.log("state: none yet — first live tick will BASELINE (mark existing mail seen, triage only new arrivals)");
  }

  const folders = await listMailboxes(account);
  console.log(`\nfolders (${folders.length}): ${folders.join(", ") || "(none visible)"}`);
  const lower = folders.map((f) => f.toLowerCase());
  const missing = TAXONOMY_FOLDERS.filter((f) => !lower.includes(f.toLowerCase()));
  if (!missing.length) {
    console.log("taxonomy folders: all present");
  } else if (ENSURE_FOLDERS) {
    const created = await ensureTaxonomyFolders(account);
    console.log(`taxonomy folders created: ${created.join(", ") || "(none — they showed up on their own)"}`);
  } else {
    console.log(`taxonomy folders to be auto-created on first file: ${missing.join(", ")}`);
  }

  const heads = await listInboxHeads(15, 0, account);
  if (!heads.length) {
    console.log("\ninbox: empty (or still syncing)");
    return;
  }
  console.log(`\nnewest ${heads.length} inbox messages (what a live tick would consider):`);
  const seen = new Set(state?.seen ?? []);
  for (const h of heads) {
    const isNew = state ? !seen.has(h.messageId) && h.dateEpoch > state.watermark - 3600 : false;
    const verdict = state ? (isNew ? "WOULD TRIAGE" : "seen/settled") : "baseline (skip)";
    console.log(
      `  [${verdict}] ${new Date(h.dateEpoch * 1000).toISOString()} | ${h.read ? "read" : "UNREAD"} | ${h.sender} | ${h.subject.slice(0, 70)}`,
    );
  }

  const newest = heads[0];
  console.log(`\nbody preview of newest ("${newest.subject.slice(0, 60)}"):`);
  const full = await getMessage(newest.messageId, account);
  console.log(`  link: ${messageLink(full.messageId, account)}`);
  console.log(`  attachments: ${full.attachments.join(", ") || "none"}`);
  const preview = full.body.replace(/\s+/g, " ").slice(0, 400);
  console.log(`  ${preview || "(empty body — content+source both blank; check again after sync)"}`);
}

async function main(): Promise<void> {
  const accounts = getAccounts();
  for (const account of accounts) {
    try {
      await checkAccount(account);
    } catch (e) {
      // One account's transport being down must not hide the other account's report.
      const msg = String((e as Error)?.message ?? e);
      console.error(`  FAILED [${account.key}]: ${msg}`);
      if (isTransientMailError(account, msg)) {
        console.error("  (transient — Mail.app mid-sync, or the IMAP connection dropped; retry in a minute)");
      }
      failed = true;
    }
  }
  console.log(`\ndry pass done — nothing was triaged, moved, or written${ENSURE_FOLDERS ? " except the taxonomy folders" : ""}.`);
}

let failed = false;

main()
  .catch((e) => {
    console.error(`\nfailed: ${String(e?.message ?? e)}`);
    failed = true;
  })
  // An open IMAP socket keeps node alive, so a script that read mail would never exit.
  .finally(async () => {
    await closeImapConnections();
    process.exit(failed ? 1 : 0);
  });
