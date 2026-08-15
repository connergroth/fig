import assert from "node:assert/strict";

import type { MsgSummary } from "../google/gmail";
import type { MailAccount } from "./accounts";
import type { MailHead } from "./outlookMail";
import { formatSearchAll, keywordQuery, mailSearchServer, searchAllMail, type SearchAllDeps } from "./searchAll";
import { outlookServer } from "./tools";

/**
 * The bug this fans out to prevent: a keyword search comes back empty on the account that is
 * holding the message while `get` returns that exact message in full by id, and fig reports
 * "no such email". Two causes stack — a search scoped to one account, and a search scoped to
 * INBOX on an account whose mail triage has already filed elsewhere.
 *
 * So these pin the properties that make an empty result MEAN something: every surface is
 * asked, one broken surface can't delete another's hits, a failure is never silently
 * folded into "no matches", and a gmail-shaped query still reaches the backends that
 * can't parse gmail operators.
 *
 * The narrowing cases are the same property one level down. `account`/`folder` came over
 * from the deleted `mcp__outlook__search`, and they make this call cover LESS than its name
 * says — so each one has to be visible in the answer, and a narrowing string that matches
 * nothing has to throw rather than quietly widen back out to everything.
 */

const school: MailAccount = {
  key: "outlook",
  accountName: "Exchange",
  label: "Outlook (school)",
  transport: "applemail",
};

const personal: MailAccount = {
  key: "personal",
  accountName: "you@example.com",
  label: "you@example.com (personal)",
  transport: "imap",
  imap: {
    host: "mail.privateemail.com",
    port: 993,
    smtpHost: "mail.privateemail.com",
    smtpPort: 465,
    user: "you@example.com",
    password: "unused-here",
    webmailUrl: "https://mail.privateemail.com/",
  },
};

function head(over: Partial<MailHead>): MailHead {
  return { messageId: "id@x", dateEpoch: 1_000, read: false, sender: "a@b.c", subject: "s", ...over };
}

function gmailMsg(over: Partial<MsgSummary>): MsgSummary {
  return {
    id: "g1",
    threadId: "t1",
    from: "someone@gmail.com",
    subject: "hello",
    date: "Tue, 4 Aug 2026 13:54:08 -0700",
    snippet: "",
    unread: false,
    labels: ["INBOX"],
    account: "personal-gmail",
    ...over,
  };
}

/** Deps that record what they were asked, so "did it ask everyone" is checkable. */
function deps(over: Partial<SearchAllDeps> = {}): SearchAllDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    gmailSearch: async (q) => {
      asked.push(`gmail:${q}`);
      return [];
    },
    gmailLink: (id) => `https://mail.google.com/mail/u/0/#all/${id}`,
    mailAccounts: () => [school, personal],
    mailSearch: async (q, _limit, account, folders) => {
      asked.push(`${account.key}:${q}${folders ? `:${folders.join("+")}` : ""}`);
      return [];
    },
    mailLink: (_id, account) => (account.transport === "imap" ? "https://mail.privateemail.com/" : "message://x"),
    mailLinkOpensMessage: (account) => account.transport !== "imap",
    ...over,
  };
}

/** Every configured surface gets asked on ONE call — that's the whole point of the tool. */
async function testAsksEverySurface(): Promise<void> {
  const d = deps();
  const outcome = await searchAllMail("chicagotrading", { limit: 10 }, d);
  assert.deepEqual(d.asked.sort(), ["gmail:chicagotrading", "outlook:chicagotrading", "personal:chicagotrading"]);
  assert.deepEqual(outcome.hits, []);
  assert.equal(outcome.searched.length, 3, "the answer says what 'nothing' actually covered");
  assert.deepEqual(outcome.skipped, [], "nothing is skipped unless the caller narrowed");
}

/** Merged newest-first across backends — otherwise the newest hit hides under a backend block. */
async function testMergesNewestFirst(): Promise<void> {
  const d = deps({
    gmailSearch: async () => [gmailMsg({ id: "g-old", date: "Mon, 3 Aug 2026 10:00:00 -0700" })],
    mailSearch: async (_q, _l, account) =>
      account.key === "personal"
        ? [head({ messageId: "ctc@chicagotrading.com", dateEpoch: Date.parse("2026-08-04T20:54:08Z") / 1000, folder: "Waiting" })]
        : [head({ messageId: "school@cu", dateEpoch: Date.parse("2026-07-01T00:00:00Z") / 1000, folder: "INBOX" })],
  });
  const { hits } = await searchAllMail("ctc", { limit: 10 }, d);
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["ctc@chicagotrading.com", "g-old", "school@cu"],
  );
  assert.equal(hits[0].folder, "Waiting", "a filed message reports WHERE it lives, not 'inbox'");
  assert.equal(hits[0].account, personal.label);
  assert.equal(hits[1].backend, "gmail");
}

