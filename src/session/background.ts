import { query } from "@anthropic-ai/claude-agent-sdk";

import { deliverAck } from "../ack/deliver";
import { ACK_TOOL_NAME } from "../ack/tools";
import { buildSystemPrompt } from "./agent";
import { buildFigMcpServers, FIG_DISALLOWED_TOOLS, THINKING_BUDGET } from "./session";
import { config } from "../core/config";
import { currentModel } from "../core/model";
import { deliverReply, deliverTapback, withReplyContext } from "../render/deliver";
import { isSilence } from "../render/chunking";
import { launchJob } from "../specialists/jobs";
import { log, warn } from "../core/log";
import { makeCanUseTool } from "../runtimes/permissions";
import { selectedLiveRuntimeSelection } from "../runtimes/registry";
import { describeSdkError } from "../runtimes/claude";
import { recentHistory } from "./transcript";
import type { Transport } from "../transport";
import { toWellFormedUnicode, toWellFormedUnicodeList } from "../core/unicode";

/**
 * `/btw` — an isolated, concurrent background fig instance.
 *
 * fig is normally ONE serial conversation: a throwaway "log a 6oz chicken breast" sent
 * mid-turn either aborts the real work or queues 10 minutes behind it. A `/btw <task>`
 * (also `/bg`, `/background`) escapes that: it spins up a fresh, ephemeral fig agent run
 * — same standing prompt (SOUL + CLAUDE + skills + the three open-loop lists via
 * buildSystemPrompt), same tools + vault access (buildFigMcpServers), and the same recent
 * conversation seeded in (recentHistory, like the main loop) so it's a true parallel
 * instance of fig with full context — just on its OWN independent, non-persisted context.
 * It knocks out the task, replies over iMessage on its own reply target, logs to
 * Conversations/ like any turn, and tears down.
 *
 * Isolation is the whole point, so this lane deliberately:
 *  - resumes NOTHING and persists NO session id (never touches the main loop's session.json
 *    via setSession) — a truly parallel context, invisible to the main turn and vice versa.
 *    (It's seeded with the recent transcript for grounding, but never writes a session back.)
 *  - delivers through its OWN reply target + tapback id (deliverReply args), never the
 *    Conversation's shared replyTo / lastInboundId singletons.
 *  - never mutates main-loop shared state (approver, turn signal, background injector,
 *    compaction/rollover state) — it wires none of them.
 *
 * It registers as a lightweight `btw` job on the shared board (launchJob), so it shows in
 * mcp__jobs__list, is killable via mcp__jobs__cancel, gets swept by the "stop" kill switch
 * (cancelAllJobs), and holds off the idle code-reload while in flight (hasRunningJobs). It's
 * `silent` so its completion never pushes back into the main conversation — it already
 * replied to the owner itself.
 */

/**
 * Scope fence, injected directly above the task on every /btw run.
 *
 * A background run is seeded with the recent transcript AND the standing open-loop lists,
 * which makes unclaimed work highly visible — and an inbound message with no reply under it
 * reads as "dropped" when it actually means the main loop is mid-turn on it. Picking that up
 * duplicates the work and, when both lanes touch the same files, corrupts each other's tree.
 * The fence states the one thing the seed can't: unanswered ≠ unhandled.
 */
const SCOPE_RULE =
  "[scope — this is a background branch running in parallel with the main fig, so it does " +
  "exactly ONE thing: the task in the message below. Everything else you can see — earlier " +
  "conversation, the open Pending/Todos/Tasks lists — is context for resolving what the task " +
  "refers to, and nothing more. Never pick up other work from it. In particular: a message " +
  "from the owner with no reply after it is NOT unhandled — the main fig is working on it right " +
  "now, and doing it here duplicates the work and can corrupt the other run's edits. If the " +
  "task turns out to already be done, say so instead of redoing it.]";

/** Max concurrent /btw runs. A 3rd is rejected with a one-liner rather than queued. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.BTW_MAX_CONCURRENT || 2));
let active = 0;

interface BackgroundContext {
  /** The handle the owner texted from — where the reply goes and the tapback lands. */
  replyTarget: string;
  /** The /btw message id, so a lone-emoji reply tapbacks their actual message. */
  inboundId?: string;
  /** Local paths of any media they attached to the /btw, surfaced to the run to Read. */
  media?: string[];
  /** Text of the message they threaded-replied onto (Feature 1) — rendered as a
   *  `[replying to "…"]` marker so the branch sees what they're responding to. */
  replyContext?: string;
}

