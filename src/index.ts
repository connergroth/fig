import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { ensureBrowserChrome } from "./browser/chrome";
import { callLaneActive, startCallLane } from "./call/lane";
import { sleep } from "./render/chunking";
import { config, redact } from "./core/config";
import { currentModelLabel } from "./core/model";
import { isOwnerOrAlias, noteOwnerInbound } from "./core/owner";
import { startAgendaRefresh } from "./google/agenda";
import { startCalendarPoller } from "./google/calendar-poller";
import { startGmailWatch } from "./google/watch";
import { startLocationPoller } from "./location/poller";
import { startMailPolls } from "./mail/outlookPoll";
import { err, log, warn } from "./core/log";
import { setImageSink, updateImageSinkChatGuid } from "./image/sink";
import { startResearchWorker } from "./research/worker";
import { resetScratch } from "./core/scratch";
import { startScheduler } from "./scheduling/scheduler";
import { hasRunningJobs, restoreJobsFromDisk, undeliveredResultIds } from "./specialists/jobs";
import { ReloadGate } from "./session/reloadGate";
import { spawnBackgroundFig } from "./session/background";
import { isBgReplyGuid, registerBgReplyGuid } from "./session/bgReplyRegistry";
import { Conversation } from "./session/session";
import { primeWarmSession } from "./session/warmSession";
import { spotLane } from "./spot/lane";
import { logInbound } from "./session/transcript";
import { catchUpEmbeddings, syncAll as syncBrainIndex } from "./memory/brainIndex";
import { toWellFormedUnicode } from "./core/unicode";
import { makeTransport } from "./transport";
import type { InboundMessage, Transport } from "./transport";

/**
 * True when an inbound came from a multi-participant GROUP chat (vs. a 1:1 DM).
 *
 * The relay surfaces this directly as `isGroup` (chat.db's is_group column), which is
 * the primary signal. As a fallback we derive it from the thread guid shape: iMessage
 * group threads carry a `;+;chat…` guid — the `+` marks a group and the room id is a
 * `chat…` token — whereas a 1:1 DM is `;-;<handle>`. So either a `+` separator or a bare
 * `chat…` room id means group. Empty/owner DMs return false.
 */
function isGroupChat(msg: InboundMessage): boolean {
  if (msg.isGroup) return true;
  const guid = msg.chatGuid ?? "";
  return /;\+;/.test(guid) || /(?:^|;)chat[0-9a-fA-F-]+/.test(guid);
}

function assertEnv(): void {
  const problems: string[] = [];
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    problems.push("CLAUDE_CODE_OAUTH_TOKEN is unset. Run `claude setup-token` and put it in .env.");
  }
  if (config.ownerNumbers.length === 0) {
    problems.push("OWNER_NUMBERS is empty — nobody is allowed to talk to the agent.");
  }
  if (!fs.existsSync(config.brainDir)) {
    problems.push(`Brain dir does not exist: ${config.brainDir}`);
  }
  if (problems.length) {
    for (const p of problems) err(p);
    process.exit(1);
  }
}

function extForContentType(ct: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[ct.split(";")[0].trim()] ?? "";
}

