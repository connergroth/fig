import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, Options, Query, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import {
  buildStaticSystemPrompt,
  loadSession,
  SESSION_MAX_AGE_MS,
  SESSION_MAX_CONTEXT_TOKENS,
  setSession,
} from "./agent";
// NOTE: intentional function-level import cycle with ./session — session.ts imports the
// warm-path entrypoints from here, and here we pull the shared run constants + isOverload
// predicate back from it (one source of truth, no drift). Neither reference happens at
// module-eval time (only inside methods), so there's no TDZ.
import { buildFigMcpServers, FIG_DISALLOWED_TOOLS, isOverload, THINKING_BUDGET } from "./session";
import { config } from "../core/config";
import { currentModel } from "../core/model";
import { log, warn } from "../core/log";
import { isProviderExhaustion } from "../runtimes/claude";
import { makeCanUseTool } from "../runtimes/permissions";
import { SURFACE_HOOKS } from "../runtimes/hooks";
import type { Approver } from "../specialists/approval";
import { newTurnState, processTurnMessage } from "./turnStream";
import { toWellFormedUnicode } from "../core/unicode";

/**
 * The persistent, WARM streaming session — the fix for the per-turn cold-boot that made the
 * MCP fleet (calendar/email/browse/…) flaky.
 *
 * Before: every inbound message ran a fresh one-shot `query()`, which spawned a new CLI
 * subprocess that tore down and re-registered the ENTIRE MCP fleet from scratch, then exited.
 * Every turn had a window where tools weren't wired up yet — reach for calendar/email inside
 * it and it failed with "MCP dropped." The slow external server (peekaboo) stretched that
 * window every turn.
 *
 * After: ONE long-lived `query()` fed by a persistent async generator (streaming-input mode).
 * The CLI subprocess and all MCP connections persist for the process lifetime — the handshake
 * is paid once (pre-warmed at boot via `startup()`), not per message. Each inbound bundle is
 * yielded as one user message; the turn's `result` marks its end and we wait for the next.
 *
 * What's preserved (see session.ts runTurn for how it wires in):
 *  - No-run-past: the model still produces exactly one assistant turn per user message and then
 *    stops at `result`. It cannot yield itself a new user message — only the generator (which
 *    WE feed from real inbound) starts the next turn. The guarantee holds structurally.
 *  - Per-turn abort: instead of killing the subprocess (which would defeat warming), a turn is
 *    cancelled with the streaming-mode `interrupt()` — the session and MCP fleet stay alive.
 *  - Model fallback / codex fallback: on a provider overload/exhaustion with nothing delivered,
 *    the warm turn returns `recover` and runTurn drops to the proven cold one-shot path, which
 *    owns the model-hop + codex-fallback logic. The warm layer is an optimization over it.
 *  - Crash recovery: the live session id is persisted every turn (setSession). On a process
 *    restart the warm session resumes it (`options.resume`), so continuity survives a bounce.
 *  - Size / idle rollover: when the session grows past the context cap or goes idle past the
 *    age cap, the warm query is torn down and recreated fresh (reseeded), exactly like the cold
 *    path's loadSession()-driven rollover — just once per ~150k tokens instead of every turn.
 *  - MCP self-heal: a failed server is reconnected via reconnectMcpServer() instead of a full
 *    process reboot.
 */

/**
 * Kill-switch. OFF by default — set WARM_SESSION=1 to opt in to the persistent warm session.
 * With the flag unset/anything-but-1, every turn takes the old cold one-shot path, byte-for-byte.
 * (Deliberately opt-in for now: this is a core-loop change under human review, not yet the live
 * default — flip to `=== "0"` / default-on once it's been supervised-tested.)
 */
export function warmSessionEnabled(): boolean {
  return process.env.WARM_SESSION === "1";
}

export type WarmTurnResult =
  | { status: "ok" }
  | { status: "aborted" }
  | { status: "empty"; error?: string }
  | { status: "recover"; error?: string };

interface EnsureOpts {
  askOwner: Approver;
}

interface RunWarmTurnOpts {
  emit: (text: string) => Promise<void>;
  /** React on the owner's latest inbound — the `ack({ tapback })` path. False = couldn't. */
  tapback?: (emoji: string) => Promise<boolean>;
  onWorkStarted?: () => void;
  abortSignal: AbortSignal;
}