/**
 * Spawn an isolated background fig run for `prompt`. Fire-and-forget: returns immediately.
 * Enforces the concurrency cap (rejects a 3rd with a short note) and registers the run on
 * the jobs board. `transport` is passed in (rather than a module singleton) so this stays
 * as testable + transport-agnostic as the rest of the loop.
 */
export function spawnBackgroundFig(transport: Transport, prompt: string, ctx: BackgroundContext): void {
  if (active >= MAX_CONCURRENT) {
    log(`/btw rejected — ${active}/${MAX_CONCURRENT} already running`);
    void transport.send(ctx.replyTarget, "got two of these going already, gimme a sec ✋").catch(() => {});
    return;
  }
  // Prefix a `[replying to "…"]` marker when this /bg run was triggered by a threaded reply,
  // so the branch sees WHICH message they're responding to (Feature 1), same as the main loop.
  const promptWithReply = withReplyContext(prompt, ctx.replyContext);
  // Surface any attached media the same way the main loop's bundle() does, so the run
  // knows to Read it.
  const taskText = ctx.media?.length
    ? `[the owner attached ${ctx.media.length} file(s); Read each to see/understand it: ${ctx.media.join(", ")}]\n\n${promptWithReply}`
    : promptWithReply;

  active += 1;
  launchJob({
    label: "btw",
    task: prompt.slice(0, 120),
    silent: true, // it replies to the owner itself — never push the result back to the main loop
    run: async (signal, report) => {
      report(`background fig: ${prompt.slice(0, 60)}`);
      // Independent typing indicator on the /btw's own reply target.
      void transport.typing?.(ctx.replyTarget).catch(() => {});
      const typing = setInterval(() => void transport.typing?.(ctx.replyTarget).catch(() => {}), 30_000);
      try {
        return await runBackgroundTurn(transport, taskText, ctx, signal, report);
      } finally {
        clearInterval(typing);
        void transport.stopTyping?.(ctx.replyTarget).catch(() => {});
        active -= 1;
      }
    },
  });
}

/**
 * One single-shot background agent turn on a CLEAN context. Streams the ack opener + the
 * final reply to the /btw's own target (mirrors the main loop's opener/final extraction),
 * then STOPS. Deliberately leaner than the main runTurn: no session resume/persist, no
 * model-fallback chain, no codex fallback — a /btw is a quick task, kept lean (the
 * token-budget rule: it must not fan out to workflows/deep-research).
 */