/**
 * One dead backend must cost its own results and NOTHING else — and must be named. A
 * survivors-only answer is exactly how "not found" became a lie the first time.
 */
async function testOneFailureDoesNotEatTheOthers(): Promise<void> {
  const d = deps({
    gmailSearch: async () => [gmailMsg({ id: "g1" })],
    mailSearch: async (_q, _l, account) => {
      if (account.key === "outlook") throw new Error("Mail.app is mid-sync (-1712)");
      return [head({ messageId: "p1", dateEpoch: 2_000 })];
    },
  });
  const outcome = await searchAllMail("ctc", { limit: 10 }, d);
  assert.deepEqual(outcome.hits.map((h) => h.messageId).sort(), ["g1", "p1"]);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].account, school.label);
  assert.match(outcome.failures[0].error, /mid-sync/);

  const printed = formatSearchAll(outcome, "ctc");
  assert.match(printed, /DID NOT ANSWER/, "a broken backend has to be visible next to the hits");
  assert.match(printed, /Outlook \(school\)/);

  // And with zero hits, the failure must survive into the "no matches" answer.
  const empty = formatSearchAll({ hits: [], failures: outcome.failures, searched: outcome.searched, skipped: [] }, "ctc");
  assert.match(empty, /No matches/);
  assert.match(empty, /DID NOT ANSWER/, "'no matches' plus a silent failure is the original bug");
}

/**
 * A gmail-shaped query reaches the other backends as keywords. Sent verbatim, `from:x` is
 * a substring that appears in no message, so the accounts holding the mail answer empty.
 */
function testKeywordTranslation(): void {
  assert.equal(keywordQuery("chicagotrading"), "chicagotrading");
  assert.equal(keywordQuery("from:recruiting@chicagotrading.com"), "recruiting@chicagotrading.com");
  assert.equal(keywordQuery("is:unread in:inbox newer_than:2d samsara"), "samsara", "gmail machinery is dropped");
  assert.equal(keywordQuery("subject:\"offer letter\""), "offer letter");
  assert.equal(keywordQuery("-from:noreply@x.com samsara"), "samsara", "a negation can't be ANDed, so it's dropped");
  assert.equal(keywordQuery("samsara OR drw"), "samsara drw");
  assert.equal(keywordQuery("is:unread"), "", "operator-only leaves nothing the other backends can match");
}

/** An operator-only query must not turn into "search for the empty string" = whole mailbox. */
async function testOperatorOnlyQuerySkipsFolderBackends(): Promise<void> {
  const d = deps();
  await searchAllMail("is:unread", { limit: 10 }, d);
  assert.deepEqual(d.asked, ["gmail:is:unread"], "gmail can answer it; the others aren't asked for everything");
}

/** Narrowed + operators-only = nothing was asked at all. That can't print as "no matches". */
async function testNothingSearchedSaysSo(): Promise<void> {
  const d = deps();
  const outcome = await searchAllMail("is:unread", { account: "outlook" }, d);
  assert.deepEqual(d.asked, [], "gmail is excluded by the narrowing, the account has no keywords");
  const printed = formatSearchAll(outcome, "is:unread");
  assert.match(printed, /NOTHING WAS SEARCHED/);
  assert.doesNotMatch(printed, /Searched 0 surfaces/);
}

/** The IMAP link opens webmail, not the message — the answer must not promise otherwise. */
async function testImapLinkIsHonest(): Promise<void> {
  const d = deps({ mailSearch: async (_q, _l, a) => (a.key === "personal" ? [head({ messageId: "p1" })] : []) });
  const { hits } = await searchAllMail("ctc", { limit: 10 }, d);
  assert.match(hits[0].link, /webmail root, not this message/);
}

/**
 * Narrowing to one account means gmail was NOT asked — and the answer has to SAY that.
 * "no matches on the personal account" and "gmail found nothing" are different claims, and
 * printing the second one from a run that never called gmail is the lie this file exists
 * to stop.
 */
async function testAccountNarrowingExcludesGmail(): Promise<void> {
  const d = deps();
  const outcome = await searchAllMail("chicagotrading", { limit: 10, account: "personal" }, d);
  assert.deepEqual(d.asked, ["personal:chicagotrading"], "only the named account, and NOT gmail");
  assert.deepEqual(outcome.searched, [personal.label]);
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].account, /gmail/);
  assert.match(formatSearchAll(outcome, "chicagotrading"), /NOT SEARCHED/);
}