/** Download any media the owner sent into the vault; return local file paths. */
async function downloadInboundMedia(msg: InboundMessage): Promise<string[]> {
  if (!msg.mediaUrls?.length) return [];
  const dir = path.join(config.stateDir, "inbound", msg.id);
  const paths: string[] = [];
  for (let i = 0; i < msg.mediaUrls.length; i++) {
    const url = msg.mediaUrls[i];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        warn(`media download ${res.status} for ${url.slice(0, 60)}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(dir, { recursive: true });
      const ext = extForContentType(res.headers.get("content-type") ?? "") || path.extname(new URL(url).pathname) || ".bin";
      const dest = path.join(dir, `att-${i}${ext}`);
      fs.writeFileSync(dest, buf);
      paths.push(dest);
    } catch (e) {
      warn(`media download failed: ${e}`);
    }
  }
  return paths;
}

/**
 * Read a yes/no out of an approval reply: true = approve, false = deny, null = not a
 * decision. Accepts a 👍/👎 TAPBACK on the prompt (arrives as `[Reacted 👍 to "..."]`),
 * a bare 👍/👎, or a typed yes/no word.
 */
function approvalDecision(text: string): boolean | null {
  const t = text.trim();
  // Tapback reaction: [Reacted 👍 to "..."] / [Removed 👎 reaction to "..."]
  const tb = t.match(/^\[(reacted|removed)\s+(\S+)\s+(?:reaction\s+)?to\b/i);
  if (tb) {
    if (tb[1].toLowerCase() === "removed") return null; // un-reacting isn't a decision
    const emoji = tb[2];
    if (emoji.includes("👍") || emoji.includes("❤️")) return true;
    if (emoji.includes("👎")) return false;
    return null; // laugh/emphasize/question — ambiguous, treat as a normal message
  }
  const lower = t.toLowerCase();
  if (/^👍/.test(t) || /^(y|yes|yep|yeah|ok|okay|sure|approve|do it|go)\b/.test(lower)) return true;
  if (/^👎/.test(t) || /^(n|no|nope|deny|stop|don'?t|cancel)\b/.test(lower)) return false;
  return null;
}

async function handle(convo: Conversation, transport: Transport, msg: InboundMessage): Promise<void> {
  // iMessage reaction quotes can be truncated between an emoji's UTF-16 code units.
  // Normalize at ingress so the malformed scalar cannot enter the queue, transcript,
  // or either model runtime.
  const text = toWellFormedUnicode(msg.text).trim();
  log(`◀ ${redact(msg.from)}: ${text.slice(0, 80)}${msg.mediaUrls?.length ? ` [+${msg.mediaUrls.length} media]` : ""}`);
  // Detect a `/btw`|`/bg`|`/background` up front so the inbound is logged with the
  // right flag: a /bg message is tagged `[bg]` in the transcript (so main's reseed
  // strips it — see recentHistory). Detected here and reused by the /bg branch below;
  // computed BEFORE logInbound so a /bg message is logged once, as a bg line, never
  // double-logged as a normal owner line.
  const btw = text.match(/^\s*\/(?:btw|bg|background)\b\s*/i);
  // Routing B: a THREADED reply onto one of fig's own /bg reply bubbles auto-continues that
  // branch — no need to re-type /bg. `replyToId` (chat.db thread_originator_guid, resolved by
  // the transport) matched against the /bg-outbound guid registry. Only when it's NOT already
  // an explicit /bg prefix, so we don't double-count.
  const bgReplyContinuation = !btw && isBgReplyGuid(msg.replyToId);
  const bgRoute = !!btw || bgReplyContinuation;
  logInbound(text || "(media)", { bg: bgRoute });

  // Feature 1: whenever this is an inline threaded reply, surface WHAT they replied to so the
  // model knows which earlier message they're responding to (rendered as a `[replying to "…"]`
  // marker at prompt-build time — never written into the raw transcript above).
  const replyContext = msg.replyToText ? toWellFormedUnicode(msg.replyToText).trim() || undefined : undefined;

  // Route a pending-approval reply (👍/👎 tapback, emoji, or word) to the waiting tool call.
  // A /bg continuation is for the branch, not the main loop's approval, so it skips this.
  if (!bgRoute) {
    const decision = approvalDecision(text);
    if (decision !== null) {
      // Normal case, unchanged: a yes/no with a 🔐 outstanding resolves it. The exception is
      // a tapback that explicitly names a DIFFERENT, already-expired prompt — they tapped a
      // dead bubble out of scrollback — because handing a yes they gave to action A over to
      // action B is the failure that actually costs money.
      if (convo.hasPendingApproval() && !convo.isStaleApprovalTarget(text)) {
        return convo.resolveApproval(decision);
      }
      // Otherwise: if this answers a 🔐 that already timed out, say so instead of going
      // silent — a 👍 that lands a minute late deserves an answer, not nothing. Only fires
      // when the message actually names a prompt we remember expiring; a stray "yes" falls
      // through to a normal turn.
      if (convo.handleLateApproval(text, decision)) return;
    }
    // Not a yes/no, or not about an approval — fall through and treat it as a normal message.
  }

  if (!bgRoute && /^(reset|new chat|start over)$/i.test(text)) {
    convo.reset();
    await transport.send(msg.from, "fresh start.");
    return;
  }

  // Keep image sink's chat guid current so relay can route attachments by thread, not just number.
  updateImageSinkChatGuid(msg.chatGuid);

  // Transport-staged local files (relay) first, then any URLs the daemon downloads.
  const media = [...(msg.mediaPaths ?? []), ...(await downloadInboundMedia(msg))];
  if (!text && !media.length) return; // nothing real (e.g. an empty/receipt artifact) — never enqueue

  // `/btw <task>` (also `/bg`, `/background`), OR a threaded reply onto a /bg bubble: spin up
  // an ISOLATED, concurrent background fig to knock out the task and reply on its own, WITHOUT
  // entering the main serial queue — so it never aborts or waits behind a long in-flight turn.
  // Detected above, before convo.enqueue, so it's a truly parallel lane.
  if (bgRoute) {
    // Register this /bg thread's ROOT guid so the NEXT threaded reply auto-continues the
    // branch. Crucial detail: iMessage collapses every reply in a thread onto the thread
    // ROOT — a reply onto ANY bubble in the thread carries thread_originator = the root
    // message, NEVER the individual bg bubble fig sent. So registering fig's own sent
    // bubbles (deliverReply does that too) never matches a real continuation; the root is
    // what replies actually point at. For an explicit /bg the root is THIS message; for a
    // continuation it's the message this reply threads onto (msg.replyToId = the thread
    // originator = the original /bg message). Idempotent, so re-registering is a no-op.
    registerBgReplyGuid(bgReplyContinuation ? msg.replyToId : msg.id);

    // For an explicit prefix, strip it; a threaded-reply continuation uses the full text.
    const task = btw ? text.slice(btw[0].length).trim() : text;
    if (!task && !media.length) {
      if (btw) await transport.send(msg.from, "what do you want me to knock out in the background?");
      return;
    }
    spawnBackgroundFig(transport, task, { replyTarget: msg.from, inboundId: msg.id, media, replyContext });
    return;
  }

  // Debounced: a burst of rapid-fire texts bundles into one turn.
  convo.enqueue(text, media, msg.id, msg.from, replyContext, msg.replyToId);
}

async function main(): Promise<void> {
  assertEnv();
  resetScratch(); // wipe + recreate the temp scratch dir (playwright/research artifacts) so nothing piles up
  // Catch the brain index up on anything written while we were down, or edited
  // outside transcript.ts (Obsidian hand-edits, a sync from another machine). Cheap —
  // an mtime+size stat per file, only changed files are re-parsed. Never fatal.
  try {
    const s = syncBrainIndex();
    if (s.changed) log(`brain index synced — ${s.changed}/${s.files} files, ${s.documents} documents`);
    // Vectors catch up in the BACKGROUND — boot is never blocked on ONNX. A small gap
    // (fig was down an hour) embeds itself in seconds; a full backfill is an explicit
    // supervised script rather than something that quietly starts itself here.
    const e = catchUpEmbeddings();
    if (e.started) log(`embedding ${e.pending} pending chunk(s) in the background`);
    else if (e.pending) {
      warn(`${e.pending} chunks have no vector — recall is keyword-only until you run: npm run embed:brain`);
    }
  } catch (e) {
    warn(`brain index sync failed: ${e}`);
  }

  const transport = makeTransport();
  const owner = config.ownerNumbers[0];
  const activeModel = currentModelLabel();
  log(
    `up — transport=${config.transport.kind}, model=${activeModel}${activeModel !== config.model ? ` (override; default ${config.model})` : ""}, brain=${config.brainDir}, owners=${config.ownerNumbers.length}`,
  );

  const convo = new Conversation(transport, owner);

  // Pre-warm the persistent streaming session: spawn the CLI subprocess + complete the MCP
  // handshake now, at boot, so the FIRST inbound message answers on an already-connected fleet
  // instead of paying the cold-boot tax. No-op unless WARM_SESSION=1. Best-effort — ensureWarmReady
  // falls back to a live create (and ultimately the cold path) if the pre-warm never lands.
  primeWarmSession();

  // Re-deliver anything a restart interrupted. A background job's result lives in two places —
  // the job registry and the synthetic inbound that wakes fig to relay it — and a process exit
  // inside the settle → debounce → turn window is enough to drop a finished job's work
  // entirely, with nobody ever told. The reload gate waits for that window to drain; this is
  // the safety net for the cases it can't gate (a crash, a kill, the bounded-out reload).
  // Must run AFTER the Conversation is
  // constructed — that's what wires the injector it delivers through. No-op when nothing's owed.
  try {
    restoreJobsFromDisk();
  } catch (e) {
    warn(`job-result restore failed (a result that settled before the restart may be lost): ${e}`);
  }

  if (owner) setImageSink(transport, owner);

  // Proactive email triage (Gmail push via Pub/Sub pull) + calendar change pings
  // (incremental sync), if Gmail/Calendar is connected.
  if (process.env.GOOGLE_REFRESH_TOKEN && owner) {
    startGmailWatch(transport, owner);
    startCalendarPoller(transport, owner);
    startAgendaRefresh(); // keep the week-ahead agenda warm for ambient prompt context
  } else {
    log("gmail watch + calendar poller off (no GOOGLE_REFRESH_TOKEN)");
  }

  // Poll-based triage for every non-Gmail account (the inboxes with no API path —
  // gmail stays on its push watch above), one loop each, whichever transport it uses.
  // DARK unless OUTLOOK_POLL=1; the function logs and returns immediately when off.
  if (owner) startMailPolls(transport, owner);

  // Proactive scheduler: reminders + any scheduled skills.
  if (owner) startScheduler(transport, owner);

  // Background deep-research worker: drains the job queue, texts the TLDR + link.
  if (owner) startResearchWorker(transport, owner);

  // Live-location poller: keeps ambient location warm + fires arrival watches.
  if (owner) startLocationPoller(transport, owner);

  // spot launch notifications: tail spot's owner-outbox file and deliver each
  // new-user / onboarding-complete / daily-digest line to the owner's thread.
  // (No-op without the personal spot lane — see src/spot/lane.ts.)
  if (owner) spotLane.startNotify(transport, owner);

  // FaceTime call lane (CALL_LANE=1): resident answer watcher + live call-state
  // monitor + prewarm-on-ring realtime sessions bridged into this process's brain.
  // Wrapped so a lane fault can never take the message loop down with it.
  if (owner) {
    try {
      startCallLane();
    } catch (e) {
      warn(`call lane failed to start: ${e}`);
    }
  }

  // Bring up the ONE shared Chrome the browse specialist + credential injector both
  // drive (CDP-attached @playwright/mcp, in-process origin-bound DOM fill). Best-effort:
  // if it can't launch now (e.g. no display yet) it's retried lazily on first browse.
  ensureBrowserChrome().catch((e) => warn(`shared browser launch deferred to first use: ${e}`));

  // Idle-gated hot reload. The agent can edit its own source (writableDirs includes
  // the repo) and edits also land via Syncthing from the laptop. A blunt watcher like
  // `tsx watch` restarts the instant a file changes — which would kill a turn (often
  // the agent's own self-edit) before it replies. Instead we flag source changes and
  // only restart at an idle moment: the in-flight turn finishes and replies on the old
  // code, then pm2 relaunches us with the new code. Runs under plain `tsx` (npm start).
  let restartPending = false;
  const reloadGate = new ReloadGate(); // owns the three signals, the once-only logging, and the drain bound
  let lastChange = 0;
  const RELOAD_QUIET_MS = 1500; // let a burst of synced files settle before restarting (partial-write guard, NOT a conversation heuristic)
  // The reload gate is EVENT-DRIVEN, not a clock. A pending reload applies at the next safe
  // turn boundary, gated on THREE real signals all being clear (see session/reloadGate.ts):
  //   1. No turn in flight        — convo.isIdle() (nothing running/buffered/awaiting approval)
  //   2. No background job running — hasRunningJobs() (browse/codex/btw one-shot sub-agents)
  //   3. No undelivered job result — undeliveredResultIds() (a job SETTLED and its result hasn't
  //      been consumed into a turn yet). 1+2 alone are both clear during that window, and it's
  //      the job's own completion that clears 2 — which is how a finished job's result gets lost
  //      seconds after it settles. Only 3 is bounded (a wedged injection can't hold a
  //      reload forever); when the bound is hit it proceeds loudly, and the persisted result is
  //      re-delivered on boot instead of vanishing.
  // Any failing = DEFER: keep restartPending, let the turn/jobs/injection finish, re-check next tick.
  //
  // Deliberately not a quiet-window timer. A clock only GUESSES the fleet is safe to tear down; the
  // two signals above KNOW it — a reload can no longer land mid-turn or orphan a live sub-agent
  // job. Incoming messages during a pending reload are handled normally on the old code, then
  // the gate is re-checked; a nightly/idle bounce still fires the instant the board clears.
  //
  // Starvation is naturally bounded: hasRunningJobs() only counts one-shot detached jobs
  // (killing one loses real work — must not be killed), and each is capped by the 5m idle
  // watchdog, so the board always clears in finite time. Persistent loops (calendar/gmail/
  // scheduler/research/location/spot pollers) are NOT job-registry entries — they re-init on
  // boot and never block the gate — so no long-lived watcher can hold a reload off forever.
  //
  // Watch THIS file's own directory (src/) via __dirname — index.ts lives at src/index.ts,
  // so __dirname is always the source root regardless of where config.ts sits or what
  // config.repoRoot resolves to. (A prior version joined config.repoRoot + "src" while
  // repoRoot itself was mis-resolving to <repo>/src, so it watched a nonexistent src/src
  // → ENOENT → the watcher silently died and self-edits never auto-applied. repoRoot is
  // correct now, but __dirname stays the right source for this — it can't drift.)
  const srcDir = __dirname;
  try {
    fs.watch(srcDir, { recursive: true }, (_evt, file) => {
      if (!file || !file.endsWith(".ts")) return;
      lastChange = Date.now();
      if (!restartPending) log(`code change (${file}) — reload queued, restarting when idle`);
      restartPending = true;
    });
    log(`hot-reload watcher armed on ${srcDir}`);
  } catch (e) {
    warn(`hot-reload watcher failed to start (edits won't auto-apply): ${e}`);
  }

  // handle() debounces into the conversation and returns fast; rapid-fire texts
  // bundle into one turn, and each turn is a single-shot run with a hard stop.
  for (;;) {
    try {
      const inbound = await transport.poll();
      for (const msg of inbound) {
        // Group-chat reply guard. fig answers ONLY on the owner's private 1:1 line. A
        // message from a multi-participant group must NEVER spawn an assistant turn or
        // reach spot routing — fig's reply can carry the owner's private context (calendar,
        // email, vault, spot internals), and posting it into a group leaks that to every
        // stranger in the thread. Drop it SILENTLY (no reply) but log it loudly. This
        // holds regardless of sender: even the owner texting from inside a group gets no
        // private-data reply there. There is no exemption: every group is untrusted.
        if (isGroupChat(msg)) {
          warn(
            `✗ group-chat guard: dropped inbound from ${redact(msg.from)} in group "${msg.chatName ?? "?"}" ` +
              `(${msg.chatGuid ?? "no-guid"}) — fig never replies into groups`,
          );
          continue;
        }
        if (!isOwnerOrAlias(msg.from)) {
          // External traffic is spot's, not fig's. Anyone who isn't the owner texting
          // this line is a spot user — route them into spot's brain (own repo, over
          // localhost HTTP) and reply on their thread. fig only ever answers the owner;
          // the /spot↔/fig switch governs only the owner's line. Fire-and-forget so the
          // poll loop stays responsive; per-sender turns serialize inside the router.
          // Without the personal spot lane (public checkout) this drops the message —
          // a stranger gets nothing either way, spot or no spot.
          spotLane.routeExternal(transport, msg);
          continue;
        }
        // Owner message — remember which handle (number vs email) they're on so proactive
        // outputs land in the thread they're actually using.
        noteOwnerInbound(msg.from);
        await handle(convo, transport, msg);
      }
    } catch (e) {
      err(`poll loop: ${e}`);
    }
    // Apply a queued code reload only at a safe turn boundary: the file burst has settled
    // (partial-write guard), no turn is in flight (convo.isIdle()), AND no async background
    // job (codex/browse/btw) is still running (hasRunningJobs()). Those jobs are children of
    // THIS process — restarting mid-flight orphans them: the registry is wiped, the child is
    // killed, the job never settles. That's the cross-repo self-sabotage where editing fig's
    // own code kills an in-flight codex job. When either signal is busy we DEFER — keep
    // restartPending and re-check on the next poll tick (which is also the next turn-end /
    // job-completion boundary), so the reload survives across turns and fires the instant the
    // gate clears. Each message that lands meanwhile is still answered on the old code.
    if (restartPending && Date.now() - lastChange >= RELOAD_QUIET_MS) {
      const safe = reloadGate.ready({
        // A warm/live CALL counts as busy: a reload would kill the brain bridge (and the
        // session child's parent) mid-conversation. The lane is bounded — sessions have a
        // hard max duration and missed-call warms reap themselves — so this can't starve.
        idle: convo.isIdle() && !callLaneActive(),
        jobsRunning: hasRunningJobs(),
        undeliveredResults: undeliveredResultIds(),
      });
      if (safe) {
        log("applying code update — restarting");
        process.exit(0);
      }
    }
    await sleep(config.transport.pollIntervalMs);
  }
}

process.on("SIGINT", () => {
  log("shutting down");
  process.exit(0);
});

main().catch((e) => {
  err(`fatal: ${e?.stack || e}`);
  process.exit(1);
});
