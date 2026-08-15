/**
 * The MONEY DOOR for the web-export ordering CLI.
 *
 * Background (`Pending/guardrail-gate.md`, "## FIFTH bug — the Bash lane is ungated"): the
 * permission gate only ever inspected browser/peekaboo tool calls. The Bash branch was
 * literally commented "Bash: lax for now", so the moment ordering moved off the browse agent
 * and onto `~/GitHub/web-export`'s `order` CLI, the place-order call left the gate entirely and
 * money could be spent with NO 🔐 at all.
 *
 * This module is the two halves that fix that, kept out of `permissions.ts` so the guardrail
 * file stays a thin decision surface:
 *
 *   1. `orderPlaceInvocation` — does this Bash command EXECUTE `order place`? Deterministic,
 *      no model, per-sub-command, and biased to fail CLOSED (see the leader rule below).
 *   2. `buildOrderApproval` — the 🔐 itself: a text line carrying store + total, plus a deferred
 *      rendered card. Both fed from the CLI's own `describe --json`, which renders purely from
 *      GrubHub's API and throws rather than emit a partial block. Never from the agent's summary
 *      of what it thinks it added to the cart — that's the hard requirement in the design note.
 *
 * WHY THE READ HAPPENS AT APPROVAL TIME: the whole point of the mapped-path lane is that the
 * gate can see the actual cart instead of guessing at a button label. So the gate re-reads the
 * cart from the server the moment it's asked to approve spending on it, rather than trusting
 * anything the turn said earlier.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  fetchLogoDataUri,
  faviconUrl,
  renderApprovalCardImage,
  type ApprovalCard,
  type ApprovalCardLine,
  type ApprovalCardRow,
} from "../session/approvalCard";
import { log, warn } from "../core/log";

const execFileAsync = promisify(execFile);
const WEB_EXPORT_DIR = path.join(os.homedir(), "GitHub", "web-export");

/**
 * How long the gate will spend reading the cart before it gives up and asks WITHOUT a total.
 * Generous because this lane issues its calls in-page through CDP (GrubHub runs PerimeterX), and
 * a slow read must not turn into a silent auto-deny of a lunch order.
 */
const DESCRIBE_TIMEOUT_MS = Number(process.env.ORDER_DESCRIBE_TIMEOUT_MS || 30_000);

// ---------------------------------------------------------------------------------------------
// 1. Detection
// ---------------------------------------------------------------------------------------------

/**
 * `order place` — the ONLY verb in this lane that spends money.
 *
 * Adjacency is not laxness, it's the CLI's actual grammar: `runOrder` takes the verb from
 * `argv[0]`, so `order --cart=x place` does not run `place`, it errors. The `--` alternative is
 * there for `npm run order -- place`, which is how the package.json script is invoked.
 *
 * `order cart` / `order describe` / `order menu` cannot match this, which is deliberate — they're
 * reads (or pre-commit cart building), and gating them is exactly the over-prompting that
 * turns a 🔐 into a reflex.
 */
const ORDER_PLACE_VERB = /\border\s+(?:--\s+)?place\b/;

/**
 * The backstop for reaching the same code without the CLI's argv shape — e.g.
 * `node -e "import('./src/order/runOrder.mjs').then(m => m.runOrder(['place', '--cart=x']))"`.
 * Narrow on purpose: it needs the order-lane module named AND a bare `place` token.
 */
