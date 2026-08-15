import { warn } from "../core/log";

/**
 * The registry of non-Gmail mail accounts fig drives, the TRANSPORT each one is reached
 * over, and the short stable keys the rest of the system (tool params, poll-state files,
 * log lines) refers to them by.
 *
 * This exists because the driver was written for exactly ONE account — a school Exchange
 * mailbox, which has no API path — and there is more than one now: a personal domain
 * mailbox on plain IMAP is the second. Everything downstream takes an account rather than
 * assuming the one.
 *
 * TWO TRANSPORTS, because the second account can't use the first one's:
 *   - `applemail` — Mail.app does the auth and AppleScript is the programmatic surface.
 *     The only per-account variable is the name AppleScript addresses it by.
 *   - `imap` — we talk to the server ourselves (IMAP for read/write-back, SMTP for the
 *     gated send). This is not a preference: Apple Mail cannot take a NEW account on the
 *     mini. Its setup sheet is GUI-only, and Screen Recording isn't granted to the
 *     Peekaboo Bridge host, so automation drives it blind in every lane; Mail's own `make
 *     new imap account` returns a ghost that never persists to accountsd; and `profiles
 *     install` is gone on macOS 26. Over-the-wire is the only path that works today.
 *
 * Env shape — MAIL_ACCOUNTS: one record per account, records separated by `;`, fields
 * inside a record by `|`, as `key|identity|human label|transport` (transport optional,
 * default `applemail`):
 *
 *   MAIL_ACCOUNTS=outlook|Exchange|Outlook (school); personal|you@example.com|you@example.com (personal)|imap:PRIVATEEMAIL
 *
 * `identity` is the EXACT Mail.app account name for `applemail`, and the email address
 * for `imap`. The transport field is `applemail`, `imap`, or `imap:PREFIX` — PREFIX names
 * the .env vars holding that account's server + credentials (default: the key, uppercased):
 *
 *   PREFIX_ADDRESS   (required)  full address, also the IMAP/SMTP username
 *   PREFIX_PASSWORD  (required)  mailbox password — read from .env, never logged
 *   PREFIX_IMAP_HOST (required)  e.g. mail.privateemail.com
 *   PREFIX_IMAP_PORT (default 993, implicit TLS)
 *   PREFIX_SMTP_HOST (default = the IMAP host)   PREFIX_SMTP_PORT (default 465, implicit TLS)
 *   PREFIX_WEBMAIL_URL (default https://<imap host>/) — IMAP has no per-message deep link
 *
 * The pipe is deliberate. An account NAME is free text a human typed into Mail's setup
 * sheet — it routinely holds spaces, commas and colons — so comma/colon splitting
 * mangles real names, and JSON inside a .env is a quoting minefield where one stray
 * quote silently yields garbage. A `|` appears in neither a Mail account name nor a
 * label, and a malformed record is REPORTED (warn + skip) rather than half-parsed.
 *
 * The first record is the primary: the default for every account-less call, which is
 * what keeps the pre-existing single-account callers correct.
 *
 * BACKWARD COMPATIBLE, in precedence order: MAIL_ACCOUNTS, else APPLE_MAIL_ACCOUNTS
 * (the Apple-Mail-only form, every record `applemail`), else exactly the old single
 * account — key `outlook`, name from OUTLOOK_MAIL_ACCOUNT (default "Exchange"). An
 * untouched .env keeps behaving the way it did, down to the state file it reads.
 */

/** How fig actually reaches an account's mail. See the header for why there are two. */
export type MailTransport = "applemail" | "imap";

/** Server + credentials for an `imap` account, resolved from its PREFIX_* env vars. */
export interface ImapCreds {
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
  /** IMAP/SMTP username — the full address. */
  user: string;
  /** Mailbox password. NEVER log this; see the toJSON redaction where these are built. */
  password: string;
  /** Where a human goes to see this mailbox — IMAP has no per-message link. */
  webmailUrl: string;
}

