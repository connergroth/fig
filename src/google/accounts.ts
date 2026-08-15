import { google } from "googleapis";

import { warn } from "../core/log";

/**
 * Google account registry — the one place that knows which Gmail/Calendar accounts
 * exist and how to authenticate each. Everything else (gmail client, calendar client,
 * watch, triage) keys off a string `label` ("personal", "school", …) resolved here.
 *
 * Back-compat: with no GOOGLE_ACCOUNTS set, there's a single implicit "primary"
 * account using GOOGLE_REFRESH_TOKEN — exactly the old single-account behavior. To add
 * more, set GOOGLE_ACCOUNTS=personal,school and mint a token per label with
 * `npm run auth:google <label>` (writes GOOGLE_REFRESH_TOKEN_<LABEL>). The first label
 * also falls back to GOOGLE_REFRESH_TOKEN so an existing setup keeps working unchanged.
 */

export interface GoogleAccount {
  label: string;
  refreshToken: string;
}

export const PRIMARY = "primary";

function envToken(label: string): string | undefined {
  return process.env[`GOOGLE_REFRESH_TOKEN_${label.toUpperCase()}`]?.trim() || undefined;
}

/** All configured accounts, in declared order. The first is the default/primary. */
export function googleAccounts(): GoogleAccount[] {
  const labels = (process.env.GOOGLE_ACCOUNTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!labels.length) {
    const t = process.env.GOOGLE_REFRESH_TOKEN?.trim();
    return t ? [{ label: PRIMARY, refreshToken: t }] : [];
  }

  const out: GoogleAccount[] = [];
  labels.forEach((label, i) => {
    const token = envToken(label) || (i === 0 ? process.env.GOOGLE_REFRESH_TOKEN?.trim() : undefined);
    if (token) out.push({ label, refreshToken: token });
    else warn(`google account "${label}" has no refresh token (set GOOGLE_REFRESH_TOKEN_${label.toUpperCase()}) — skipping`);
  });
  return out;
}

/** The default account label (first configured), or "primary" if none. */
export function primaryLabel(): string {
  return googleAccounts()[0]?.label ?? PRIMARY;
}

/** Resolve a label (or undefined → primary) to its account, or throw a clear error. */
export function accountFor(label?: string): GoogleAccount {
  const accounts = googleAccounts();
  if (!accounts.length) throw new Error("No Google accounts configured — run `npm run auth:google`.");
  if (!label) return accounts[0];
  const found = accounts.find((a) => a.label === label.toLowerCase());
  if (!found) throw new Error(`Unknown Google account "${label}". Known: ${accounts.map((a) => a.label).join(", ")}.`);
  return found;
}

/** An OAuth2 client (with the refresh token set) for the given account label. */
export function oauth2For(label?: string) {
  const acct = accountFor(label);
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL,
  );
  auth.setCredentials({ refresh_token: acct.refreshToken });
  // gaxios (Google's HTTP layer) defaults to the `node-fetch` package, which throws
  // "Premature close" on the token-refresh call under Node 22 — broke all Gmail +
  // Calendar auth on 2026-06-23. Native fetch is stable (verified), so force it here.
  // This is the single auth chokepoint, so it fixes token refresh AND every Gmail/
  // Calendar/PubSub API call, since they all route through this client's transporter.
  const transporter = (auth as any).transporter;
  if (transporter) {
    transporter.defaults = transporter.defaults || {};
    transporter.defaults.fetchImplementation = globalThis.fetch;
  }
  return auth;
}
