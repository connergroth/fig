import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../core/config";
import { truncateUnicode } from "../core/unicode";
import { isOwnerOrAlias } from "../core/owner";
import { err, log, warn } from "../core/log";
import { ensureInjected, noteRichSendFailure, noteRichSendSuccess, startInjectionWatchdog } from "./inject";
import { fetchNewPollVotes, fetchReplyTargets, renderVote } from "./pollVotes";
import type { InboundMessage, Reaction, SendOptions, Transport } from "./types";
import { isClassicReaction } from "./types";

/**
 * APNS keepalive interval. apsd holds a persistent TCP connection to
 * push.apple.com:5223; on a headless WiFi Mac that socket silently dies (NAT
 * timeout / WiFi power save) and apsd enters a 10-30min backoff before it
 * reconnects — during which inbound iMessages never land in chat.db, so `imsg
 * watch` sees nothing and fig goes deaf with no error. (This is exactly the
 * BlueBubbles relay's old failure mode; it ran the same loop in
 * handlers/keepalive.py.) Sending a tiny outbound self-message every 2min
 * exercises the full imagent → apsd → Apple path and forces the connection to
 * stay up — the same cure as texting yourself by hand, which flushes a backlog of
 * stuck messages instantly. */
const KEEPALIVE_INTERVAL_MS = 120_000;
// How often to sweep chat.db for new native-poll votes (balloon updates the watch stream
// doesn't surface). Cheap read-only query; a few seconds keeps vote→turn latency low.
const POLL_VOTE_INTERVAL_MS = 4_000;
// A single "." — NOT a zero-width space. This is what the proven BlueBubbles
// relay actually pushed (handlers/keepalive.py sent "." via BB; the ZWSP there
// was only the AppleScript fallback). A ZWSP self-send returns "sent" from imsg
// but imagent drops the empty-content message LOCALLY — it never round-trips
// through Apple (no is_from_me=0 echo lands in chat.db), so apsd is never
// exercised and the keepalive is a silent no-op. A "." is real content: it
// round-trips, forcing the imagent → apsd → Apple path to stay warm. It shows
// as a tiny self-bubble in Messages — which is also the live proof it's firing.
const KEEPALIVE_TAG = ".";

/**
 * imsg transport — fig's iMessage line via the `imsg` CLI (OpenClaw/imsg).
 *
 * Replaces the BlueBubbles relay. imsg drives Messages.app directly: it reads the
 * local chat.db and (with SIP off + the bridge dylib injected via `imsg launch`)
 * sends through Messages' private IMCore API, so we get typing indicators, read
 * receipts, expressive-send effects, and tapbacks — the same surface the relay gave
 * us, minus the whole BlueBubbles server + Python relay + webhook.
 *
 * Inbound is a long-running `imsg watch --json` stream (one JSON event per line).
 * We spawn it in the background, buffer events into `inbox`, and drain on poll() —
 * the same shape the relay transport uses, so the daemon loop is unchanged. The
 * stream is self-healing: if it dies we respawn with backoff.
 *
 * Find My is NOT part of this — imsg is messaging-only. Location stays on its own
 * path (the reverse-engineered Find My service), wired separately.
 *
 *   IMSG_BIN       path to the imsg binary       (default "imsg" on PATH)
 *   IMSG_DB        path to chat.db               (default imsg's own default)
 */

const IMSG_BIN = (process.env.IMSG_BIN || "imsg").trim();
const IMSG_DB = (process.env.IMSG_DB || "").trim();

/**
 * Group chats fig/spot are explicitly allowed to reply INTO. Sends route by the last
 * chat_guid seen for a peer (chatGuidByPeer), so without this gate a GROUP inbound would
 * make that group the peer's reply route — and the owner texting fig from inside a mixed
 * group would make fig's reply (which can carry private vault/email/location/finance
 * context) post straight back INTO that group where strangers read it. A reverse leak.
 *
 * Any group NOT in this set is treated as untrusted: its inbound never updates a peer's
 * reply route (see handleEvent), so replies fall back to the prior 1:1 guid or the
 * iMessage;-;<peer> DM (chatGuidFor) and stay private.
 *
 *   IMSG_GROUP_ALLOWLIST   comma-separated chat guids that are trusted reply targets
 *
 * Empty by default — no group is trusted unless it's named here. Nothing is hardcoded.
 */
