import assert from "node:assert/strict";

import { LEGACY_ACCOUNT_KEY, legacyMailAccount, parseMailAccounts, resolveMailAccounts } from "./accounts";

/**
 * The registry replaced a module constant that hardcoded ONE Mail.app account, so the
 * thing worth pinning is the fallback: with the new env vars absent, an untouched .env
 * must still describe exactly the account the driver used to address — same key, same
 * name, same transport — or the poller re-baselines against a state file it no longer
 * recognizes.
 *
 * The second thing pinned here is the TRANSPORT field, which decides whether an account
 * is driven through Mail.app or over IMAP. Getting it wrong isn't subtle at runtime, but
 * getting the FALLBACK wrong is: a missing transport must mean `applemail`, never "skip".
 */

const silent = () => {};

function testDelimitedShape(): void {
  const accounts = parseMailAccounts(
    "outlook|Exchange|Outlook (school); personal|you@example.com|you@example.com (personal)",
    silent,
  );
  assert.deepEqual(accounts, [
    { key: "outlook", accountName: "Exchange", label: "Outlook (school)", transport: "applemail" },
    { key: "personal", accountName: "you@example.com", label: "you@example.com (personal)", transport: "applemail" },
  ]);
  assert.equal(accounts[0].key, LEGACY_ACCOUNT_KEY, "the first record is the primary — order is the contract");
}

/** Real Mail.app account names hold spaces, commas and colons. The pipe is why. */
function testAwkwardNamesSurvive(): void {
  const [account] = parseMailAccounts("work|Exchange: Someone, Uni|School: mail", silent);
  assert.equal(account.accountName, "Exchange: Someone, Uni");
  assert.equal(account.label, "School: mail");
}

function testLabelIsOptional(): void {
  const [account] = parseMailAccounts("personal|you@example.com", silent);
  assert.equal(account.label, "you@example.com", "no label given → the account name IS the label");
}

/** The imap env block: what's required, what defaults, and where the prefix comes from. */
function testImapTransport(): void {
  const env = {
    PRIVATEEMAIL_ADDRESS: "you@example.com",
    PRIVATEEMAIL_PASSWORD: "hunter2",
    PRIVATEEMAIL_IMAP_HOST: "mail.privateemail.com",
  };
  const [account] = parseMailAccounts(
    "personal|you@example.com|you@example.com (personal)|imap:PRIVATEEMAIL",
    silent,
    env,
  );
  assert.equal(account.transport, "imap");
  assert.equal(account.imap?.host, "mail.privateemail.com");
  assert.equal(account.imap?.port, 993, "implicit-TLS IMAP by default");
  assert.equal(account.imap?.smtpHost, "mail.privateemail.com", "SMTP defaults to the IMAP host");
  assert.equal(account.imap?.smtpPort, 465, "implicit-TLS SMTP by default");
  assert.equal(account.imap?.user, "you@example.com");
  assert.equal(account.imap?.password, "hunter2");
  assert.equal(account.imap?.webmailUrl, "https://mail.privateemail.com/", "IMAP has no per-message link — this is the fallback");

  // A password must never ride along into a log line or a state dump.
  assert.match(JSON.stringify(account), /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(account), /hunter2/);

  // No explicit prefix → the account key, uppercased.
  const [byKey] = parseMailAccounts("privateemail|you@example.com||imap", silent, env);
  assert.equal(byKey.imap?.user, "you@example.com");

  // Overrides are honored, since not every provider is this one.
  const [custom] = parseMailAccounts("personal|a@b.com||imap:P", silent, {
    P_ADDRESS: "a@b.com",
    P_PASSWORD: "x",
    P_IMAP_HOST: "imap.b.com",
    P_IMAP_PORT: "1993",
    P_SMTP_HOST: "smtp.b.com",
    P_SMTP_PORT: "1465",
    P_WEBMAIL_URL: "https://webmail.b.com/inbox",
  });
  assert.deepEqual(
    [custom.imap?.host, custom.imap?.port, custom.imap?.smtpHost, custom.imap?.smtpPort, custom.imap?.webmailUrl],
    ["imap.b.com", 1993, "smtp.b.com", 1465, "https://webmail.b.com/inbox"],
  );
}