const ORDER_LANE_MODULE = /\brunOrder\b|order\/runOrder\.mjs|\border\/adapters\//;
const PLACE_TOKEN = /(?:^|[\s'"`([,])place(?:['"`\])\s,]|$)/;

/**
 * Commands that can only ever READ. If a segment starts with one of these, a `order place`
 * substring in it is text being searched/printed, not an order being placed — `grep -n "order
 * place" README.md` must not prompt.
 *
 * Note the polarity: the gate asks UNLESS the leader is a known reader. That's the opposite of
 * matching an executor allowlist (`node|npm|npx|…`), and it's chosen on purpose — an unrecognised
 * leader (`$CLI order place`, a shell function, a wrapper script) then fails CLOSED to a prompt
 * instead of walking through. On a money path an extra question is cheap and a missed one isn't.
 */
const READ_ONLY_LEADER =
  /^\s*(?:\w+=\S*\s+)*(?:sudo\s+)?(?:grep|rg|egrep|fgrep|ag|cat|bat|less|more|head|tail|wc|nl|awk|sed|cut|sort|uniq|tr|ls|tree|find|fd|stat|file|diff|git|echo|printf|jq|yq|man|open|code|which|type|basename|dirname|realpath)\b/;

/** What the gate learned about the order it's being asked to approve. */
export interface OrderPlaceInvocation {
  /** The sub-command that actually executes it, for the log line. */
  segment: string;
  /** Adapter name from `--source=`. Null when the command didn't name one (the CLI will error). */
  source: string | null;
  /** Cart id from `--cart=`. Without it there's nothing to read, and the CLI errors too. */
  cart: string | null;
}

/** Split a Bash line the same way `bashTouchesGuardrail` does — per sub-command, not per line. */
function segments(cmd: string): string[] {
  return cmd.split(/\|\||&&|[;|&\n]/);
}

function flagValue(text: string, name: string): string | null {
  const eq = new RegExp(`--${name}=([^\\s'"\`]+)`).exec(text);
  if (eq?.[1]) return eq[1];
  const spaced = new RegExp(`--${name}\\s+([^\\s'"\`-][^\\s'"\`]*)`).exec(text);
  return spaced?.[1] ?? null;
}

/**
 * True if this Bash command runs the ordering CLI's money verb. Returns the details needed to
 * read the cart back, or null for everything else — which is every other command on the box.
 */
export function orderPlaceInvocation(cmd: string): OrderPlaceInvocation | null {
  for (const segment of segments(cmd)) {
    if (READ_ONLY_LEADER.test(segment)) continue;
    const isPlace = ORDER_PLACE_VERB.test(segment) || (ORDER_LANE_MODULE.test(segment) && PLACE_TOKEN.test(segment));
    if (!isPlace) continue;
    return {
      segment: segment.trim(),
      // Fall back to the whole line: a caller may set the cart in one segment and place in the
      // next (`CART=$(… order cart …) && node src/cli.mjs order place --cart=$CART`).
      source: flagValue(segment, "source") ?? flagValue(cmd, "source"),
      cart: flagValue(segment, "cart") ?? flagValue(cmd, "cart"),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// 2. The cart read
// ---------------------------------------------------------------------------------------------

/**
 * The ordering CLI's `describe --json` contract. Site-agnostic on purpose: any order adapter that
 * emits this shape gets a card for free (the adapter's own `render` is the authority on what's
 * required — it throws `MissingField` rather than emit a block missing a total/tax/card/time).
 */
export interface OrderPreview {
  cart_id?: string | null;
  fulfillment?: string | null;
  restaurant?: { id?: string | null; name?: string | null; address?: string | null; logo?: string | null } | null;
  when?: {
    local?: string | null;
    asap?: boolean;
    estimate_minutes?: { minimum?: number; maximum?: number } | null;
  } | null;
  items?: { name?: string; quantity?: number; total?: number; options?: string[] }[] | null;
  charges?: { subtotal?: number; fees?: number; tax?: number; tip?: number; total?: number } | null;
  card?: { brand?: string | null; last4?: string | null } | null;
  validation_errors?: unknown[] | null;
}

/** JSON on stdout, transport chatter on stderr — pull the object out without trusting the framing. */
export function parseDescribeJson(stdout: string): OrderPreview | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1)) as OrderPreview;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** Read the cart back off the server. Never throws; returns null when it can't be read. */
async function describeCart(inv: OrderPlaceInvocation): Promise<OrderPreview | null> {
  if (!inv.cart) return null;
  const args = ["src/cli.mjs", "order", "describe", "--cart=" + inv.cart, "--json"];
  if (inv.source) args.splice(3, 0, `--source=${inv.source}`);
  try {
    const { stdout } = await execFileAsync("node", args, { cwd: WEB_EXPORT_DIR, timeout: DESCRIBE_TIMEOUT_MS });
    return parseDescribeJson(stdout || "");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // A non-zero exit can still have printed the JSON (the CLI logs to stderr), so try anyway.
    const salvaged = parseDescribeJson(err.stdout || "");
    if (salvaged) return salvaged;
    warn(`order gate: couldn't read cart ${inv.cart} — ${(err.stderr || err.message || String(e)).trim().slice(0, 300)}`);
    return null;
  }
}

/**
 * Test seam for the server read. Injected rather than env-flagged so the permission tests can
 * exercise the real gate — ask/deny/fail-closed — without spawning the CLI or touching Chrome,
 * and so nothing about the production path is conditional on being under test.
 */
let readCart: (inv: OrderPlaceInvocation) => Promise<OrderPreview | null> = describeCart;

export function setOrderCartReader(fn: (inv: OrderPlaceInvocation) => Promise<OrderPreview | null>): void {
  readCart = fn;
}

export function resetOrderCartReader(): void {
  readCart = describeCart;
}

// ---------------------------------------------------------------------------------------------
// 3. Off-pattern flags
// ---------------------------------------------------------------------------------------------

/**
 * What "normal" looks like, so anything else can be FLAGGED rather than blended in.
 *
 * The anchors themselves are NOT in the code — they're the owner's own habits (which card, which
 * store, what a normal total looks like), so they come in through ORDER_APPROVAL_EXPECTATIONS as
 * JSON. Unset means the only anchor is the hard ceiling, which is the safe direction: fewer
 * "that's unusual" notes, never a missing prompt.
 *
 * These only ever ADD a warning. Nothing here can approve, deny, or suppress a prompt — an
 * unrecognised merchant simply has no anchor to be off.
 */
export interface OrderExpectations {
  cardLast4: string | null;
  fulfillment: string | null;
  /** merchant name (lowercased, matched as a substring) → its anchor */
  merchants: Record<string, { storeId?: string; storeLabel?: string; typicalTotal?: number; domain?: string }>;
  /** A total above this is flagged no matter the merchant. */
  ceiling: number;
  /** Fractional drift from `typicalTotal` that counts as "well off their usual". */
  driftFraction: number;
}

const DEFAULT_EXPECTATIONS: OrderExpectations = {
  cardLast4: null,
  fulfillment: null,
  merchants: {},
  ceiling: 75,
  driftFraction: 0.4,
};

export function orderExpectations(): OrderExpectations {
  const raw = process.env.ORDER_APPROVAL_EXPECTATIONS;
  if (!raw) return DEFAULT_EXPECTATIONS;
  try {
    return { ...DEFAULT_EXPECTATIONS, ...(JSON.parse(raw) as Partial<OrderExpectations>) };
  } catch {
    warn("order gate: ORDER_APPROVAL_EXPECTATIONS isn't valid JSON — using the defaults");
    return DEFAULT_EXPECTATIONS;
  }
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The off-pattern facts on this cart. Empty is the normal case. */
export function orderFlags(p: OrderPreview, exp: OrderExpectations = orderExpectations()): string[] {
  const flags: string[] = [];
  const name = (p.restaurant?.name || "").toLowerCase();
  const anchor = Object.entries(exp.merchants).find(([key]) => name.includes(key))?.[1];
  const total = typeof p.charges?.total === "number" ? p.charges.total : null;

  const errs = Array.isArray(p.validation_errors) ? p.validation_errors : [];
  if (errs.length) flags.push(`the cart has validation errors: ${JSON.stringify(errs).slice(0, 140)}`);

  if (exp.fulfillment && p.fulfillment && p.fulfillment.toUpperCase() !== exp.fulfillment.toUpperCase()) {
    flags.push(`this is ${p.fulfillment.toLowerCase()}, not ${exp.fulfillment.toLowerCase()}`);
  }

  const last4 = p.card?.last4 || null;
  if (exp.cardLast4 && last4 && last4 !== exp.cardLast4) {
    flags.push(`paying with ${p.card?.brand || "a card"} …${last4}, not the usual …${exp.cardLast4}`);
  }
  if (exp.cardLast4 && !last4) flags.push("no card is attached to this cart");

  if (anchor?.storeId && p.restaurant?.id && p.restaurant.id !== anchor.storeId) {
    flags.push(
      `not the usual ${anchor.storeLabel || anchor.storeId} store — this is ${p.restaurant.address || `store ${p.restaurant.id}`}`,
    );
  }

  if (total != null) {
    if (total > exp.ceiling) flags.push(`${money(total)} is above the ${money(exp.ceiling)} ceiling for this lane`);
    else if (anchor?.typicalTotal) {
      const drift = Math.abs(total - anchor.typicalTotal) / anchor.typicalTotal;
      if (drift > exp.driftFraction) {
        flags.push(`${money(total)} is well off the usual ${money(anchor.typicalTotal)} here`);
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// 4. The 🔐 itself
// ---------------------------------------------------------------------------------------------

/** The one-line status pill: "Pickup ASAP · ready ~12:22pm (10-20 min)". */
function statusLine(p: OrderPreview): string | undefined {
  const verb = (p.fulfillment || "").toUpperCase() === "PICKUP" ? "Pickup" : p.fulfillment ? "Delivery" : null;
  if (!verb) return undefined;
  const when = p.when?.local ? ` · ready ~${p.when.local}` : "";
  const est =
    p.when?.estimate_minutes?.minimum != null && p.when?.estimate_minutes?.maximum != null
      ? ` (${p.when.estimate_minutes.minimum}-${p.when.estimate_minutes.maximum} min)`
      : "";
  return `${verb}${p.when?.asap ? " ASAP" : ""}${when}${est}`;
}

/** Turn the server read into the card model. PURE — the whole card is a function of the API. */
export function orderCard(id: string, p: OrderPreview, flags: string[], logoDataUri: string | null, at = Date.now()): ApprovalCard {
  const lines: ApprovalCardLine[] = (p.items || []).map((li) => ({
    name: `${li.name || "item"}${li.quantity && li.quantity > 1 ? ` ×${li.quantity}` : ""}`,
    detail: li.options?.length ? li.options.join(" · ") : undefined,
    price: typeof li.total === "number" ? money(li.total) : undefined,
  }));

  const c = p.charges || {};
  const rows: ApprovalCardRow[] = [];
  if (typeof c.subtotal === "number") rows.push({ label: "Subtotal", value: money(c.subtotal) });
  if (typeof c.fees === "number" && c.fees > 0) rows.push({ label: "Fees", value: money(c.fees) });
  if (typeof c.tax === "number") rows.push({ label: "Tax", value: money(c.tax) });
  if (typeof c.tip === "number" && c.tip > 0) rows.push({ label: "Tip", value: money(c.tip) });

  return {
    id,
    title: p.restaurant?.name || "this order",
    subtitle: p.restaurant?.address || undefined,
    logoDataUri,
    logoEmoji: "🛒",
    lines,
    status: statusLine(p),
    rows,
    total: {
      label: "Total",
      value: typeof c.total === "number" ? money(c.total) : "unknown",
    },
    payment:
      p.card?.last4
        ? { badge: (p.card.brand || "CARD").toUpperCase().slice(0, 6), text: `${p.card.brand || "card"} ···· ${p.card.last4}` }
        : undefined,
    flags,
    at,
  };
}

/**
 * The text line — and it is the ONLY thing that has to survive, because it's the tapback target
 * and the only part iMessage puts on a lock screen. Store + total + the ask, with the first flag
 * appended when there is one, since a flag is precisely the thing they must not have to unlock the
 * phone to discover.
 */
export function orderQuestion(p: OrderPreview | null, inv: OrderPlaceInvocation, flags: string[]): string {
  if (!p || typeof p.charges?.total !== "number") {
    throw new Error(
      `cart ${inv.cart || "(no cart id)"} could not be read back with a total; refusing to offer a blind purchase approval`,
    );
  }
  const head = `🛒 ${p.restaurant?.name || "order"} · ${money(p.charges.total)} · buy it?`;
  if (!flags.length) return head;
  const first = flags[0]!.length > 70 ? `${flags[0]!.slice(0, 67)}…` : flags[0]!;
  const more = flags.length > 1 ? ` (+${flags.length - 1} more on the card)` : "";
  return `⚠️ ${head} — ${first}${more}`;
}

/** What `permissions.ts` needs to raise the 🔐: the question, and a deferred picture. */
export interface OrderApproval {
  question: string;
  /**
   * Built LATE, with the 🔐's minted id, so the card carries the same `#a3f` tag as the text
   * bubble. Always resolves — null just means the prompt goes out as text.
   */
  image: (id: string) => Promise<string | null>;
}

/**
 * Read the cart, decide what's off-pattern, and hand back the prompt.
 *
 * Fails closed when the server read has no total. The approved design's hard requirement is
 * "always include the TOTAL"; offering a "buy anyway?" approval without one would recreate the
 * exact approval-on-vibes failure this card exists to remove. `permissions.ts` catches the throw
 * and denies the Bash call, so no prompt can authorize a blind purchase.
 */
export async function buildOrderApproval(inv: OrderPlaceInvocation): Promise<OrderApproval> {
  const preview = await readCart(inv);
  if (!preview || typeof preview.charges?.total !== "number") {
    throw new Error(
      `cart ${inv.cart || "(no cart id)"} could not be read back from the server with a total`,
    );
  }
  const flags = orderFlags(preview);
  const question = orderQuestion(preview, inv, flags);
  log(`order gate: 🔐 for \`${inv.segment.slice(0, 90)}\` — ${flags.length} flag(s)`);

  return {
    question,
    image: async (id: string) => {
      const exp = orderExpectations();
      const merchant = (preview.restaurant?.name || "").toLowerCase();
      const domain = Object.entries(exp.merchants).find(([k]) => merchant.includes(k))?.[1]?.domain;
      // Brand-mark chain, the owner's order: the site's own API logo, then a favicon by domain, then
      // the emoji on the card model. Any step may fail; none of them can hold up the approval.
      const logo = await fetchLogoDataUri([preview.restaurant?.logo, faviconUrl(domain)]);
      return renderApprovalCardImage(orderCard(id, preview, flags, logo));
    },
  };
}