const GROUP_REPLY_ALLOWLIST = new Set(
  (process.env.IMSG_GROUP_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** A group chat we're explicitly allowed to reply into (vs. an untrusted group of strangers). */
function isAllowedGroup(chatGuid: string | undefined): boolean {
  return !!chatGuid && GROUP_REPLY_ALLOWLIST.has(chatGuid);
}

/** One event line off `imsg watch --json`. Messages and reactions share this shape. */
interface WatchAttachment {
  filename?: string; // absolute path on disk (chat.db stores the full path here)
  filepath?: string;
  path?: string;
  transfer_name?: string;
  mime_type?: string;
  uti?: string;
  total_bytes?: number;
  is_sticker?: boolean;
}

interface WatchEvent {
  guid?: string;
  sender?: string;
  text?: string;
  chat_guid?: string;
  chat_identifier?: string;
  chat_name?: string;
  is_from_me?: boolean;
  is_group?: boolean;
  created_at?: string;
  attachments?: WatchAttachment[];
  // reaction events (--reactions)
  is_reaction?: boolean;
  is_reaction_add?: boolean;
  reaction_emoji?: string;
  reaction_type?: string;
  reacted_to_guid?: string;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/x-caf": ".caf",
  "audio/amr": ".amr",
  "application/pdf": ".pdf",
};

/** Apple expressive-send bundle id (what chunking.ts emits) → imsg's short effect token. */
const EFFECT_BUNDLE_TO_IMSG: Record<string, string> = {
  "com.apple.messages.effect.CKConfettiEffect": "confetti",
  "com.apple.messages.effect.CKFireworksEffect": "fireworks",
  "com.apple.messages.effect.CKLasersEffect": "lasers",
  "com.apple.messages.effect.CKHappyBirthdayEffect": "balloons",
  "com.apple.messages.effect.CKHeartEffect": "heart",
  "com.apple.messages.effect.CKSpotlightEffect": "spotlight",
  "com.apple.messages.effect.CKEchoEffect": "echo",
  "com.apple.messages.effect.CKSparklesEffect": "sparkles",
  "com.apple.MobileSMS.expressivesend.impact": "impact",
  "com.apple.MobileSMS.expressivesend.loud": "loud",
  "com.apple.MobileSMS.expressivesend.gentle": "gentle",
  "com.apple.MobileSMS.expressivesend.invisibleink": "invisibleink",
};

const ATTACH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB

function dbArgs(): string[] {
  return IMSG_DB ? ["--db", IMSG_DB] : [];
}

function resolveHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Run an imsg subcommand to completion. Returns {ok, stdout, stderr}; never throws. */
function runImsg(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(IMSG_BIN, [...args, ...dbArgs(), "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs ?? 25_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/**
 * Pull the sent message's guid out of a `send-rich --json` result. The bridge returns a
 * small JSON object; the guid key has varied across imsg versions, so we accept the common
 * spellings and fall back to null (an unknown-shape or non-JSON stdout just means "no guid",
 * which callers treat as a non-registerable bubble — never an error).
 */
function parseSentGuid(stdout: string): string | null {
  const s = (stdout || "").trim();
  if (!s || s[0] !== "{") return null;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    for (const k of ["messageGuid", "message_guid", "guid", "id"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    /* not JSON — no guid */
  }
  return null;
}

/** Download a media URL to a temp file so it can be sent as a real attachment. */
async function downloadToTemp(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": ATTACH_UA, Accept: "image/*,*/*" },
    });
    if (!res.ok) {
      warn(`imsg attachment download ${res.status} for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_ATTACH_BYTES) {
      warn(`imsg attachment ${url} is ${buf.length} bytes — skipping`);
      return null;
    }
    const ctype = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    let ext = path.extname(new URL(res.url || url).pathname).toLowerCase();
    if (!ext) ext = MIME_EXT[ctype] || ".jpg";
    const fpath = path.join(os.tmpdir(), `imsg-out-${Date.now()}${ext}`);
    fs.writeFileSync(fpath, buf);
    return fpath;
  } catch (e) {
    warn(`imsg attachment download failed for ${url}: ${e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep the Mac session fully awake for the iMessage stack. Without `caffeinate
 * -d`, macOS tears down the XPC connections between imagent and
 * IMDMessageServicesAgent when the box looks idle, which makes imagent deaf to
 * APNS pushes. `-w <pid>` ties the caffeinate lifetime to the bot process: when the
 * bot exits or hot-reloads, caffeinate sees the pid disappear and exits too, so
 * restarts never leak or stack duplicate caffeinate processes. fig owns this itself
 * rather than inheriting it from whatever else happens to be running. */
let caffeinateStarted = false;
function startCaffeinate(): void {
  if (caffeinateStarted) return;
  caffeinateStarted = true;
  try {
    const child = spawn("caffeinate", ["-d", "-i", "-m", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", (e) => warn(`imsg: caffeinate failed to start (${e}) — Mac may sleep XPC`));
    child.unref();
    log(`imsg: caffeinate started (-d -i -m -s, tied to pid ${process.pid})`);
  } catch (e) {
    warn(`imsg: caffeinate spawn error (${e})`);
  }
}

export function makeImsgTransport(): Transport {
  const inbox: InboundMessage[] = []; // drained by poll()
  // The chat.db we read directly for native-poll votes AND threaded-reply targets (the
  // `imsg watch` stream surfaces neither). One resolution, shared by both readers.
  const chatDbPath = IMSG_DB ? resolveHome(IMSG_DB) : path.join(os.homedir(), "Library/Messages/chat.db");
  // guid → chat_guid, learned from inbound. Lets sends route by the exact thread guid
  // (the bridge wants a chat guid); cold sends fall back to a constructed iMessage;-;<num>.
  const chatGuidByPeer = new Map<string, string>();
  // guid → text of every message we've seen (incl. our own outbound, which the watch
  // echoes). Used to quote the original when reconstructing a reaction's text.
  const textByGuid = new Map<string, string>();
  // Inbound guids already enqueued — dedup against watch replays / respawns.
  const seen = new Set<string>();

  function remember<T>(set: Set<T>, v: T, cap = 2000): void {
    set.add(v);
    if (set.size > cap) set.delete(set.values().next().value as T);
  }
  function cacheText(guid: string, text: string): void {
    if (!guid || !text) return;
    textByGuid.set(guid, text);
    if (textByGuid.size > 2000) textByGuid.delete(textByGuid.keys().next().value as string);
  }

  function chatGuidFor(peer: string): string {
    return chatGuidByPeer.get(peer) || `iMessage;-;${peer}`;
  }

  /** Stage an inbound attachment to a temp file with a sane extension; return its path. */
  function stageAttachment(att: WatchAttachment, guid: string, idx: number): string | null {
    const src = resolveHome(att.filename || att.filepath || att.path || "");
    if (!src) return null;
    try {
      if (!fs.existsSync(src)) {
        warn(`imsg attachment missing on disk: ${src}`);
        return null;
      }
      let ext = path.extname(src);
      if (!ext) ext = (att.mime_type && MIME_EXT[att.mime_type.split(";")[0].trim()]) || ".bin";
      const dir = path.join(config.stateDir, "inbound", guid.replace(/[^\w-]/g, "").slice(0, 40) || "att");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `att-${idx}${ext}`);
      fs.copyFileSync(src, dest);
      return dest;
    } catch (e) {
      warn(`imsg attachment stage failed (${src}): ${e}`);
      return null;
    }
  }

  function handleEvent(ev: WatchEvent): void {
    const guid = ev.guid || "";
    const from = (ev.sender || "").trim();

    // Cache text for reaction-quote reconstruction (including our own outbound echoes).
    if (guid && ev.text) cacheText(guid, ev.text);
    // Keep the thread guid current so sends route by the exact chat — but a GROUP chat
    // only becomes a peer's reply route if it's explicitly allowlisted. Otherwise the
    // owner texting fig from inside a mixed group would make fig's reply (private
    // vault/email/location context) post back INTO that group where strangers read it.
    // Skipping the set() leaves routing on the prior 1:1 guid (or the iMessage;-;<peer>
    // fallback in chatGuidFor), so fig still answers the owner — privately, via DM.
    if (from && ev.chat_guid && (!ev.is_group || isAllowedGroup(ev.chat_guid))) {
      chatGuidByPeer.set(from, ev.chat_guid);
    }

    if (ev.is_from_me) return; // our own outbound echo — never ingest
    // Keepalive loopback: the "." we self-send round-trips and comes back as an
    // is_from_me=0 event from our own line. Drop it so the agent never ingests it.
    if ((ev.text ?? "").trim() === KEEPALIVE_TAG && isSelfAddr(from)) return;
    if (!guid || seen.has(guid)) return;

    // --- Reaction event → render as the [Reacted …] / [Removed …] text the agent reads.
    if (ev.is_reaction) {
      const emoji = ev.reaction_emoji || "";
      const quoted = (ev.reacted_to_guid && textByGuid.get(ev.reacted_to_guid)) || "";
      // Array/string .slice counts UTF-16 code units and can split an emoji's surrogate
      // pair at exactly the cutoff. That lone high surrogate poisons Claude's request JSON.
      const snippet = truncateUnicode(quoted.replace(/\s+/g, " ").trim(), 80);
      const verb = ev.is_reaction_add === false ? "Removed" : "Reacted";
      const tail = ev.is_reaction_add === false ? " reaction" : "";
      const text = snippet
        ? `[${verb} ${emoji}${tail} to "${snippet}"]`
        : `[${verb} ${emoji}${tail}]`;
      remember(seen, guid);
      inbox.push({
        id: guid,
        from,
        text,
        isGroup: ev.is_group,
        chatGuid: ev.chat_guid ?? undefined,
        chatName: ev.chat_name ?? undefined,
        at: ev.created_at,
      });
      return;
    }

    // --- Normal message (text and/or attachments).
    let mediaPaths: string[] | undefined;
    if (ev.attachments?.length) {
      const staged = ev.attachments
        .map((att, i) => stageAttachment(att, guid, i))
        .filter((p): p is string => p !== null);
      if (staged.length) mediaPaths = staged;
    }

    const text = ev.text ?? "";
    // Skip whitespace-only artifacts, not just empty ones. Post-Tahoe, `imsg watch`
    // leaks native-poll VOTE balloon rows into the stream with text = a lone space
    // (" "). `!text` is false for " ", so those slipped through as blank messages —
    // AND marked the guid `seen`, dedup-blocking the dedicated poll-vote watcher from
    // ever rendering the [Voted …] line. Trimming drops the artifact so the poll
    // watcher owns votes cleanly. A real message is never whitespace-only.
    if (!text.trim() && !mediaPaths?.length) return;

    remember(seen, guid);
    inbox.push({
      id: guid,
      from,
      text,
      isGroup: ev.is_group,
      chatGuid: ev.chat_guid ?? undefined,
      chatName: ev.chat_name ?? undefined,
      at: ev.created_at,
      mediaPaths,
    });

    // Read receipt: surface "Read" to the owner the instant we ingest their message
    // (bridge `imsg read`, fire-and-forget). Only the owner gets a receipt.
    if (from && isOwnerOrAlias(from)) void runImsg(["read", "--to", from], { timeoutMs: 8000 });
  }

  // --- Self-healing inbound watch stream -------------------------------------
  // `imsg watch --json` emits one event per line and runs forever. If it exits
  // (crash, Messages restart, db lock) we respawn with capped backoff so fig never
  // goes deaf — the failure mode this watchdog exists to catch.
  let backoff = 1000;
  function startWatch(): void {
    const args = [
      "watch",
      ...dbArgs(),
      "--json",
      "--reactions",
      "--attachments",
      "--convert-attachments",
    ];
    log(`imsg: starting watch stream (${IMSG_BIN} ${args.join(" ")})`);
    const child = spawn(IMSG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line[0] !== "{") continue; // skip blank / non-json log lines
        let ev: WatchEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          handleEvent(ev);
          backoff = 1000; // a parsed event means the stream is healthy
        } catch (e) {
          warn(`imsg: skipping malformed event: ${e}`);
        }
      }
    });
    child.stderr.on("data", (c) => {
      const s = c.toString().trim();
      if (s) warn(`imsg watch: ${s.slice(0, 200)}`);
    });
    child.on("error", (e) => err(`imsg watch spawn error: ${e}`));
    child.on("close", (code) => {
      warn(`imsg watch exited (code ${code}) — respawning in ${Math.round(backoff / 1000)}s`);
      setTimeout(startWatch, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  }
  startWatch();

  // --- APNS keepalive --------------------------------------------------------
  // Auto-detect fig's own iMessage handle (prefer the phone number; fall back to
  // the email login) and self-send a "." every 2min. The send round-trips, so its
  // loopback arrives as an is_from_me=0 event — handleEvent drops it via the
  // isSelfAddr + keepalive-tag guard so the agent never sees it. Override with
  // IMSG_SELF if detection ever picks the wrong alias.
  let selfAddress = (process.env.IMSG_SELF || "").trim();
  // True if `addr` is fig's own line (phone digits or email match) — used to drop
  // the keepalive loopback before it reaches the agent.
  function isSelfAddr(addr: string): boolean {
    if (!addr || !selfAddress) return false;
    const a = addr.trim().toLowerCase();
    const s = selfAddress.trim().toLowerCase();
    if (a === s) return true;
    const ad = a.replace(/\D/g, "");
    const sd = s.replace(/\D/g, "");
    return ad.length >= 10 && sd.length >= 10 && ad.slice(-10) === sd.slice(-10);
  }
  async function detectSelf(): Promise<void> {
    if (selfAddress) return;
    try {
      const res = await runImsg(["account"], { timeoutMs: 10_000 });
      if (!res.ok) return;
      const acct = JSON.parse(res.stdout) as { vetted_aliases?: string[]; login?: string };
      const phone = acct.vetted_aliases?.find((a) => /^\+?\d{6,}$/.test(a));
      const email = acct.vetted_aliases?.find((a) => a.includes("@"));
      selfAddress = phone || email || (acct.login || "").replace(/^e:/, "");
      if (selfAddress) log(`imsg: keepalive self-address = ${selfAddress}`);
    } catch (e) {
      warn(`imsg: could not detect self-address for keepalive (${e})`);
    }
  }
  function startKeepalive(): void {
    const tick = async (): Promise<void> => {
      // Make sure Messages is up WITH both dylibs before we self-send. A plain
      // `imsg send` would otherwise auto-launch Messages CLEAN (no injection),
      // silently killing the bridge AND Find My — so we heal first, then ping.
      await ensureInjected();
      await detectSelf();
      if (!selfAddress) {
        warn("imsg: keepalive skipped — no self-address yet");
        return;
      }
      const res = await runImsg(["send", "--to", selfAddress, "--text", KEEPALIVE_TAG, "--service", "imessage"], {
        timeoutMs: 15_000,
      });
      if (!res.ok) warn(`imsg: keepalive ping failed (${(res.stderr || res.stdout).slice(0, 120)})`);
      else log(`imsg: keepalive ping sent (apsd exercised) → ${selfAddress}`);
    };
    const timer = setInterval(() => void tick(), KEEPALIVE_INTERVAL_MS);
    timer.unref?.(); // don't keep the event loop alive on its own account
    void tick(); // fire one immediately so apsd is exercised the moment we boot
    log(`imsg: APNS keepalive started (self-send every ${KEEPALIVE_INTERVAL_MS / 1000}s)`);
  }
  /**
   * Watch chat.db for new native-poll votes and surface each as an inbound turn. Poll
   * balloon updates never come through `imsg watch`, so we sweep the db directly. The
   * cursor starts at the current MAX(ROWID) so we only catch votes cast from boot onward
   * (a vote while the bot is down is missed — rare, and the owner can just say their pick).
   * Only the owner's votes on polls fig created trigger a turn.
   */
  function startPollVoteWatch(): void {
    const dbPath = chatDbPath;
    let cursor = 0; // ROWID high-water mark; 0 until the baseline prime lands
    let primed = false; // false until we've absorbed pre-boot votes as the baseline
    const onErr = (msg: string): void => warn(`imsg: poll-vote sqlite read failed — ${msg}`);
    const tick = async (): Promise<void> => {
      // Seed off the vote fetch ITSELF, never a separate MAX(ROWID) read: that read was
      // flaky during the startup storm and, with the old <=0 guard, silently wedged the
      // watch forever. Here the first SUCCESSFUL fetch is the baseline — we absorb every
      // pre-boot vote (mark seen, advance cursor) and emit nothing, so history never
      // replays. A read failure returns null (already logged) and we simply retry; an
      // empty array is a real "no votes yet" and legitimately primes at cursor 0.
      const votes = await fetchNewPollVotes(dbPath, cursor, onErr);
      if (votes === null) return; // read failed — retry next tick, don't advance
      if (!primed) {
        for (const v of votes) {
          cursor = Math.max(cursor, v.rowId);
          if (v.guid) remember(seen, v.guid);
        }
        primed = true;
        log(
          `imsg: poll-vote watch started (baseline=${votes.length} votes, cursor=${cursor}, every ${POLL_VOTE_INTERVAL_MS / 1000}s)`,
        );
        return;
      }
      for (const v of votes) {
        cursor = Math.max(cursor, v.rowId);
        if (!v.guid || seen.has(v.guid)) continue;
        remember(seen, v.guid);
        // Owner-only for now: a group/stranger vote shouldn't drag fig's private context
        // into a turn. (Widen to allowlisted group polls if we ever run those.)
        if (!isOwnerOrAlias(v.from)) continue;
        inbox.push({ id: v.guid, from: v.from, text: renderVote(v), at: new Date().toISOString() });
        log(`imsg: poll vote from ${v.from} → ${v.chosen.join(", ") || "(cleared)"}`);
      }
    };
    const timer = setInterval(() => void tick(), POLL_VOTE_INTERVAL_MS);
    timer.unref?.();
    void tick();
  }
  startCaffeinate();
  // Ensure the dual-dylib injection is live before anything sends, then keep it
  // healed: a reboot/crash/clean-relaunch drops both dylibs silently, so a watchdog
  // re-injects within ~30s. This is what keeps Find My + the bridge alive across
  // Messages restarts instead of only at first manual launch.
  void ensureInjected();
  startInjectionWatchdog();
  startKeepalive();
  startPollVoteWatch();

  /** Send one text bubble. Prefers the bridge (send-rich: effects + reliability), and
   *  falls back to the AppleScript path (imsg send) if the bridge send fails. */
  async function sendText(to: string, text: string, effectId?: string, replyToId?: string): Promise<string | null> {
    const chat = chatGuidFor(to);
    // imsg's CLI arg parser treats ANY --text value that begins with "-" as a new
    // flag and bails with "Missing value for option text" — so the send throws and
    // the fanout silently fails the bubble over to Telegram. Our default formatting
    // is leading-dash bullet lists ("- like this"), so this trips on most structured
    // replies. Neither `--text=…` nor a `--` separator is honored by imsg, so prepend
    // an invisible zero-width space: the value no longer starts with "-" and it's
    // visually identical in Messages.
    const safe = text.startsWith("-") ? "​" + text : text;
    const richArgs = ["send-rich", "--chat", chat, "--text", safe];
    const effect = effectId ? EFFECT_BUNDLE_TO_IMSG[effectId] : undefined;
    if (effect) richArgs.push("--effect", effect);
    // Threaded reply (inline reply bubble) — bridge-only; the AppleScript fallback
    // below can't thread, so it silently degrades to a normal bubble.
    if (replyToId) richArgs.push("--reply-to", replyToId);

    const rich = await runImsg(richArgs);
    if (rich.ok) {
      noteRichSendSuccess();
      return parseSentGuid(rich.stdout);
    }
    // Tell the watchdog. A RUN of these is the wedged-bridge signature (bridge drops to
    // v0 while still reporting "connected"), and it surfaces here on the very next send
    // — long before the periodic probe would catch it.
    noteRichSendFailure();
    warn(`imsg send-rich failed (${(rich.stderr || rich.stdout).slice(0, 160)}) — falling back to plain send`);

    // AppleScript fallback: delivers the bubble but can neither thread nor return a guid.
    const plain = await runImsg(["send", "--to", to, "--text", safe, "--service", "imessage"]);
    if (plain.ok) return null;
    throw new Error(`imsg send failed: ${(plain.stderr || plain.stdout).slice(0, 200)}`);
  }

  /**
   * Send a url as a NATIVE iMessage rich link card (`imsg send-rich --url`). imsg resolves
   * the target's LinkPresentation metadata in ITS OWN process (the injected Messages helper
   * does no network) and bakes an LPLinkMetadata payload into the message, so the recipient
   * renders a real card instead of the grey "Tap to Load Preview" stub. Bridge-only.
   *
   * Returns the sent guid on success, or null when the rich-link path is unavailable — a
   * stale/absent bridge (`unsupportedBridge`), imsg < 0.13.0, or a target whose metadata
   * can't be prepared. Callers MUST fall back to sending the url as ordinary text on null;
   * a link that arrives as a plain bubble is fine, a link that never arrives is not.
   *
   * Chat targeting is stricter here than for `--text`: the rich-link path does an exact
   * chat_identifier/chat_guid lookup, so the synthesized `iMessage;-;<peer>` guid we use
   * everywhere else can be rejected outright. We try the normal guid first, then retry with
   * the `any;-;<peer>` service-agnostic form that matches how the row is actually stored.
   *
   * NO THREADING, deliberately — imsg cannot do both at once. `--url` together with
   * `--reply-to` is rejected during argument validation, before any RPC ever runs ("Invalid
   * value for option: --replyTo"; the bridge itself is blunter — `replyTo is not supported
   * with url`). The old code passed both, so EVERY bare-url bubble sent inside a threaded
   * context (the entire /bg lane, where each bubble replies onto the owner's message) failed the
   * card and degraded to plain text — i.e. straight back to the grey stub, with the warn
   * buried in the log. A real card matters more than an inline-reply bubble, so the reply
   * target is dropped here instead: the link lands as a card in the main timeline. /bg branch
   * continuity is unaffected — that rides on the SENT guid being registered
   * (registerBgReplyGuid), not on this bubble being visually threaded.
   */
  async function sendRichLink(to: string, url: string, chatGuid?: string): Promise<string | null> {
    const candidates = chatGuid ? [chatGuid] : [chatGuidFor(to), `any;-;${to}`];
    for (const chat of candidates) {
      const args = ["send-rich", "--chat", chat, "--url", url];
      const res = await runImsg(args);
      if (res.ok && !/unsupportedBridge/i.test(res.stdout)) {
        noteRichSendSuccess();
        return parseSentGuid(res.stdout);
      }
      const why = (res.stderr || res.stdout).trim().slice(0, 160);
      // Only a chat-targeting rejection is worth retrying with the other guid form —
      // and it's a US problem, not a bridge one, so it doesn't count against the bridge.
      if (!/invalid value for option: --chat/i.test(why)) {
        noteRichSendFailure();
        warn(`imsg rich link failed for ${url} (${why}) — falling back to plain text`);
        return null;
      }
    }
    warn(`imsg rich link: no chat guid form accepted for ${to} — falling back to plain text`);
    return null;
  }

  /**
   * Send a file attachment via the bridge. Returns the sent attachment's guid (same
   * `{"guid":…}` JSON shape as send-rich, parsed by parseSentGuid) so the /bg lane can
   * register an image/file bubble and have a threaded reply onto it continue the branch.
   * Returns null if the bridge doesn't surface a guid (AppleScript transport / odd stdout).
   */
  async function sendFile(to: string, file: string): Promise<string | null> {
    const chat = chatGuidFor(to);
    const args = ["send-attachment", "--chat", chat, "--file", file];
    // Audio-only files should render as native iMessage voice notes, not generic
    // downloadable attachments. `--audio` sets the IMCore audio-message metadata;
    // imsg handles the underlying file/container details.
    if ([".m4a", ".mp3", ".wav", ".caf", ".amr"].includes(path.extname(file).toLowerCase())) {
      args.push("--audio");
    }
    const res = await runImsg(args, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`imsg send-attachment failed: ${(res.stderr || res.stdout).slice(0, 200)}`);
    return parseSentGuid(res.stdout);
  }

  /**
   * Stamp any inbound that's a genuine threaded reply with its reply target, read straight
   * from chat.db (the watch stream carries no reply field). We resolve the originator guid +
   * its text/is_from_me in one batched query, then prefer our OWN decoded text cache over the
   * db's `text` column (which is often NULL on modern macOS — the text lives in attributedBody).
   * Fully defensive: a read failure or miss just leaves the messages un-annotated (no reply
   * context, normal routing) — it never throws into the poll loop.
   */
  async function annotateReplies(msgs: InboundMessage[]): Promise<void> {
    const guids = msgs.map((m) => m.id).filter(Boolean);
    if (!guids.length) return;
    let map: Awaited<ReturnType<typeof fetchReplyTargets>>;
    try {
      map = await fetchReplyTargets(chatDbPath, guids, (m) => warn(`imsg: reply-target read failed — ${m}`));
    } catch (e) {
      warn(`imsg: reply-target lookup threw — ${e}`);
      return;
    }
    if (!map || map.size === 0) return;
    for (const m of msgs) {
      const target = map.get(m.id);
      if (!target) continue;
      m.replyToId = target.originator;
      m.replyToFromMe = target.fromMe;
      // Resolution order: live watch cache → decoded attributedBody → db `text` column → empty.
      // The watch cache (decoded live, incl. our own outbound echoes) is the freshest source
      // but is empty for messages sent before this process started; `target.text` already
      // folds in the attributedBody decode + `text`-column fallback for exactly those older
      // rows (the `text` column is NULL for essentially all sent messages on modern macOS).
      // Note m.replyToId is set unconditionally above, so /bg branch auto-continue still fires
      // off the reply target even if no text can be resolved here.
      const text = (textByGuid.get(target.originator) ?? target.text ?? "").trim();
      if (text) m.replyToText = text;
    }
  }

  return {
    async poll(): Promise<InboundMessage[]> {
      const batch = inbox.splice(0);
      if (batch.length) await annotateReplies(batch);
      return batch;
    },

    async send(to: string, text: string, opts?: SendOptions): Promise<string | null> {
      // A bare link on its own line → native rich-link card (real preview, no tap needed).
      // The card path can't also thread (see sendRichLink), so a threaded context loses the
      // inline-reply bubble, not the card. Falls through to the plain-text send below — WITH
      // the reply target intact — when the bridge can't build the card, so the link always
      // lands one way or the other.
      if (opts?.richLinkUrl) {
        const guid = await sendRichLink(to, opts.richLinkUrl, opts.chatGuid);
        if (guid) return guid;
      }

      // Raw bytes (generated image / send_file tool) → write to temp, send as attachment.
      // imsg uses the file's basename as the display name on the recipient's end, so we
      // stage inside a unique temp DIR and keep the real filename intact (was renaming to
      // imsg-out-<ts>.<ext>, which is what the owner saw instead of the actual name).
      if (opts?.mediaBase64 && !opts.mediaUrl) {
        const ext = opts.mediaMime ? MIME_EXT[opts.mediaMime] || ".png" : ".png";
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imsg-out-"));
        const base = opts.mediaFilename ? path.basename(opts.mediaFilename) : "";
        const name = base
          ? path.extname(base)
            ? base
            : base + ext
          : `file-${Date.now()}${ext}`;
        const fpath = path.join(dir, name);
        fs.writeFileSync(fpath, Buffer.from(opts.mediaBase64, "base64"));
        try {
          const attGuid = await sendFile(to, fpath);
          // Prefer the caption bubble's guid when there's a caption; otherwise the
          // attachment's own guid — so a threaded reply onto a captionless /bg image
          // still has a guid to register (routing B for image bubbles).
          return text ? await sendText(to, text) : attGuid;
        } finally {
          fs.rm(dir, { recursive: true, force: true }, () => {});
        }
      }

      // A media URL → download, send as a real attachment; fall back to a text link.
      if (opts?.mediaUrl) {
        const fpath = await downloadToTemp(opts.mediaUrl);
        if (fpath) {
          try {
            const attGuid = await sendFile(to, fpath);
            return text ? await sendText(to, text) : attGuid;
          } catch (e) {
            warn(`imsg attachment send failed (${e}) — falling back to link`);
          } finally {
            fs.rm(fpath, () => {});
          }
        }
        text = text || opts.mediaUrl;
      }

      if (!text) return null;
      return await sendText(to, text, opts?.effectId, opts?.replyToId);
    },

    async typing(to: string): Promise<void> {
      try {
        await runImsg(["typing", "--to", to], { timeoutMs: 8000 });
      } catch {
        /* typing is best-effort */
      }
    },

    async stopTyping(to: string): Promise<void> {
      try {
        await runImsg(["typing", "--to", to, "--stop", "true"], { timeoutMs: 8000 });
      } catch {
        /* best-effort */
      }
    },

    async react(to: string, messageId: string, reaction: Reaction): Promise<void> {
      // Two shapes, two flags. A classic maps 1:1 onto imsg's --kind tokens
      // (like|love|dislike|laugh|emphasize|question → types 2000-2005). An
      // `{ emoji }` goes through --emoji, which builds the iOS 18 custom
      // reaction (type 2006, emoji in the message's own associatedMessageEmoji
      // field) through the IMCore bridge — a real tapback, not a sticker.
      const args = ["tapback", "--chat", chatGuidFor(to), "--message", messageId];
      if (isClassicReaction(reaction)) args.push("--kind", reaction);
      else args.push("--emoji", reaction.emoji);
      const res = await runImsg(args);
      if (!res.ok) {
        const detail = (res.stderr || res.stdout).slice(0, 160);
        warn(`imsg tapback failed: ${detail}`);
        // Throw, don't swallow: callers (the ack lane) fall back to a text
        // bubble so a failed reaction never leaves the owner with silence.
        throw new Error(`imsg tapback failed: ${detail}`);
      }
    },

    async sendPoll(to: string, question: string, options: string[], opts?: SendOptions): Promise<string | null> {
      const chat = opts?.chatGuid ?? chatGuidFor(to);
      // Same imsg arg-parser guard as sendText: a value starting with "-" is mis-read as
      // a flag, so prepend an invisible zero-width space (visually identical in the poll).
      const dash = (s: string): string => (s.startsWith("-") ? "​" + s : s);
      // Messages never renders a poll's title on the balloon — recipients see ONLY the
      // options. imsg compensates by echoing --question as a caption message right after
      // the poll, which for us is always redundant: fig writes the real setup in the bubble
      // BEFORE the poll, so the caption arrives as a duplicate restating what was just said.
      // `--no-comment` is the CLI's documented escape for exactly this ("when the caller
      // renders its own visible context before the poll"). The question still travels as the
      // stored payload title, which is what agent readback reads — so it's suppressed on the
      // wire, not dropped.
      const args = ["poll", "send", "--chat", chat, "--question", dash(question), "--no-comment"];
      for (const o of options) args.push("--option", dash(o));
      if (opts?.replyToId) args.push("--reply-to", opts.replyToId);
      const res = await runImsg(args);
      if (!res.ok) throw new Error(`imsg poll failed: ${(res.stderr || res.stdout).slice(0, 200)}`);
      // Same `{"guid":…}` JSON shape as send-rich/send-attachment — return it so the /bg
      // lane can register the poll bubble and continue the branch on a threaded reply to it.
      return parseSentGuid(res.stdout);
    },
  };
}
