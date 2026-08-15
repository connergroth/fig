import assert from "node:assert/strict";

import { getAccounts, type MailAccount } from "./accounts";
import { canSend, sendMail } from "./driver";
import { cannotSendNote, outlookServer, OUTLOOK_AGENT_TOOLS } from "./tools";

/**
 * Sending is the one capability the two transports do NOT share: IMAP accounts have SMTP,
 * and Apple Mail over AppleScript has no programmatic send at all. Everything here pins
 * that asymmetry as a REFUSAL rather than a surprise — a dispatch that quietly did
 * nothing, or a bare crash the model reads as "email is broken", are both worse than a
 * sentence naming the account that would work.
 *
 * Nothing here opens an SMTP connection: every assertion is on the guard in FRONT of the
 * socket, which is the whole point of having one.
 */

const exchange: MailAccount = {
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

function testCanSendFollowsTransport(): void {
  assert.equal(canSend(personal), true, "imap = IMAP for reads, SMTP for sends");
  assert.equal(canSend(exchange), false, "AppleScript can drive Mail.app's UI, not its outbox");
}

/** The refusal has to name the TRANSPORT, or the next reader blames the account instead. */
function testSendRefusesAppleMail(): void {
  assert.throws(
    () => sendMail({ to: "a@example.com", subject: "hi", body: "hi", confirm: true }, exchange),
    (e: Error) => /outlook/.test(e.message) && /Apple Mail\/AppleScript/.test(e.message) && /imap-transport/.test(e.message),
    "the throw must say WHY this account can't send, not just that it can't",
  );
}

/**
 * The tool's guard answers in text. If this ever becomes a throw, the model retries the
 * identical call instead of switching accounts — which is the failure this wording exists
 * to prevent.
 */
async function testToolAnswersInsteadOfThrowing(): Promise<void> {
  const note = cannotSendNote(exchange);
  assert.match(note, /Can't send from Outlook \(school\)/);
  assert.match(note, /draft/, "it has to point at the thing that DOES work here");

  // Drive the registered tool for real, on a configured Apple Mail account if this machine
  // has one. Only that direction is safe to exercise: an imap account would reach the socket.
  const appleMail = getAccounts().find((a) => !canSend(a));
  if (!appleMail) return;
  // Reaching into the registered tools is how src/tools/registry.test.ts checks this
  // server too — the alternative is exporting the handler purely so a test can call it.
  const registered = (
    outlookServer as unknown as {
      instance: {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }> }
        >;
      };
    }
  ).instance._registeredTools;
  const result = await registered.send.handler({ to: "a@example.com", subject: "hi", body: "hi", account: appleMail.key }, {});
  const out = result.content[0].text;
  assert.equal(out, cannotSendNote(appleMail), "the handler returns the note verbatim — no throw, no empty reply");
}

/** The specialist reaches it by name; triage is denied it by name (see ./triage.ts). */
function testSendIsOnTheAllowlist(): void {
  assert.ok(OUTLOOK_AGENT_TOOLS.includes("mcp__outlook__send"));
}

async function main(): Promise<void> {
  testCanSendFollowsTransport();
  testSendRefusesAppleMail();
  await testToolAnswersInsteadOfThrowing();
  testSendIsOnTheAllowlist();
  console.log("driver.test.ts: all mail send-path guard tests passed");
}

main();
