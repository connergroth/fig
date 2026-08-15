# Credential injector

Logs the owner into an allowlisted site **without the model ever seeing the username,
password, or 2FA code**. The model references a handle (`amazon`); the injector reads the
live page's origin, checks it against that handle's allowlist, resolves the secret from a
separate agent-only Bitwarden vault, and DOM-fills it into the tab the model is already
driving. The model gets back `{ ok, handle, origin, submitted }` and nothing else.

The boundary: no plaintext in model context, scoped to a tiny allowlist, origin-bound so it
can't fire on a phishing lookalike.

## How it's wired

**Allowlist — `config/credential-handles.json`.** No secrets, only `handle → { item,
allowedOrigins[], submit?, steps?, ...selectors }`. `item` is the Bitwarden item id or exact
name; `allowedOrigins` are exact origins. Keys starting with `_` are ignored (the file's own
comment), and a handle missing `item` or a non-empty `allowedOrigins` is dropped at load.
Present today: **`grubhub`** and **`amazon`**, both `submit: false`, both multi-step
(email → Continue → wait for password → password).

**Tool surface — `src/credentials/tools.ts`.** An SDK MCP server (`credentials`) with two tools:
`list_handles` (handles, allowed origins, `submitsAfterFill`, `multiStep` — never secrets) and
`fill_login({ handle, submit? })`, where `submit` overrides the handle's config.

**Mounted in exactly one place — `src/specialists/browser.ts`.** `makeCredentialsServer(jobPageRef)`
goes into the browse specialist's sub-query `mcpServers` and nowhere else, so the main loop has no
path to it. A factory rather than a singleton: each instance is bound to the Page `openJobTab()`
gave that run. Both tools land on the generic `mcp__` branch of the permission gate
(`src/runtimes/permissions.ts`), so every call asks the owner for a 👍.

**One shared browser — `src/browser/chrome.ts`.** `ensureBrowserChrome()` returns a single
process-wide Chrome on the `~/.bot-browser` profile with a CDP debug port
(`config.browser.cdpPort`, default 9333): it attaches to an already-running debug Chrome if one
answers (polled, so a mid-boot Chrome is joined rather than raced), else launches Chrome stable,
falling back to bundled Chromium. Started best-effort at boot from `src/index.ts`, ensured again
lazily on first browse. `toCdpBrowserConfig()` then rewrites the mcp.json browser entry at
runtime — strips `--user-data-dir` and any stale `--cdp-endpoint`, appends the live one — so
`@playwright/mcp` and the injector drive the **same tab**.

**Fill flow.** `fill_login` takes the run's bound tab (refusing outright if it's closed or the run
never got one), asserts origin, resolves the item, then runs the handle's `steps`:
`{ fill: "username" | "password" | "totp", selector }` re-asserts origin and `locator.fill()`s the
value once visible; `{ click, optional? }` clicks, `optional` swallowing a not-found;
`{ waitFor, timeoutMs? }` waits for visible. No `steps` → a generic two-field pass off
`usernameSelector`/`passwordSelector` or the built-in defaults. Submitting clicks `submitSelector`,
or presses Enter in the just-filled field if none is set. A `fill` of `"totp"` runs
`bw get totp <item>` — Bitwarden computes the code, it goes straight into the page, never to the
model. No handle declares a `totp` step today.

**Vault unlock.** `ensureSession()` returns a session key: cached from this process → `BW_SESSION`
from env (hand-pasted escape hatch) → self-unlock (`bw login --apikey` with
`BW_CLIENTID`/`BW_CLIENTSECRET` if unauthenticated, then `bw unlock --passwordenv BW_PASSWORD
--raw`). Every `bw` read goes through `withSession()`, which drops the cache and re-mints once on
failure — that's what lets a long-running daemon survive restarts with no session to babysit.

## Invariants, and why

1. **A separate, agent-only Bitwarden vault.** A fresh account that is fig's and only fig's,
   holding only the creds the owner blesses. Bitwarden's "unlock unlocks everything" weakness is a
   non-issue when everything *is* the allowlist — the account separation does the scoping for
   free, which is why this isn't 1Password service accounts or paid per-item scoping.
2. **Handle indirection.** The model names `amazon`, never a value. Secrets exist only inside the
   tool call; the return carries status and the verified origin, nothing readable.
3. **Origin comes from the Playwright page, not the OS.** `page.url()` of the exact tab being
   driven. Reading the frontmost desktop window would verify a *different surface* than the one
   being filled — potentially a different browser entirely — reducing the guarantee to "the right
   tab happened to be frontmost." And it's the run's OWN page, handed down from
   `src/specialists/browser.ts`, not a guess at which tab is frontmost — `activeBrowserPage()`
   guessed, and with two browse jobs in the shared Chrome it regularly returned the other job's
   tab. That never leaked (the origin check fails closed on whatever it's given), but it surfaced
   to the model as "I can't type passwords here", which it reported to the owner as a missing
   capability (2026-08-13). No bound tab now means no fill and an error that says so.
4. **Verify origin, THEN resolve the secret.** The Bitwarden read happens only after the first
   assert, so any upstream failure dies before plaintext moves. Origin is re-asserted before
   *every* fill and before submit, so a mid-flow redirect off the allowlist can never receive a
   secret. Matching is exact origin equality after normalization — no subdomain or prefix
   matching — and a URL that won't parse (`about:blank`) is never allowed.
5. **Browser-specialist-only wiring.** Secrets live and die inside a sub-agent that has no direct
   path to the owner.
6. **DOM fill, in-process.** The secret goes from the node heap into the page: never a child
   process's argv (visible to `ps`), never dependent on macOS Accessibility.

## Operator setup

- Install once: `brew install bitwarden-cli`, `npx playwright install chromium` (`playwright` is a
  direct dependency).
- `.env`: `BW_CLIENTID`, `BW_CLIENTSECRET`, `BW_PASSWORD` — API key + master password of the
  agent-only account. Never paste the master password into chat; it'd land in the conversation
  log. `BW_SESSION` works as a one-off but goes stale on restart. Optional:
  `BOT_BROWSER_CDP_PORT` (9333), `BOT_BROWSER_USER_DATA_DIR` (`~/.bot-browser`).
- In that vault: a login item per handle, named to match `item` (`grubhub`, `amazon`), with
  username + password, plus a TOTP seed if a handle uses a `totp` step.
- `npm run browser:login` opens the same profile **without** a debug port, so it holds the profile
  lock and the bot can neither attach nor launch. Close it before letting the bot drive; the launch
  path detects this and says so.

## Known gaps

- **The live multi-step Amazon login has never been manually verified** against a real logged-out
  session. Launch → CDP attach by a second client → DOM fill is smoke-tested; the actual
  email → Continue → password walk is not. The configured selectors cover the current flow and
  degrade through fallbacks, but treat them as unproven.
- `bw get item`/`bw get totp` pass the **session key** as argv, briefly visible to local process
  listing. No secret value and not the master password (`--passwordenv`), but it's a live
  capability while the vault is unlocked.
- The approval prompt is generic — it doesn't render which handle or origin is about to be filled.
- TOTP is implemented but unexercised.
