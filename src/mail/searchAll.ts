import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import * as gmail from "../google/gmail";
import { describeAccounts, getAccounts, type MailAccount } from "./accounts";
import * as mail from "./driver";
import type { MailHead } from "./outlookMail";

/**
 * ONE mail search, across every account and every folder, in parallel.
 *
 * WHY: one search per surface (gmail's `list`, a per-account `search` on the outlook server)
 * plus a prompt telling the model to "run them all to be sure" has two failure modes, both
 * seen live:
 *   - a backend simply not being asked, so "not found" meant "not found in the one place
 *     I looked" (a school-account message is not in gmail, and never will be);
 *   - the non-Gmail searches being INBOX-only while triage files mail OUT of the Inbox,
 *     so a message `get` can pull in full by id comes back as zero hits on every keyword
 *     search of the account it is sitting in.
 * Neither is fixable by better instructions. The answer is one call whose default is
 * everything, and whose result says WHERE each hit lives.
 *
 * This is now the ONLY mail search: the per-account `mcp__outlook__search` is deleted, and
 * the two things it could do that this couldn't — narrow to one account, narrow to one
 * folder — are `account`/`folder` options here. Two doors onto the same question is how one
 * of them stays subtly narrower than the other and nobody notices which one they opened.
 *
 * The fan-out is `allSettled`, not `all`: one account being unreachable (Mail.app
 * mid-sync, an IMAP socket drop, a stale Google token) must not delete the other
 * accounts' hits. A backend that failed is REPORTED as failed in the same answer —
 * silently returning the survivors is how "no results" becomes a lie again.
 */

/** One message, from whichever backend, in the shape the merged answer prints. */
export interface MailHit {
  backend: "gmail" | "mail";
  /** Human account label, printed as `[label]` — what a caller says back to the owner. */
  account: string;
  /** The id `mcp__gmail__get` / `mcp__outlook__get` takes to read the message. */
  messageId: string;
  dateEpoch: number;
  read: boolean;
  sender: string;
  subject: string;
  /** Where it lives NOW: a folder name, or gmail's INBOX/Sent/archived. */
  folder: string;
  link: string;
}

export interface SearchAllOutcome {
  hits: MailHit[];
  /** Surfaces that were asked and came back broken — named, so nobody reads past them. */
  failures: { account: string; error: string }[];
  /** Surfaces actually queried, so the answer can say what "nothing" covered. */
  searched: string[];
  /**
   * Surfaces deliberately NOT asked, each with the reason — narrowing by account/folder
   * skips gmail, and an operator-only query has nothing for the keyword backends to match.
   * Printed next to the hits for the same reason `failures` is: "gmail has nothing" and
   * "gmail was never asked" are different facts and must not print as the same one.
   */
  skipped: { account: string; reason: string }[];
}

/**
 * The two backends as plain functions, so the fan-out (merge order, failure isolation,
 * query translation) is testable without a Google token or an IMAP socket.
 */
export interface SearchAllDeps {
  /** Gmail across ALL connected google accounts — it already fans out internally. */
  gmailSearch: (query: string, max: number) => Promise<gmail.MsgSummary[]>;
  gmailLink: (id: string) => string;
  mailAccounts: () => MailAccount[];
  /** `folders` omitted = every folder on the account, which is the default. */
  mailSearch: (query: string, limit: number, account: MailAccount, folders?: string[]) => Promise<MailHead[]>;
  mailLink: (messageId: string, account: MailAccount) => string;
  mailLinkOpensMessage: (account: MailAccount) => boolean;
}

export const liveDeps: SearchAllDeps = {
  gmailSearch: (query, max) => gmail.listMessagesAll({ ...(query ? { query } : {}), max }),
  gmailLink: gmail.messageWebUrl,
  mailAccounts: getAccounts,
  mailSearch: (query, limit, account, folders) => mail.searchInbox(query, limit, account, folders),
  mailLink: (messageId, account) => mail.messageLink(messageId, account),
  mailLinkOpensMessage: mail.linkOpensMessage,
};

