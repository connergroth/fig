import "dotenv/config";

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * One-time Spotify OAuth (Authorization Code flow). Mints a long-lived refresh
 * token for the playlist skill and writes it to .env as SPOTIFY_REFRESH_TOKEN.
 * Run once:  npm run auth:spotify
 *
 * The agent later trades this refresh token for a fresh 1-hour access token on each
 * run — so the access token in Spotify's web tutorial (the `BQAU…` string) is NOT
 * what you store; this is.
 *
 * Before running: set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REDIRECT_URL
 * in .env, and register that EXACT redirect URI on your app at
 * https://developer.spotify.com/dashboard (Spotify requires an exact match).
 */

// Scopes to create playlists and add tracks in your account. Add playlist-read-private
// if you later want it to read your existing playlists.
const SCOPES = ["playlist-modify-private", "playlist-modify-public"];

const clientId = need("SPOTIFY_CLIENT_ID");
const clientSecret = need("SPOTIFY_CLIENT_SECRET");
const redirectUrl = need("SPOTIFY_REDIRECT_URL");

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

// A random state to tie the callback to this run (CSRF guard the docs recommend).
const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUrl,
  scope: SCOPES.join(" "),
  state,
}).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== callbackPath) {
    res.writeHead(404);
    res.end();
    return;
  }
  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(400);
    res.end(`Spotify returned an error: ${err}`);
    console.error(`Authorization denied: ${err}`);
    server.close();
    process.exit(1);
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400);
    res.end("State mismatch — ignoring this callback.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No authorization code in callback.");
    return;
  }
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUrl,
      }).toString(),
    });
    const tokens: any = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      res.writeHead(500);
      res.end(`Token exchange failed: ${JSON.stringify(tokens)}`);
      console.error("No refresh_token returned:", tokens);
      server.close();
      process.exit(1);
    }
    writeEnv("SPOTIFY_REFRESH_TOKEN", tokens.refresh_token);
    res.end("Authorized. Refresh token saved. You can close this tab.");
    console.log("\n✓ SPOTIFY_REFRESH_TOKEN saved to .env. Spotify is connected.");
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
  console.log("\nOpen this URL in your browser to authorize Spotify:\n");
  console.log(authUrl.toString());
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
