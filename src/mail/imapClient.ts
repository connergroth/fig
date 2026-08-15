import { ImapFlow, type MailboxLockObject } from "imapflow";

import { warn } from "../core/log";
import type { ImapCreds } from "./accounts";

/**
 * Connection plumbing for the `imap` transport: one cached, serialized ImapFlow
 * connection per account, with a reconnect on the failures that mean "the socket died",
 * not "the command was wrong".
 *
 * WHY CACHED: a triage run makes five or six calls in a row (get → file → mark_read …),
 * and a fresh TLS handshake + LOGIN each time is ~1s of dead time per call against a
 * server that will happily hold the session open. WHY SERIALIZED: an IMAP session is a
 * single conversation with a single selected mailbox — two overlapping operations on one
 * connection interleave commands and select each other's mailbox out from under them.
 * The queue below is what makes concurrent callers (poll tick + a tool call) safe.
 *
 * WHY IDLE-CLOSED: an open socket keeps the node event loop alive, so a script that
 * reads mail and finishes would hang forever on exit. The idle timer closes the
 * connection after a quiet minute and is `unref`'d so it can't hold the process up
 * either; `closeImapConnections()` is the explicit version for scripts.
 *
 * The password lives only in the ImapCreds passed in and in the ImapFlow options —
 * `logger: false` is deliberate, since imapflow's default logger prints protocol traffic.
 */

/** Close a connection that's been unused this long. Cheap to re-open when it matters. */
const IDLE_CLOSE_MS = 60_000;
/** Bounded so a wedged server can't stall a poll tick forever. */
const CONNECT_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 90_000;

interface Session {
  client: ImapFlow;
  idle?: NodeJS.Timeout;
}

/** One session per account, keyed by user@host so two accounts never share one. */
const sessions = new Map<string, Session>();
/**
 * The serialization tail per account key — deliberately NOT on the Session, which comes
 * and goes with the socket. The queue has to outlive a reconnect or two callers racing
 * across one would both think they were first.
 */
const queues = new Map<string, Promise<unknown>>();

function sessionKey(creds: ImapCreds): string {
  return `${creds.user}@${creds.host}:${creds.port}`;
}

/**
 * Errors that mean "the network/server hiccuped", so the poll loop should back off
 * instead of treating it as a real failure — the IMAP analogue of the AppleEvent -1712
 * check in ./applescript.ts.
 */
export function isTransientImapError(message: string): boolean {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket|timed out|timeout|Connection not available|NoConnection|closed unexpect/i.test(
    message,
  );
}

/** True when the session is probably dead and a retry should get a NEW connection. */
function isConnectionError(message: string): boolean {
  return isTransientImapError(message) || /Connection closed|not authenticated|Command failed.*NONAUTH/i.test(message);
}

function scheduleIdleClose(key: string, session: Session): void {
  if (session.idle) clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    void session.client.logout().catch(() => session.client.close());
  }, IDLE_CLOSE_MS);
  session.idle.unref();
}

async function openSession(creds: ImapCreds): Promise<Session> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true, // implicit TLS on 993 — this server does not do STARTTLS on that port
    auth: { user: creds.user, pass: creds.password },
    logger: false, // its default logger prints the LOGIN command's traffic
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    clientInfo: { name: "fig" },
  });
  // imapflow emits 'error' on a dead socket; unhandled, that takes the daemon down.
  client.on("error", (e: Error) => warn(`imap [${creds.host}]: connection error: ${e?.message ?? e}`));
  await client.connect();
  return { client };
}

async function getSession(creds: ImapCreds): Promise<Session> {
  const key = sessionKey(creds);
  const existing = sessions.get(key);
  if (existing?.client.usable) return existing;
  if (existing) sessions.delete(key);
  const session = await openSession(creds);
  sessions.set(key, session);
  return session;
}

/**
 * Run `fn` against a live connection for this account, serialized against every other
 * caller on the same account. One retry on a connection-shaped failure with a freshly
 * opened session — a socket that died while idle is the common case and it must not
 * surface as a triage error.
 */
export function withImap<T>(creds: ImapCreds, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const key = sessionKey(creds);
  const run = async (): Promise<T> => {
    const session = await getSession(creds);
    if (session.idle) clearTimeout(session.idle);
    try {
      return await fn(session.client);
    } finally {
      scheduleIdleClose(key, session);
    }
  };

  const attempt = async (): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!isConnectionError(msg)) throw e;
      // The cached socket died (usually while idle). Drop it and try once on a fresh one.
      const dead = sessions.get(key);
      if (dead) {
        sessions.delete(key);
        if (dead.idle) clearTimeout(dead.idle);
        dead.client.close();
      }
      return run();
    }
  };

  // Chain onto whatever is already in flight for this account, and keep the chain alive
  // through failures (a rejected tail must not reject every later caller).
  const prior = queues.get(key) ?? Promise.resolve();
  const result = prior.then(attempt, attempt);
  queues.set(key, result.catch(() => undefined));
  return result;
}

/** Open a mailbox, run `fn`, always release the lock (imapflow deadlocks if you don't). */
export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  opts: { readOnly?: boolean },
  fn: (lock: MailboxLockObject) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path, { readOnly: opts.readOnly ?? false });
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/**
 * Close every cached connection. Scripts call this to exit — the daemon never needs it,
 * since the idle timer is unref'd and process exit takes the sockets with it.
 */
export async function closeImapConnections(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  queues.clear();
  await Promise.all(
    open.map(async (s) => {
      if (s.idle) clearTimeout(s.idle);
      try {
        await s.client.logout();
      } catch {
        s.client.close();
      }
    }),
  );
}