/**
 * Gmail search operators the other backends have no equivalent for. IMAP's TEXT key and
 * the AppleScript scan both match plain substrings, so a query of `is:unread from:foo`
 * sent verbatim would match the literal string "is:unread" — i.e. nothing — and the
 * non-Gmail accounts would report empty for a message they're holding.
 *
 * Two kinds: operators whose VALUE is a real keyword (from:foo → foo), and operators that
 * are pure gmail machinery (is:, in:, newer_than:) which are dropped. What's left is the
 * keyword query the folder-walking backends can actually answer.
 */
const VALUE_OPERATORS = new Set(["from", "to", "cc", "bcc", "subject", "rfc822msgid", "filename"]);
const DROPPED_OPERATORS = new Set([
  "is",
  "in",
  "has",
  "label",
  "category",
  "newer_than",
  "older_than",
  "after",
  "before",
  "size",
  "larger",
  "smaller",
  "list",
  "deliveredto",
]);

/**
 * A gmail query rewritten as bare keywords for the non-Gmail backends. Negations are
 * DROPPED rather than translated — an AND-of-substrings can't express "not this", and
 * keeping the term would invert the filter into a requirement.
 */
export function keywordQuery(query: string): string {
  const out: string[] = [];
  for (const raw of query.trim().split(/\s+/)) {
    const token = raw.replace(/^[-(]+/, "").replace(/[)]+$/, "");
    if (!token) continue;
    if (raw.startsWith("-")) continue; // negation: unexpressible here
    if (/^(OR|AND)$/i.test(token)) continue; // this side ANDs everything anyway
    const m = token.match(/^([a-z_0-9]+):(.*)$/i);
    if (!m) {
      out.push(token.replace(/^["']|["']$/g, ""));
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^["']|["']$/g, "");
    if (DROPPED_OPERATORS.has(key)) continue;
    if (VALUE_OPERATORS.has(key)) {
      if (value) out.push(value);
      continue;
    }
    // An operator nobody here knows: keep the whole token, it may be a plain word with a
    // colon in it (a subject fragment, a URL) and dropping it would widen the search.
    out.push(token);
  }
  return out.filter(Boolean).join(" ");
}

/** Gmail has labels, not folders — say where it lives in the same column as a folder. */
function gmailFolder(labels: string[]): string {
  if (labels.includes("INBOX")) return "INBOX";
  if (labels.includes("SENT")) return "Sent";
  if (labels.includes("DRAFT")) return "Drafts";
  if (labels.includes("TRASH")) return "Trash";
  if (labels.includes("SPAM")) return "Spam";
  return "archived";
}

/** Narrowing options. Every one of them is opt-in; the default is genuinely everything. */
export interface SearchAllOptions {
  /** Size of the FINAL merged list, default 25. */
  limit?: number;
  /** Restrict to ONE non-Gmail account, by key, label, or address. Skips gmail. */
  account?: string;
  /** Restrict the non-Gmail accounts to ONE folder. Skips gmail (it has no folders). */
  folder?: string;
}

/**
 * Resolve the `account` narrowing string against the configured accounts, by key, human
 * label, or the address/Mail.app identity — the model has seen all three in tool output,
 * so accepting only one of them turns a correct intent into a wrong answer.
 *
 * Unknown → THROW, naming the real accounts. Silently falling back to "search everything"
 * would be the same class of bug as the INBOX-only search: an answer whose scope is not
 * what the caller thinks it is, and which therefore can't be believed either way.
 */
export function resolveSearchAccount(accounts: MailAccount[], wanted: string): MailAccount {
  const want = wanted.trim().toLowerCase();
  const found = accounts.find((a) =>
    [a.key, a.label, a.accountName].some((v) => (v || "").toLowerCase() === want),
  );
  if (!found) {
    throw new Error(
      `unknown mail account "${wanted}" — non-Gmail accounts are ${accounts
        .map((a) => `"${a.key}" (${a.label})`)
        .join(", ")}. Omit \`account\` to search everything including gmail.`,
    );
  }
  return found;
}

/**
 * Search gmail (all google accounts) and every non-Gmail account at once, merged newest
 * first. Each backend is asked for `limit` results so a single loud account can't crowd the
 * others out of the merge.
 *
 * `account` and `folder` narrow the NON-GMAIL side and skip gmail entirely: a folder is an
 * IMAP/Exchange concept gmail has no equivalent for (it has labels, and `in:`/`label:` in
 * the query already express it), and "one account" means one of the non-Gmail ones. Both
 * skips are reported in the outcome — a narrowed search that silently dropped gmail while
 * still reading as "searched everything" is the failure this whole file exists to end.
 */
export async function searchAllMail(
  query: string,
  opts: SearchAllOptions = {},
  deps: SearchAllDeps = liveDeps,
): Promise<SearchAllOutcome> {
  const limit = opts.limit ?? 25;
  const folder = opts.folder?.trim();
  const narrowed = Boolean(opts.account?.trim() || folder);
  const accounts = opts.account?.trim()
    ? [resolveSearchAccount(deps.mailAccounts(), opts.account)]
    : deps.mailAccounts();
  const keywords = keywordQuery(query);
  const folders = folder ? [folder] : undefined;

  // Aligned with `tasks` below, so a rejection is attributed to the surface that rejected.
  const searched: string[] = [];
  const tasks: Promise<MailHit[]>[] = [];
  const skipped: { account: string; reason: string }[] = [];

  if (narrowed) {
    skipped.push({
      account: "gmail (all accounts)",
      reason: opts.account?.trim()
        ? `narrowed to the ${accounts[0].label} account — gmail was NOT searched`
        : `narrowed to the ${folder} folder, which is a non-Gmail concept — gmail was NOT searched (use in:/label: in the query for gmail)`,
    });
  } else {
    searched.push("gmail (all accounts)");
    tasks.push(
      deps.gmailSearch(query, limit).then((msgs) =>
        msgs.map(
          (m): MailHit => ({
            backend: "gmail",
            account: m.account,
            messageId: m.id,
            dateEpoch: Math.floor((Date.parse(m.date) || 0) / 1000),
            read: !m.unread,
            sender: m.from,
            subject: m.subject,
            folder: gmailFolder(m.labels),
            link: deps.gmailLink(m.id),
          }),
        ),
      ),
    );
  }

  for (const account of accounts) {
    // An operator-only query ("is:unread") has nothing left to match on here. Asking with
    // an empty string would return the whole mailbox, which is worse than not asking — so
    // the account is skipped and SAID to be skipped, not counted as having found nothing.
    if (!keywords) {
      skipped.push({ account: account.label, reason: `"${query}" is gmail operators only — no keywords to match here` });
      continue;
    }
    searched.push(folder ? `${account.label} (${folder} only)` : account.label);
    tasks.push(
      deps.mailSearch(keywords, limit, account, folders).then((heads) =>
        heads.map(
          (h): MailHit => ({
            backend: "mail",
            account: account.label,
            messageId: h.messageId,
            dateEpoch: h.dateEpoch,
            read: h.read,
            sender: h.sender,
            subject: h.subject,
            folder: h.folder || "INBOX",
            link: `${deps.mailLink(h.messageId, account)}${deps.mailLinkOpensMessage(account) ? "" : " (webmail root, not this message)"}`,
          }),
        ),
      ),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const hits: MailHit[] = [];
  const failures: { account: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") hits.push(...r.value);
    else failures.push({ account: searched[i], error: String((r.reason as Error)?.message ?? r.reason) });
  });
  hits.sort((a, b) => b.dateEpoch - a.dateEpoch);
  return { hits: hits.slice(0, limit), failures, searched, skipped };
}

/**
 * The merged answer as the model reads it. A failed backend is printed even when there
 * are hits: "nothing on the school account" and "the school account didn't answer" are
 * different facts, and only one of them means the message isn't there.
 */
export function formatSearchAll(outcome: SearchAllOutcome, query: string): string {
  const lines = outcome.hits.map(
    (h) =>
      `[${h.account}] ${h.messageId} | ${new Date(h.dateEpoch * 1000).toISOString()} | ${h.folder} | ${h.sender} | ${h.subject} | ${h.read ? "read" : "UNREAD"} | ${h.link}`,
  );
  // "Searched 0 surfaces" is a real outcome (narrowed to one account with an
  // operators-only query, say), and it must not print as a search that found nothing.
  const covered = outcome.searched.length
    ? `Searched ${outcome.searched.length} surfaces for "${query}": ${outcome.searched.join(", ")}.`
    : `NOTHING WAS SEARCHED for "${query}" — this is not a result, see below.`;
  const trouble = outcome.failures.length
    ? `\n\nDID NOT ANSWER (so this is NOT a "not found" for them): ${outcome.failures
        .map((f) => `${f.account} — ${f.error}`)
        .join("; ")}`
    : "";
  // Same rule as a failure, different cause: a surface nobody asked cannot be reported as
  // a surface that came back empty.
  const notAsked = outcome.skipped.length
    ? `\n\nNOT SEARCHED (so this is NOT a "not found" for them either): ${outcome.skipped
        .map((s) => `${s.account} — ${s.reason}`)
        .join("; ")}`
    : "";
  if (!lines.length) return `No matches. ${covered}${trouble}${notAsked}`;
  return `${lines.join("\n")}\n\n${covered}${trouble}${notAsked}`;
}

/**
 * The ONLY mail search tool, mounted alongside gmail + outlook. Its own server rather than
 * a ninth `mcp__outlook__*` tool because it is NOT outlook's — it spans gmail too.
 */
export const mailSearchServerDef = defineServer({
  key: "mailsearch",
  kind: "direct",
  purpose: "one search across gmail + every non-Gmail account + every folder in them",
  exposure: "both",
  capabilities: [
    {
      name: "find",
      purpose: "find a message without knowing which account or folder it's in",
      mutates: "read",
      description:
        `FIND AN EMAIL ANYWHERE — the ONE mail search (it replaced the per-account outlook search, which no longer exists). One call, in parallel: Gmail (every connected Google account) AND every non-Gmail account (${describeAccounts()}) AND every folder in them. Start here for any 'find this email / did X ever email them' question: you do NOT need to know which inbox or folder a message is in. Covers FILED mail, not just the inbox — triage moves most mail out of the Inbox, so an inbox-only search misses it. Returns newest first: [account] message-id | date | folder | from | subject | read-state | link. Plain keywords work everywhere (they're ANDed); Gmail operators (from:, subject:, newer_than:2d, is:unread) apply to the Gmail side and are reduced to their keywords for the others. Prefer newer_than:/older_than: over after:/before: — epoch after:/before: returns wrong-year results. NARROWING IS OPT-IN and the default (everything) is almost always right: \`account\` restricts to ONE non-Gmail account, \`folder\` to one folder in them — and either one SKIPS GMAIL entirely (a folder is an Exchange/IMAP concept; to narrow the Gmail side use in:/label: operators in the query instead). Anything skipped or broken is named in the output: only treat 'no matches' as an answer when nothing is listed under NOT SEARCHED or DID NOT ANSWER.`,
      input: {
        query: z.string().describe("keywords, or a Gmail query (operators apply to Gmail, keywords to everything)"),
        limit: z.number().optional().describe("max results in the merged list, default 25"),
        account: z
          .string()
          .optional()
          .describe(
            `narrow to ONE non-Gmail account (key, label or address; ${describeAccounts()}) — omit to search every account INCLUDING gmail. Passing it excludes gmail.`,
          ),
        folder: z
          .string()
          .optional()
          .describe(
            "narrow the non-Gmail accounts to ONE folder (e.g. INBOX, Receipts) — omit to search every folder, which is the default. Passing it excludes gmail; use in:/label: in the query for the gmail side.",
          ),
      },
      handler: async (args) => {
        const outcome = await searchAllMail(args.query, {
          limit: args.limit ?? 25,
          ...(args.account ? { account: args.account } : {}),
          ...(args.folder ? { folder: args.folder } : {}),
        });
        return formatSearchAll(outcome, args.query);
      },
    },
  ],
});

export const mailSearchServer = toSdkServer(mailSearchServerDef);