async function runBackgroundTurn(
  transport: Transport,
  taskText: string,
  ctx: BackgroundContext,
  jobSignal: AbortSignal,
  report: (action: string) => void,
): Promise<string> {
  // Own abort, chained off the job's signal so mcp__jobs__cancel / "stop" truly kill it.
  const abort = new AbortController();
  if (jobSignal.aborted) return "cancelled";
  const onAbort = (): void => abort.abort();
  jobSignal.addEventListener("abort", onAbort, { once: true });

  // Interactive approvals can't be routed to an isolated lane (the main loop owns the
  // approval channel). A /btw is meant for quick, non-gated tasks, so auto-deny anything
  // that needs a 👍 — the run's reply then explains it couldn't do the gated action.
  const askOwner = async (question: string): Promise<boolean> => {
    warn(`/btw hit an approval gate — auto-denying (background lane can't do interactive approvals): ${question}`);
    return false;
  };

  // Thread every background bubble onto the exact /bg message it answers (inline reply
  // bubble), so parallel /bg runs are told apart — AND lastInboundId still routes a
  // lone-emoji reply to a tapback on that same message.
  // A tapback ack lands on the exact /bg message this run answers — same target
  // as the threaded reply, so a reaction reads as "heard THAT one" even with
  // parallel /bg runs in flight.
  const tapback = (emoji: string): Promise<boolean> =>
    deliverTapback({
      transport,
      to: ctx.replyTarget,
      messageId: ctx.inboundId,
      emoji,
      bg: true,
    });

  const emit = (text: string): Promise<void> =>
    deliverReply({
      transport,
      to: ctx.replyTarget,
      raw: text,
      lastInboundId: ctx.inboundId,
      replyToId: ctx.inboundId,
      signal: abort.signal,
      bg: true, // tag every /bg reply `fig[bg]:` so main's reseed filter strips it
    });

  let sent = 0;
  let silenced = false;
  let resultError: string | undefined;

  try {
    // Full context, same as the main loop: seed the recent conversation so a /bg run
    // can resolve referents ("log that", "add it to the thing I just mentioned") and
    // act as a true parallel instance of fig, not an amnesiac one-off. It's still a
    // CLEAN, independent context — no session resume/persist, invisible to the main
    // turn — just no longer starting cold. Approvals stay auto-denied (see askOwner):
    // an isolated lane can't route an interactive 👍, and the owner runs one at a time
    // so gated collisions aren't a concern.
    // includeBg: a bg run inherits FULL main context AND prior bg turns (unlike a
    // main reseed, which strips bg lines) — so an ephemeral branch stays continuable.
    const history = recentHistory({ includeBg: true });
    const seededPrompt = history
      ? `[earlier conversation, for context only, do not reply to it:]\n${history}\n[end]\n\n${SCOPE_RULE}\n\n${taskText}`
      : `${SCOPE_RULE}\n\n${taskText}`;

    const selectedRuntime = selectedLiveRuntimeSelection();
    if (selectedRuntime) {
      const result = await selectedRuntime.runtime.runLiveTurn({
        prompt: toWellFormedUnicode(seededPrompt),
        signal: abort.signal,
        emit: async (text) => {
          const clean = text.trim();
          if (!clean || isSilence(clean)) {
            silenced = true;
            return;
          }
          await emit(clean);
          sent += 1;
        },
        askOwner,
        userInitiated: true,
        providerOptions: selectedRuntime.providerOptions,
      });
      if (!result.ok) resultError = result.error ?? `${selectedRuntime.name} runtime failed`;
    } else {
      const response = query({
        prompt: toWellFormedUnicode(seededPrompt),
        options: {
          cwd: config.brainDir,
          model: currentModel(), // same selected Claude model as the main loop
          thinking: { type: "enabled", budgetTokens: THINKING_BUDGET },
          abortController: abort,
          mcpServers: buildFigMcpServers(),
          canUseTool: makeCanUseTool(askOwner),
          permissionMode: "default",
          disallowedTools: FIG_DISALLOWED_TOOLS,
          settingSources: ["project"],
          skills: "all",
          systemPrompt: toWellFormedUnicodeList(buildSystemPrompt()),
        },
      });

      let reply: string[] = []; // assistant text since the last tool call (candidate final reply)
      let realAckSent = false;
      for await (const msg of response) {
        if (msg.type === "assistant") {
          const am = msg as any;
          if (am.parent_tool_use_id) continue; // subagent output — internal
          if (am.error) resultError = describeSdkError("assistant_error", am.error);
          const blocks = am.message?.content ?? [];
          const texts = blocks
            .filter((b: any) => b.type === "text" && b.text.trim())
            .map((b: any) => b.text)
            .join("\n\n")
            .trim();
          const toolBlocks = blocks.filter((b: any) => b.type === "tool_use");
          const hasTool = toolBlocks.length > 0;

          // Opener: the ack tool's `tapback` reacts on the /bg message this run
          // answers, and its `text` is the up-front beat. Deliver once, same
          // ordering as the main lane (ack/deliver.ts).
          const ackBlock = toolBlocks.find((b: any) => b.name === ACK_TOOL_NAME);
          if (ackBlock && !realAckSent) {
            const delivered = await deliverAck(ackBlock.input, { emit, tapback });
            if (delivered.silenced) silenced = true;
            sent += delivered.sent;
            realAckSent = true;
          }
          if (hasTool) {
            const first = toolBlocks.find((b: any) => b.name !== ACK_TOOL_NAME);
            if (first?.name) report(`tool: ${String(first.name).replace(/^mcp__/, "")}`);
            reply = []; // only text AFTER the last tool survives as the final reply
            continue;
          }
          if (texts) reply.push(texts);
        } else if (msg.type === "result") {
          const rm = msg as any;
          if (rm.subtype && rm.subtype !== "success")
            resultError = describeSdkError(`result:${rm.subtype}`, rm.result, rm.error);
          const finalText = reply.join("\n\n").trim();
          if (silenced || isSilence(finalText)) {
            silenced = true;
          } else if (finalText) {
            await emit(finalText);
            sent += 1;
          } else if (sent === 0 && typeof rm.result === "string" && rm.result.trim() && !isSilence(rm.result)) {
            await emit(rm.result.trim());
            sent += 1;
          }
        }
      }
    }
  } catch (e) {
    if (abort.signal.aborted) {
      log("/btw turn aborted");
      return "cancelled";
    }
    warn(`/btw turn threw: ${e}`);
    resultError = String(e);
  } finally {
    jobSignal.removeEventListener("abort", onAbort);
  }

  if (sent === 0 && !silenced && !abort.signal.aborted) {
    await transport
      .send(ctx.replyTarget, `⚠️ that /btw didn't produce a reply${resultError ? ` (${resultError})` : ""}.`)
      .catch(() => {});
  }
  return resultError ? `failed: ${resultError}` : "delivered";
}
