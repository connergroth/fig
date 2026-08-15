import "dotenv/config";

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { google } from "googleapis";

/**
 * One-time Google OAuth consent. Uses the OAuth client in .env (id/secret/redirect)
 * and mints a refresh token, writing it back to .env.
 *
 *   npm run auth:google            → primary account  (GOOGLE_REFRESH_TOKEN)
 *   npm run auth:google school     → a second account (GOOGLE_REFRESH_TOKEN_SCHOOL)
 *
 * For a second account, sign into THAT Google account on the consent screen, then add
 * its label to GOOGLE_ACCOUNTS in .env (e.g. GOOGLE_ACCOUNTS=primary,school).
 *
 * It listens on the exact redirect URI registered for the client, so no Google Cloud
 * console changes are needed — just make sure nothing else is using that port.
 */

// Optional account label arg → which env var the token is written to.
const accountLabel = (process.argv[2] || "").trim().toLowerCase();
const tokenEnvKey = accountLabel ? `GOOGLE_REFRESH_TOKEN_${accountLabel.toUpperCase()}` : "GOOGLE_REFRESH_TOKEN";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read, label, move, mark read/unread
  "https://www.googleapis.com/auth/gmail.compose", // create drafts + send
  "https://www.googleapis.com/auth/calendar", // read/write calendar + events
  "https://www.googleapis.com/auth/pubsub", // pull Gmail change notifications from Pub/Sub
];

const clientId = need("GOOGLE_CLIENT_ID");
const clientSecret = need("GOOGLE_CLIENT_SECRET");
const redirectUrl = need("GOOGLE_REDIRECT_URL");

function need(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
  return v;
}

const redirect = new URL(redirectUrl);
const port = Number(redirect.port || 80);
const callbackPath = redirect.pathname;

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even if previously granted
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== callbackPath) {
    res.writeHead(404);
    res.end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No authorization code in callback.");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    const refresh = tokens.refresh_token;
    if (!refresh) {
      res.end(
        "Authorized, but Google returned no refresh token. Revoke this app at " +
          "myaccount.google.com/permissions and run `npm run auth:google` again.",
      );
      console.error("No refresh_token returned (already granted without prompt=consent?).");
      server.close();
      process.exit(1);
    }
    writeEnv(tokenEnvKey, refresh);
    res.end("Authorized. Refresh token saved. You can close this tab.");
    console.log(`\n✓ ${tokenEnvKey} saved to .env.${accountLabel ? ` Account "${accountLabel}" connected — add it to GOOGLE_ACCOUNTS.` : " Gmail is connected."}`);
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500);
    res.end(`Token exchange failed: ${e}`);
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.on("error", (e) => {
  console.error(`Could not bind ${redirectUrl}: ${e}\nIs something else using port ${port}? Stop it and retry.`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`\nOpen this URL and sign into the ${accountLabel ? `"${accountLabel}"` : "primary"} Google account to authorize:\n`);
  console.log(authUrl);
  console.log(`\nWaiting for the redirect on ${redirectUrl} …`);
});

function writeEnv(key: string, value: string): void {
  const envPath = path.resolve(__dirname, "..", ".env");
  let text = fs.readFileSync(envPath, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text}\n${line}\n`;
  fs.writeFileSync(envPath, text);
}
