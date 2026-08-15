import { log, warn } from "../core/log";

/**
 * The idle-gated hot reload's decision, lifted out of index.ts's poll loop so it's one
 * readable state machine with real tests instead of a nested if/else inside the loop.
 *
 * A queued code update may only be applied at a genuinely safe boundary. Three signals, all
 * of which must be clear:
 *
 *   1. no turn in flight        — convo.isIdle()
 *   2. no background job running — hasRunningJobs()
 *   3. no undelivered job result — undeliveredJobResultIds() (jobResults.ts)
 *
 * (3) is what closes the hole (1) and (2) leave open: both are clear during the window a job's
 * result lives in — the job has left "running", and the wake it created is a synthetic inbound
 * sitting on a ~2.5s debounce, which is not a turn yet. Worse than a coincidence, it's the job's
 * OWN completion that clears (2) and opens the gate, so a reload parked seconds earlier exits the
 * process on top of a result nobody has seen. Signal (3) is set synchronously inside settle(),
 * before the job board can be observed as clear, and stays set until the wake is consumed into a
 * turn.
 *
 * (3) is the only signal with a BOUND. A turn or a running job must never be cut short — they
 * clear in finite time on their own (turns end; jobs are capped by the 5m idle watchdog). But a
 * wedged injection (nothing wired to consume it, a conversation stuck on an approval that never
 * resolves) would otherwise hold a reload off forever, and holding fig on stale code
 * indefinitely is its own failure. So the injection wait is capped, and when the cap is hit the
 * reload proceeds LOUDLY — which is safe precisely because jobResults.ts persisted the result:
 * boot re-delivers it. The bound is the fallback path onto the safety net, not a data-loss path.
 */

/** How long a pending reload waits for the injection queue to drain before proceeding anyway. */
export const INJECTION_DRAIN_MAX_WAIT_MS = Number(process.env.RELOAD_DRAIN_MAX_WAIT_MS || 90_000);

export interface ReloadGateState {
  /** convo.isIdle() — no turn running, nothing buffered, no approval outstanding. */
  idle: boolean;
  /** hasRunningJobs() — a browse/codex/claude-code/btw job is still in flight. */
  jobsRunning: boolean;
  /** Job ids whose settled results haven't been consumed into a turn yet. */
  undeliveredResults: string[];
}

export type ReloadBlocker = "turn" | "jobs" | "injection";

export class ReloadGate {
  private readonly now: () => number;
  private readonly maxInjectionWaitMs: number;
  private readonly logLine: (msg: string) => void;
  private readonly warnLine: (msg: string) => void;
  /** Each reason is logged once per process, not once per 4s poll tick. */
  private readonly logged = new Set<ReloadBlocker>();
  /** When the injection drain first blocked a ready-to-apply reload (0 = not blocked). */
  private injectionHeldSince = 0;

  constructor(
    opts: {
      now?: () => number;
      maxInjectionWaitMs?: number;
      log?: (msg: string) => void;
      warn?: (msg: string) => void;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxInjectionWaitMs = opts.maxInjectionWaitMs ?? INJECTION_DRAIN_MAX_WAIT_MS;
    this.logLine = opts.log ?? log;
    this.warnLine = opts.warn ?? warn;
  }

  /** The first unmet condition, or null when everything is clear. */
  blocker(state: ReloadGateState): ReloadBlocker | null {
    if (!state.idle) return "turn";
    if (state.jobsRunning) return "jobs";
    if (state.undeliveredResults.length > 0) return "injection";
    return null;
  }

  /**
   * True when the process may exit for a code update. Logs each distinct reason for deferring
   * once, and logs loudly if the injection drain bound is hit.
   */
  ready(state: ReloadGateState): boolean {
    const blocker = this.blocker(state);
    if (!blocker) {
      this.injectionHeldSince = 0;
      return true;
    }
    if (blocker !== "injection") {
      this.injectionHeldSince = 0;
      this.once(blocker, blocker === "turn" ? "the in-flight turn finishes" : "background jobs finish");
      return false;
    }
    const now = this.now();
    if (!this.injectionHeldSince) this.injectionHeldSince = now;
    const heldMs = now - this.injectionHeldSince;
    if (heldMs < this.maxInjectionWaitMs) {
      this.once("injection", `a finished job's result reaches the owner (${state.undeliveredResults.join(", ")})`);
      return false;
    }
    // Bounded out. Proceed — but say exactly what's being left behind and where it went, so a
    // silent loss can never look like a clean restart again.
    this.warnLine(
      `code update held ${Math.round(heldMs / 1000)}s on an undelivered job result and is proceeding anyway — ` +
        `${state.undeliveredResults.length} result(s) [${state.undeliveredResults.join(", ")}] are persisted and will be ` +
        `re-delivered on boot. an injection that never drains is itself a bug worth looking at.`,
    );
    this.injectionHeldSince = 0;
    return true;
  }

  private once(blocker: ReloadBlocker, waitingFor: string): void {
    if (this.logged.has(blocker)) return;
    this.logged.add(blocker);
    this.logLine(`code update queued — deferring restart until ${waitingFor}`);
  }
}