/** The label and the address are what the model has SEEN — all three have to resolve. */
async function testAccountNarrowingAcceptsLabelAndAddress(): Promise<void> {
  for (const name of ["PERSONAL", personal.label, "you@example.com"]) {
    const d = deps();
    await searchAllMail("ctc", { account: name }, d);
    assert.deepEqual(d.asked, ["personal:ctc"], `"${name}" must resolve to the personal account`);
  }
}

/** An account string nobody recognizes must never silently become "search everything". */
async function testUnknownAccountThrows(): Promise<void> {
  const d = deps();
  await assert.rejects(
    () => searchAllMail("ctc", { account: "gmail" }, d),
    (e: Error) => {
      assert.match(e.message, /unknown mail account "gmail"/);
      assert.match(e.message, /personal/, "the throw names the accounts that DO exist");
      return true;
    },
  );
  assert.deepEqual(d.asked, [], "nothing was searched — a wrong scope is not partially honored");
}

/** `folder` reaches the driver as the folders array, and drops gmail (it has no folders). */
async function testFolderNarrowingReachesTheDeps(): Promise<void> {
  const d = deps();
  const outcome = await searchAllMail("receipt", { limit: 10, folder: " Receipts " }, d);
  assert.deepEqual(d.asked.sort(), ["outlook:receipt:Receipts", "personal:receipt:Receipts"]);
  assert.deepEqual(outcome.searched, [`${school.label} (Receipts only)`, `${personal.label} (Receipts only)`]);
  assert.equal(outcome.skipped.length, 1, "gmail is skipped, and named");
  assert.match(outcome.skipped[0].reason, /in:\/label:/, "and it says how to narrow the gmail side instead");
}

/** Same reach-into-the-registered-tools trick registry.test.ts uses on these servers. */
function registeredTools(server: unknown): Record<string, { description: string }> {
  return (server as { instance: { _registeredTools: Record<string, { description: string }> } }).instance._registeredTools;
}

/**
 * The tool DESCRIPTIONS are the interface the model actually reads. The old outlook search
 * told it to "run them all to be sure" — an instruction that was both the workaround and
 * the bug. That tool is now DELETED rather than deprecated in prose: a second, narrower
 * door onto "find an email" is a door someone opens by accident.
 */
function testThereIsExactlyOneSearchTool(): void {
  const find = registeredTools(mailSearchServer).find;
  assert.ok(find, "the cross-backend search must be published as mcp__mailsearch__find");
  assert.match(find.description, /Gmail/);
  assert.match(find.description, /every folder/i);
  assert.match(find.description, /SKIPS GMAIL/i, "narrowing's cost has to be in the description");
  assert.match(find.description, /in:\/label:/, "and where to narrow the gmail side instead");

  const outlookTools = Object.keys(registeredTools(outlookServer));
  assert.ok(!outlookTools.includes("search"), "the per-account search is gone, not deprecated");
  assert.ok(outlookTools.includes("get"), "the rest of the outlook server is untouched");
}

/** The triage allowlist has to name a tool some MOUNTED server actually publishes. */
async function testTriageCanStillSearch(): Promise<void> {
  const { OUTLOOK_AGENT_TOOLS } = await import("./tools");
  const { mailProvider } = await import("./triage");
  assert.ok(OUTLOOK_AGENT_TOOLS.includes("mcp__mailsearch__find"));
  assert.ok(!OUTLOOK_AGENT_TOOLS.some((t) => t === "mcp__outlook__search"));
  const provider = mailProvider(school);
  const mounted = Object.keys(provider.mcpServers);
  for (const tool of provider.allowedTools.filter((t) => t.startsWith("mcp__"))) {
    const server = tool.split("__")[1];
    assert.ok(mounted.includes(server), `triage allows ${tool} but never mounts the ${server} server`);
  }
}

async function main(): Promise<void> {
  await testAsksEverySurface();
  await testMergesNewestFirst();
  await testOneFailureDoesNotEatTheOthers();
  testKeywordTranslation();
  await testOperatorOnlyQuerySkipsFolderBackends();
  await testImapLinkIsHonest();
  await testAccountNarrowingExcludesGmail();
  await testAccountNarrowingAcceptsLabelAndAddress();
  await testUnknownAccountThrows();
  await testFolderNarrowingReachesTheDeps();
  await testNothingSearchedSaysSo();
  testThereIsExactlyOneSearchTool();
  await testTriageCanStillSearch();
  console.log("searchAll.test.ts: all cross-backend mail search tests passed");
}

main();