class WarmSession {
  /** Pre-warmed handle from startup(), before its one-shot .query() is called. */
  private primed: Promise<WarmQuery> | null = null;
  /** The live streaming query for the current session. */
  private q: Query | null = null;
  /** Persistent manual iterator over q — driven turn-by-turn without closing the stream. */
  private iter: AsyncIterator<any> | null = null;
  /** Input generator plumbing: a queue the generator drains, and a waker for when it's empty. */
  private queue: SDKUserMessage[] = [];
  private waker: (() => void) | null = null;
  private genClosed = false;
  /** true until the first turn completes on the current query (needs a reseed). */
  private freshSession = true;
  /** Most recent turn's total input-context size, for size rollover. */
  private contextTokens = 0;
  /** Wall-clock of the last completed turn, for idle rollover. */
  private lastTurnAt = 0;
  /** The model the live query was created with (to detect a /model switch). */
  private activeModel: string | null = null;
  /** The query threw / ended unexpectedly — recreate on next use. */
  private dead = true;
  /** A turn is streaming right now — guards the MCP self-heal timer. */
  private busy = false;
  /** Serializes (re)creation so two turns can't race a startup(). */
  private creating: Promise<boolean> | null = null;
  /** Live approval router — canUseTool delegates here so it survives per-Conversation reuse. */
  private askOwner: Approver = async () => false;
  private healTimer: NodeJS.Timeout | null = null;

