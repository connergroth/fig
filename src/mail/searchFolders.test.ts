import assert from "node:assert/strict";

import type { ImapFlow, ListResponse } from "imapflow";

import { searchableMailboxes } from "./imapAccount";
import type { MailAccount } from "./accounts";
import {
  defaultSearchFolders,
  INBOX_FOLDER,
  isExcludedSearchFolder,
  mergeSearchHits,
  searchScript,
  SENT_FOLDER_NAMES,
  TAXONOMY_FOLDERS,
  type MailHead,
} from "./outlookMail";

/**
 * Search used to mean "the Inbox", on both transports. Triage's whole job is moving mail
 * OUT of the Inbox, so the two were structurally at odds: a filed message is unfindable by
 * keyword on the account holding it, while `get` returns it in full by id. These pin the
 * folder scope on each transport — which folders get walked,
 * which are deliberately skipped, and that a hit says where it lives.
 */

const exchange: MailAccount = {
  key: "outlook",
  accountName: "Exchange",
  label: "Outlook (school)",
  transport: "applemail",
};

/** Enough of a LIST response for the mailbox picker; it only reads path/name/flags/specialUse. */
function box(path: string, over: Partial<ListResponse> = {}): ListResponse {
  return { path, name: path.split("/").pop() ?? path, flags: new Set<string>(), ...over } as ListResponse;
}

function fakeClient(boxes: ListResponse[]): Pick<ImapFlow, "list"> {
  return { list: async () => boxes } as unknown as Pick<ImapFlow, "list">;
}

/** The default on IMAP is EVERYTHING selectable — the folder is exactly what's unknown. */
async function testImapDefaultsToEveryFolder(): Promise<void> {
  const boxes = await searchableMailboxes(
    fakeClient([
      box("INBOX"),
      box("Waiting"),
      box("Receipts"),
      box("Archive"),
      box("Sent", { specialUse: "\\Sent" }),
      box("Junk", { specialUse: "\\Junk" }),
      box("Trash", { specialUse: "\\Trash" }),
    ]),
  );
  assert.deepEqual(boxes, ["INBOX", "Waiting", "Receipts", "Archive", "Sent"]);
  assert.equal(boxes[0], "INBOX", "the Inbox is walked first — most searches end there");
}

/** Trash/Junk are skipped by NAME too: not every server sets the special-use flags. */
async function testImapSkipsTrashAndJunkByName(): Promise<void> {
  const boxes = await searchableMailboxes(
    fakeClient([box("INBOX"), box("Deleted Items"), box("Junk E-mail"), box("Spam"), box("Newsletters")]),
  );
  assert.deepEqual(boxes, ["INBOX", "Newsletters"]);
  assert.ok(isExcludedSearchFolder("trash") && isExcludedSearchFolder("Junk") && isExcludedSearchFolder("Spam"));
  assert.ok(!isExcludedSearchFolder("Receipts"), "a taxonomy folder is never excluded");
}

/** A \Noselect container can't be SELECTed at all — walking one is an error, not a miss. */
async function testImapSkipsNoselectContainers(): Promise<void> {
  const boxes = await searchableMailboxes(
    fakeClient([box("INBOX"), box("Folders", { flags: new Set(["\\Noselect", "\\HasChildren"]) }), box("Folders/Work")]),
  );
  assert.deepEqual(boxes, ["INBOX", "Folders/Work"]);
}

/** Naming folders narrows it — and a name this account doesn't have is dropped, not fatal. */
async function testImapHonorsNamedFolders(): Promise<void> {
  const boxes = await searchableMailboxes(fakeClient([box("INBOX"), box("Receipts"), box("Trash")]), [
    "receipts",
    "Nonexistent",
    "Trash",
  ]);
  assert.deepEqual(boxes, ["Receipts", "Trash"], "an explicitly named Trash IS searched — narrowing is the caller's call");
}

/**
 * The AppleScript side can't ask a server to search, so its coverage is whatever the
 * generated script walks. Assert the walk, since nothing else can: every taxonomy folder,
 * plus Sent under either name, each resolved in a `try` so a missing one is skipped.
 */
function testAppleScriptWalksEveryTaxonomyFolder(): void {
  const script = searchScript(["chicagotrading"], 25, exchange);
  assert.deepEqual(defaultSearchFolders(), [INBOX_FOLDER, ...TAXONOMY_FOLDERS, ...SENT_FOLDER_NAMES]);
  assert.match(script, /set end of boxList to \{theInbox, "INBOX"\}/);
  for (const folder of TAXONOMY_FOLDERS) {
    assert.match(
      script,
      new RegExp(`try\\nset end of boxList to \\{mailbox "${folder}" of theAcct, "${folder}"\\}\\nend try`),
      `${folder} must be walked, and inside a try so a not-yet-created folder isn't fatal`,
    );
  }
  for (const sent of SENT_FOLDER_NAMES) assert.ok(script.includes(`mailbox "${sent}" of theAcct`), `${sent} must be tried`);
  assert.match(script, /& boxName &/, "each record carries the folder it was found in");
}

/** The budgets are the reason this is safe to run against ten folders. Pin them. */
function testAppleScriptBudgetsAreBounded(): void {
  const script = searchScript(["ctc"], 25, exchange);
  assert.match(script, /set scanCap to 80/, "filed folders get the small scan");
  assert.match(script, /if boxName is "INBOX" then set scanCap to 300/, "the Inbox keeps the big one");
  assert.match(script, /contentUsed < 40/);
  assert.equal(
    (script.match(/set contentUsed to 0/g) ?? []).length,
    1,
    "ONE content budget for the whole run — resetting it per folder is how the 90s timeout comes back",
  );
}

/** Narrowing on the AppleScript side means walking only what was asked for. */
function testAppleScriptHonorsNamedFolders(): void {
  const script = searchScript(["ctc"], 25, exchange, ["Receipts"]);
  assert.match(script, /mailbox "Receipts" of theAcct/);
  assert.ok(!script.includes("theInbox, \"INBOX\""), "a named-folder search does not silently add the Inbox");
  assert.ok(!script.includes(`mailbox "Promos"`));
}

/** Merging is what makes per-folder results one answer: newest first, deduped, capped. */
function testMergeIsNewestFirstDedupedAndCapped(): void {
  const head = (messageId: string, dateEpoch: number, folder: string): MailHead => ({
    messageId,
    dateEpoch,
    read: false,
    sender: "a@b.c",
    subject: "s",
    folder,
  });
  const merged = mergeSearchHits(
    [head("old@x", 100, "INBOX"), head("new@x", 300, "Receipts"), head("mid@x", 200, "Sent"), head("new@x", 300, "Sent Items")],
    2,
  );
  assert.deepEqual(
    merged.map((h) => h.messageId),
    ["new@x", "mid@x"],
  );
  assert.equal(merged[0].folder, "Receipts", "the first folder that reported it wins the location");
  assert.equal(merged.length, 2, "the cap is the caller's limit, not per folder");
}

async function main(): Promise<void> {
  await testImapDefaultsToEveryFolder();
  await testImapSkipsTrashAndJunkByName();
  await testImapSkipsNoselectContainers();
  await testImapHonorsNamedFolders();
  testAppleScriptWalksEveryTaxonomyFolder();
  testAppleScriptBudgetsAreBounded();
  testAppleScriptHonorsNamedFolders();
  testMergeIsNewestFirstDedupedAndCapped();
  console.log("searchFolders.test.ts: all mail search folder-scope tests passed");
}

main();
