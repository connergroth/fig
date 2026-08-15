import assert from "node:assert/strict";

import type { FetchMessageObject } from "imapflow";

import type { MailAccount } from "./accounts";
import { messageHead, normalizeMessageId, parseSyntheticUid, syntheticMessageId } from "./imapAccount";

/**
 * Message-ID keying is the single contract that lets one poll state, one retry ledger and
 * one taxonomy serve both transports. IMAP hands back `<id@host>`; Apple Mail's `message
 * id` hands back `id@host`. If those two forms ever reach the seen-set as different
 * strings, nothing errors — the poller simply re-triages the same mail forever and pings
 * The owner for every message on every tick. That's what these pin.
 */

const account: MailAccount = {
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

function fetched(over: Partial<FetchMessageObject>): FetchMessageObject {
  return { seq: 1, uid: 42, ...over } as FetchMessageObject;
}

function testIdNormalization(): void {
  assert.equal(normalizeMessageId("<abc123@mail.example.com>"), "abc123@mail.example.com");
  assert.equal(normalizeMessageId("  <abc123@mail.example.com>  "), "abc123@mail.example.com");
  assert.equal(normalizeMessageId("abc123@mail.example.com"), "abc123@mail.example.com", "already bare = unchanged");
  assert.equal(
    normalizeMessageId(normalizeMessageId("<abc123@mail.example.com>")),
    normalizeMessageId("<abc123@mail.example.com>"),
    "idempotent — a stored id re-normalizes to itself",
  );
  assert.equal(normalizeMessageId(""), "");
}

function testHeadKeysOnBareId(): void {
  const head = messageHead(
    fetched({
      envelope: {
        messageId: "<CADq0R=abc@mail.gmail.com>",
        subject: "Interview scheduling",
        date: new Date("2026-08-03T18:04:05Z"),
        from: [{ name: "Recruiting", address: "jobs@example.com" }],
      },
      flags: new Set(["\\Seen"]),
    }),
    account,
  );
  assert.equal(head.messageId, "CADq0R=abc@mail.gmail.com", "brackets are stripped — this is Apple Mail's form");
  assert.equal(head.sender, "Recruiting <jobs@example.com>", "same 'Name <addr>' shape the AppleScript driver reports");
  assert.equal(head.subject, "Interview scheduling");
  assert.equal(head.dateEpoch, Math.floor(Date.parse("2026-08-03T18:04:05Z") / 1000));
  assert.equal(head.read, true, "\\Seen is the read flag");

  const unread = messageHead(fetched({ envelope: { messageId: "<x@y>" }, flags: new Set() }), account);
  assert.equal(unread.read, false);
  assert.equal(unread.sender, "", "no From header is empty, not a crash");
}

/** A sender with no Message-ID must still be triageable, and findable again afterwards. */
function testSyntheticIdRoundTrips(): void {
  const head = messageHead(fetched({ uid: 907, envelope: { subject: "no message-id header" } }), account);
  assert.equal(head.messageId, syntheticMessageId(907, account));
  assert.equal(parseSyntheticUid(head.messageId, account), 907, "the id reads back as the UID `locate` needs");
  assert.equal(parseSyntheticUid(`<${head.messageId}>`, account), 907, "bracketed form too");

  // Scoped to its account: another account's synthetic id must not resolve here, or one
  // inbox's UID would be looked up in the other's mailbox.
  assert.equal(parseSyntheticUid(head.messageId, { ...account, key: "outlook" }), 0);
  assert.equal(parseSyntheticUid("real-id@example.com", account), 0, "a real message id is never treated as a UID");
}

/** internalDate is the fallback when the envelope carries no Date header. */
function testDateFallback(): void {
  const head = messageHead(
    fetched({ envelope: { messageId: "<x@y>" }, internalDate: new Date("2026-01-02T03:04:05Z") }),
    account,
  );
  assert.equal(head.dateEpoch, Math.floor(Date.parse("2026-01-02T03:04:05Z") / 1000));
  assert.equal(messageHead(fetched({ envelope: { messageId: "<x@y>" } }), account).dateEpoch, 0, "no date at all = 0");
}

function main(): void {
  testIdNormalization();
  testHeadKeysOnBareId();
  testSyntheticIdRoundTrips();
  testDateFallback();
  console.log("imapAccount.test.ts: all IMAP message-id keying tests passed");
}

main();