  // --- input generator ---

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.genClosed) {
      if (this.queue.length === 0) {
        await new Promise<void>((res) => {
          this.waker = res;
        });
        continue;
      }
      yield this.queue.shift()!;
    }
  }

  private push(text: string): void {
    const msg = {
      type: "user",
      message: { role: "user", content: toWellFormedUnicode(text) },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage;
    this.queue.push(msg);
    const w = this.waker;
    this.waker = null;
    w?.();
  }

  private buildOptions(): Options {
    return {
      cwd: config.brainDir,
      model: this.activeModel ?? currentModel(),
      thinking: { type: "enabled", budgetTokens: THINKING_BUDGET },
      resume: loadSession(), // undefined unless a fresh, in-cap session is persisted (crash recovery)
      mcpServers: buildFigMcpServers() as Record<string, McpServerConfig>,
      canUseTool: makeCanUseTool((q, prompt) => this.askOwner(q, prompt)),
      permissionMode: "default",
      disallowedTools: FIG_DISALLOWED_TOOLS,
      settingSources: ["project"],
      skills: "all",
      // Counters formatting orders baked into built-in tool descriptions that assume a
      // markdown surface (WebSearch's "close with markdown links"). See runtimes/hooks.ts.
      hooks: SURFACE_HOOKS,
      // Frozen at session start (streaming input). The per-turn grounding — date, location,
      // agenda, the three open-loop lists — is prepended to each user message by runTurn via
      // buildMessagePreamble() instead of living here.
      systemPrompt: toWellFormedUnicode(buildStaticSystemPrompt()),
    };
  }

  /** Pre-warm the subprocess + MCP handshake at boot so even the first turn is fast. */
  prime(): void {
    if (!warmSessionEnabled() || this.primed || this.q) return;
    this.activeModel = currentModel();
    try {
      this.primed = startup({ options: this.buildOptions() });
      // Swallow a background pre-warm failure — ensureReady() falls back to a live create.
      this.primed.catch((e) => {
        warn(`warm prewarm failed (will create lazily): ${e}`);
        this.primed = null;
      });
      log("warm session: pre-warming subprocess + MCP fleet");
      this.startHealTimer();
    } catch (e) {
      warn(`warm prewarm threw (will create lazily): ${e}`);
      this.primed = null;
    }
  }

  private async createQuery(): Promise<boolean> {
    await this.teardown();
    this.genClosed = false;
    this.queue = [];
    this.waker = null;
    this.activeModel = currentModel();
    const resumeId = loadSession();
    this.freshSession = resumeId === undefined;
    try {
      let warm = this.primed;
      this.primed = null;
      // The primed handle was startup()'d with boot-time options; only reuse it for the very
      // first create. Any recreate (rollover/death) builds a fresh one with current options.
      const wq = warm ? await warm : await startup({ options: this.buildOptions() });
      this.q = wq.query(this.input());
      this.iter = this.q[Symbol.asyncIterator]();
      this.dead = false;
      this.contextTokens = 0;
      this.lastTurnAt = Date.now();
      this.startHealTimer();
      log(`warm session: live (${this.freshSession ? "fresh" : "resumed"}, model=${this.activeModel})`);
      return true;
    } catch (e) {
      warn(`warm session create failed: ${e}`);
      this.dead = true;
      this.q = null;
      this.iter = null;
      return false;
    }
  }

  /**
   * Make sure a live query exists and is within the size/idle caps; recreate fresh if not.
   * Returns whether the next turn is on a fresh (reseed-needed) session.
   */
  async ensureReady(opts: EnsureOpts): Promise<{ ok: boolean; fresh: boolean }> {
    this.askOwner = opts.askOwner;
    // A /model switch to a new Claude model — retarget the live query without a teardown.
    if (this.q && !this.dead && this.activeModel && this.activeModel !== currentModel()) {
      try {
        await this.q.setModel(currentModel());
        this.activeModel = currentModel();
      } catch (e) {
        warn(`warm setModel failed, rolling over: ${e}`);
        this.dead = true;
      }
    }
    // Size / idle rollover — mirror the cold path's loadSession() caps.
    if (this.q && !this.dead) {
      const tooBig = this.contextTokens >= SESSION_MAX_CONTEXT_TOKENS;
      const tooOld = this.lastTurnAt > 0 && Date.now() - this.lastTurnAt >= SESSION_MAX_AGE_MS;
      if (tooBig || tooOld) {
        log(`warm session rollover (${tooBig ? "size" : "idle"}) — fresh session`);
        setSession(undefined); // drop the persisted id so the recreate starts fresh + reseeds
        this.dead = true;
      }
    }
    if (this.q && !this.dead) return { ok: true, fresh: this.freshSession };
    if (!this.creating) this.creating = this.createQuery();
    const ok = await this.creating;
    this.creating = null;
    return { ok, fresh: this.freshSession };
  }

  /**
   * Run ONE turn on the live streaming query. Pushes the (already-built: preamble + seed +
   * user text) prompt, drives the persistent iterator until this turn's `result`, and maps
   * the outcome. A new-message abort interrupts the turn (keeping the session warm).
   */
  async runTurn(prompt: string, opts: RunWarmTurnOpts): Promise<WarmTurnResult> {
    if (!this.q || !this.iter || this.dead) return { status: "recover", error: "warm session not live" };
    if (opts.abortSignal.aborted) return { status: "aborted" };

    const st = newTurnState();
    const onSession = (id: string, tokens?: number): void => {
      setSession(id, tokens);
      if (typeof tokens === "number") this.contextTokens = tokens;
    };
    const onAbort = (): void => {
      // Cancel the in-flight turn WITHOUT killing the subprocess — the whole point of warming.
      void this.q?.interrupt().catch(() => {});
    };
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    this.busy = true;
    try {
      this.push(prompt);
      // Inner guard around the read loop. A read can reject two ways: a genuine stream failure
      // (real error → recover to the cold path) OR the interrupt() from an abort tearing the
      // in-flight next() (expected → NOT a failure). We only recover on the former; on an abort
      // we swallow the throw and fall through to drainAbortedTail() below.
      try {
        for (;;) {
          const next = await this.iter.next();
          if (next.done) {
            // The stream ended — the query died under us. Recover to the cold path.
            this.dead = true;
            return { status: "recover", error: "warm stream ended" };
          }
          await processTurnMessage(next.value, st, {
            emit: opts.emit,
            tapback: opts.tapback,
            onWorkStarted: opts.onWorkStarted,
            onSession,
          });
          if (st.done) break;
          if (opts.abortSignal.aborted) break;
        }
      } catch (e) {
        if (!opts.abortSignal.aborted) {
          warn(`warm turn threw (rolling over): ${e}`);
          this.dead = true;
          return { status: "recover", error: String(e) };
        }
        // Aborted — the throw is the interrupt unwinding the read, not a real failure. Fall
        // through to the drain so the interrupted turn's tail doesn't bleed into the next turn.
      }
      // BUG-2 fix: after an interrupt, the turn's trailing messages + terminal `result` are still
      // queued in the persistent iterator. If we leave them, the NEXT turn's first iter.next()
      // reads them and delivers the PREVIOUS turn's response — the one-turn-behind bug. Drain and
      // discard them now, while `this.busy` is still true so the heal timer (gated on !busy) can't
      // touch the stream mid-drain.
      if (opts.abortSignal.aborted && !st.done) {
        await this.drainAbortedTail();
      }
    } catch (e) {
      if (opts.abortSignal.aborted) return { status: "aborted" };
      warn(`warm turn threw (rolling over): ${e}`);
      this.dead = true;
      return { status: "recover", error: String(e) };
    } finally {
      this.busy = false;
      opts.abortSignal.removeEventListener("abort", onAbort);
    }

    if (opts.abortSignal.aborted) return { status: "aborted" };

    // Turn completed cleanly on the wire — advance session bookkeeping.
    this.freshSession = false;
    this.lastTurnAt = Date.now();

    // Provider overload / exhaustion with nothing delivered → hand off to the cold path, which
    // owns the model-hop + codex-fallback ladder. Drop the warm session so the cold path
    // reseeds fresh (matching its own "overload → drop session → retry" behavior).
    if (st.sent === 0 && !st.silenced && (isOverload(st.resultError) || isProviderExhaustion(st.resultError))) {
      log(`warm turn hit provider trouble (no output) — recover to cold path: ${st.resultError}`);
      void this.reset();
      return { status: "recover", error: st.resultError };
    }
    // A tool turn that ended without a final reply is a failure only if something went wrong.
    if (st.toolSeen && !st.finalSent && !st.silenced && (st.resultError || (st.sent === 0 && !st.payloadDelivered))) {
      return { status: "empty", error: st.resultError ?? "tool turn ended without a final reply" };
    }
    if (st.sent > 0 || st.silenced) return { status: "ok" };
    return { status: "empty", error: st.resultError ?? "empty" };
  }

  /**
   * After an interrupt, drain the aborted turn's remaining messages (up to and including its
   * terminal `result`) out of the persistent iterator and DISCARD them. Without this the tail
   * stays queued in this.iter and the next turn's first iter.next() reads it — delivering the
   * PREVIOUS turn's response, one behind, until a teardown resets the stream. Bounded by a
   * message cap so a wedged stream can't hang us; if the terminal result never shows (or a read
   * throws), mark the session dead so ensureReady() recreates a clean query.
   */
  private async drainAbortedTail(): Promise<void> {
    if (!this.iter) return;
    const MAX_DRAIN = 200;
    for (let i = 0; i < MAX_DRAIN; i++) {
      let next;
      try {
        next = await this.iter.next();
      } catch {
        this.dead = true;
        return;
      }
      if (next.done) {
        this.dead = true;
        return;
      }
      if ((next.value as any)?.type === "result") return; // interrupted turn fully drained
    }
    this.dead = true; // never saw terminal result — don't risk a stale bleed
  }

  /** Tear down the live query/generator (best-effort). Keeps a primed handle if present. */
  private async teardown(): Promise<void> {
    this.genClosed = true;
    const w = this.waker;
    this.waker = null;
    w?.(); // let the generator observe genClosed and return
    const q = this.q;
    this.q = null;
    this.iter = null;
    if (q) {
      try {
        await q.interrupt();
      } catch {
        /* best-effort */
      }
      try {
        await q.return?.(undefined);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Full reset: drop the persisted session and tear down, so the next turn starts fresh. */
  async reset(): Promise<void> {
    setSession(undefined);
    this.dead = true;
    this.freshSession = true;
    this.contextTokens = 0;
    await this.teardown();
  }

  // --- MCP self-heal ---

  private startHealTimer(): void {
    if (this.healTimer) return;
    const everyMs = Math.max(30_000, Number(process.env.WARM_MCP_HEAL_MS || 90_000));
    this.healTimer = setInterval(() => void this.healMcp().catch(() => {}), everyMs);
    this.healTimer.unref?.();
  }

  /** Poll MCP status when idle; reconnect any failed server instead of a full process reboot. */
  private async healMcp(): Promise<void> {
    if (!this.q || this.dead || this.busy) return;
    let statuses;
    try {
      statuses = await this.q.mcpServerStatus();
    } catch {
      return;
    }
    for (const s of statuses) {
      if (s.status === "failed") {
        warn(`warm session: MCP '${s.name}' failed — reconnecting`);
        try {
          await this.q.reconnectMcpServer(s.name);
        } catch (e) {
          warn(`warm session: reconnect '${s.name}' failed: ${e}`);
        }
      }
    }
  }
}

const singleton = new WarmSession();

export function primeWarmSession(): void {
  singleton.prime();
}

export async function ensureWarmReady(opts: EnsureOpts): Promise<{ ok: boolean; fresh: boolean }> {
  return singleton.ensureReady(opts);
}

export function runWarmTurn(prompt: string, opts: RunWarmTurnOpts): Promise<WarmTurnResult> {
  return singleton.runTurn(prompt, opts);
}

export function resetWarmSession(): Promise<void> {
  return singleton.reset();
}