/**
 * Half-configured is worse than absent: it would connect to a wrong host carrying a real
 * password, or crash the poller for the OTHER account. Skip loudly instead.
 */
function testImapWithoutCredsIsSkipped(): void {
  const warns: string[] = [];
  const accounts = parseMailAccounts(
    "outlook|Exchange|School; personal|you@example.com||imap:PRIVATEEMAIL",
    (m) => warns.push(m),
    { PRIVATEEMAIL_ADDRESS: "you@example.com" }, // no password, no host
  );
  assert.deepEqual(accounts.map((a) => a.key), ["outlook"], "the healthy account still polls");
  assert.ok(warns.some((w) => /PRIVATEEMAIL_PASSWORD/.test(w) && /PRIVATEEMAIL_IMAP_HOST/.test(w)), warns.join("\n"));

  const bad: string[] = [];
  assert.deepEqual(parseMailAccounts("personal|x|y|pop3", (m) => bad.push(m), {}), []);
  assert.ok(bad.some((w) => /unknown transport "pop3"/.test(w)));
}

/** One malformed record must never cost the other account its mail. */
function testBadRecordsAreSkippedNotFatal(): void {
  const warns: string[] = [];
  const accounts = parseMailAccounts(
    "outlook|Exchange; ; nokey; bad key|Whatever; outlook|Duplicate; personal|you@example.com",
    (m) => warns.push(m),
  );
  assert.deepEqual(
    accounts.map((a) => a.key),
    ["outlook", "personal"],
  );
  assert.equal(warns.length, 3, "every skipped record is reported (an empty one is just whitespace, not a mistake)");
  assert.ok(
    warns.some((w) => /duplicate key "outlook"/.test(w)),
    "a duplicate key keeps the FIRST record and says so",
  );
}

/** The whole backward-compatibility promise, in one function. */
function testEnvFallback(): void {
  assert.deepEqual(resolveMailAccounts({}, silent), [
    { key: "outlook", accountName: "Exchange", label: "Outlook (school)", transport: "applemail" },
  ]);
  assert.deepEqual(resolveMailAccounts({ OUTLOOK_MAIL_ACCOUNT: "CU Exchange" }, silent), [
    { key: "outlook", accountName: "CU Exchange", label: "Outlook (school)", transport: "applemail" },
  ]);
  assert.deepEqual(legacyMailAccount("  "), legacyMailAccount(), "blank env is the same as unset");

  // Set but unusable: fall back rather than start with zero accounts and poll nothing.
  const warns: string[] = [];
  const accounts = resolveMailAccounts({ APPLE_MAIL_ACCOUNTS: "garbage" }, (m) => warns.push(m));
  assert.deepEqual(accounts, [legacyMailAccount()]);
  assert.ok(warns.some((w) => /falling back/.test(w)));

  assert.deepEqual(
    resolveMailAccounts({ APPLE_MAIL_ACCOUNTS: "personal|you@example.com", OUTLOOK_MAIL_ACCOUNT: "Exchange" }, silent),
    [{ key: "personal", accountName: "you@example.com", label: "you@example.com", transport: "applemail" }],
    "an explicit registry wins outright — it isn't merged with the legacy account",
  );

  // MAIL_ACCOUNTS is the general form and outranks the Apple-Mail-only one.
  assert.deepEqual(
    resolveMailAccounts(
      { MAIL_ACCOUNTS: "outlook|Exchange|School", APPLE_MAIL_ACCOUNTS: "other|Something|Else" },
      silent,
    ).map((a) => a.key),
    ["outlook"],
  );
  // …but an unusable MAIL_ACCOUNTS falls through to it rather than polling nothing.
  assert.deepEqual(
    resolveMailAccounts({ MAIL_ACCOUNTS: "garbage", APPLE_MAIL_ACCOUNTS: "other|Something|Else" }, silent).map((a) => a.key),
    ["other"],
  );
}

function main(): void {
  testDelimitedShape();
  testAwkwardNamesSurvive();
  testLabelIsOptional();
  testImapTransport();
  testImapWithoutCredsIsSkipped();
  testBadRecordsAreSkippedNotFatal();
  testEnvFallback();
  console.log("accounts.test.ts: all mail account registry tests passed");
}

main();