export interface MailAccount {
  /** Short stable id used in tool params, state filenames and logs (e.g. "outlook"). */
  key: string;
  /** Mail.app account name (`applemail`) or the email address (`imap`). */
  accountName: string;
  /** Human description for prompts and tool text ("Outlook (school)"). */
  label: string;
  /** Which driver reads this account. */
  transport: MailTransport;
  /** Present iff transport is "imap". */
  imap?: ImapCreds;
}

/**
 * The key the original single account keeps. Its poll state predates the registry and
 * still lives under the old filename, so this is also the migration key — see
 * ./pollState.ts.
 */
export const LEGACY_ACCOUNT_KEY = "outlook";

const DEFAULT_LEGACY_ACCOUNT_NAME = "Exchange";
const DEFAULT_LEGACY_LABEL = "Outlook (school)";

/** Keys land in filenames and tool params, so keep them boring and shell-safe. */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

/**
 * Build the imap creds for `imap:PREFIX` out of the environment.
 *
 * Returns a string on failure rather than throwing: the caller turns it into the same
 * warn-and-skip a malformed record gets. A half-configured account must not become a
 * connection attempt against a wrong host with a real password on it.
 *
 * `toJSON` is not decoration. It's the one place a password could leak — some future
 * `warn(\`... ${JSON.stringify(account)}\`)` or a state dump — and redacting at the
 * object makes every such call site safe by default instead of by review.
 */
function resolveImapCreds(prefix: string, env: NodeJS.ProcessEnv): ImapCreds | string {
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = (env[`${prefix}_${n}`] || "").trim();
      if (v) return v;
    }
    return "";
  };
  const user = pick("ADDRESS", "USER");
  const password = env[`${prefix}_PASSWORD`] || "";
  const host = pick("IMAP_HOST", "HOST");
  const missing = [!user && `${prefix}_ADDRESS`, !password && `${prefix}_PASSWORD`, !host && `${prefix}_IMAP_HOST`].filter(Boolean);
  if (missing.length) return `missing ${missing.join(", ")} in the environment`;
  const port = Number(pick("IMAP_PORT")) || DEFAULT_IMAP_PORT;
  const smtpHost = pick("SMTP_HOST") || host;
  const smtpPort = Number(pick("SMTP_PORT")) || DEFAULT_SMTP_PORT;
  const webmailUrl = pick("WEBMAIL_URL") || `https://${host}/`;
  return {
    host,
    port,
    smtpHost,
    smtpPort,
    user,
    password,
    webmailUrl,
    toJSON() {
      return { host, port, smtpHost, smtpPort, user, password: "[redacted]", webmailUrl };
    },
  } as ImapCreds;
}

/**
 * Parse a MAIL_ACCOUNTS / APPLE_MAIL_ACCOUNTS spec. Pure over (spec, env) so the shapes
 * can be tested directly. A record that can't be read is skipped with a warning instead
 * of taking the poller down — a typo in one account must never cost us the other one's
 * mail. If NOTHING parses, the caller falls back to the legacy single account.
 */
export function parseMailAccounts(
  spec: string,
  onWarn: (msg: string) => void = warn,
  env: NodeJS.ProcessEnv = process.env,
  varName = "MAIL_ACCOUNTS",
): MailAccount[] {
  const accounts: MailAccount[] = [];
  for (const record of spec.split(";")) {
    if (!record.trim()) continue;
    const [rawKey, rawName, rawLabel, rawTransport] = record.split("|");
    const key = (rawKey || "").trim().toLowerCase();
    const accountName = (rawName || "").trim();
    const label = (rawLabel || "").trim() || accountName;
    const transportSpec = (rawTransport || "").trim().toLowerCase();
    if (!key || !accountName) {
      onWarn(`${varName}: skipping "${record.trim()}" — expected key|account name or address|label|transport`);
      continue;
    }
    if (!KEY_RE.test(key)) {
      onWarn(`${varName}: skipping "${record.trim()}" — key "${key}" must be letters/digits/-/_ (it names a state file)`);
      continue;
    }
    if (accounts.some((a) => a.key === key)) {
      onWarn(`${varName}: duplicate key "${key}" — keeping the first, skipping "${record.trim()}"`);
      continue;
    }
    if (!transportSpec || transportSpec === "applemail") {
      accounts.push({ key, accountName, label, transport: "applemail" });
      continue;
    }
    const [kind, prefix] = transportSpec.split(":");
    if (kind !== "imap") {
      onWarn(`${varName}: skipping "${record.trim()}" — unknown transport "${transportSpec}" (expected applemail, imap, or imap:ENVPREFIX)`);
      continue;
    }
    const creds = resolveImapCreds((prefix || key).trim().toUpperCase().replace(/-/g, "_"), env);
    if (typeof creds === "string") {
      onWarn(`${varName}: skipping imap account "${key}" — ${creds}`);
      continue;
    }
    accounts.push({ key, accountName, label, transport: "imap", imap: creds });
  }
  return accounts;
}

/** The pre-registry account, built from the env vars that configured it before. */
export function legacyMailAccount(accountName?: string): MailAccount {
  return {
    key: LEGACY_ACCOUNT_KEY,
    accountName: (accountName || "").trim() || DEFAULT_LEGACY_ACCOUNT_NAME,
    label: DEFAULT_LEGACY_LABEL,
    transport: "applemail",
  };
}

/**
 * Resolve the registry from the environment, newest form first: MAIL_ACCOUNTS (any
 * transport), else APPLE_MAIL_ACCOUNTS (Apple Mail only), else the single legacy account.
 */
export function resolveMailAccounts(
  env: NodeJS.ProcessEnv = process.env,
  onWarn: (msg: string) => void = warn,
): MailAccount[] {
  for (const varName of ["MAIL_ACCOUNTS", "APPLE_MAIL_ACCOUNTS"] as const) {
    const spec = (env[varName] || "").trim();
    if (!spec) continue;
    const parsed = parseMailAccounts(spec, onWarn, env, varName);
    if (parsed.length) return parsed;
    onWarn(`${varName} was set but no record parsed — falling back to the single OUTLOOK_MAIL_ACCOUNT account`);
  }
  return [legacyMailAccount(env.OUTLOOK_MAIL_ACCOUNT)];
}

/** Resolved once at load: the env doesn't change under a running daemon. */
const ACCOUNTS = resolveMailAccounts();

/** Every configured account, any transport, primary first. */
export function getAccounts(): MailAccount[] {
  return ACCOUNTS;
}

/** The default account for any call that doesn't name one (the first configured). */
export function primaryAccount(): MailAccount {
  return ACCOUNTS[0];
}

/** Look up by key; no key = the primary. Throws (naming the valid keys) on a bad key. */
export function getAccount(key?: string): MailAccount {
  if (!key || !key.trim()) return primaryAccount();
  const wanted = key.trim().toLowerCase();
  const found = ACCOUNTS.find((a) => a.key === wanted);
  if (!found) {
    throw new Error(`unknown mail account "${key}" — configured accounts: ${ACCOUNTS.map((a) => a.key).join(", ")}`);
  }
  return found;
}

/**
 * An imap account's server + credentials, or a throw naming the account. The imap
 * driver's guard: reaching it with an `applemail` account means the dispatcher routed
 * wrong, and that has to be loud rather than a `cannot read host of undefined`.
 */
export function imapCreds(account: MailAccount): ImapCreds {
  if (account.transport !== "imap" || !account.imap) {
    throw new Error(`mail account "${account.key}" is not an imap account (transport: ${account.transport})`);
  }
  return account.imap;
}

/** One-line "which accounts exist" blurb for tool descriptions and prompts. */
export function describeAccounts(): string {
  return ACCOUNTS.map((a, i) => `"${a.key}" = ${a.label}${i === 0 ? " (default)" : ""}`).join("; ");
}
