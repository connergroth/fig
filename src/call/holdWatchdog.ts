/**
 * The session child's hold-expiry watchdog — a RENEWABLE deadline, never a fixed fuse:
 * a fixed fuse fires on any session that merely waited too long, and its "ended" report
 * can tear down a call that is very much alive (see lane.ts prewarm for the other half
 * of that scoping).
 *
 * Protocol: a `--hold` child arms this at spawn. The lane writes `hold\n` heartbeats on
 * stdin while the session is still warming (ring not yet answered); each one renews the
 * deadline. "go" disarms it for good — a RELEASED session is governed by the call
 * watchdogs (tap silence, max session), never by hold expiry, so a slow fig turn can
 * never trip this. Expiry therefore means exactly one thing: the lane stopped talking
 * to a session it never released — orphan/lane-crash — and the child should die.
 */
export class HoldWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private disarmed = false;

  constructor(private readonly expireMs: number, private readonly onExpire: () => void) {}

  /** Start (or restart) the deadline. Returns this so `new HoldWatchdog(...).arm()` chains. */
  arm(): this {
    this.renew();
    return this;
  }

  /** A lane heartbeat landed — push the deadline out another full expireMs. */
  renew(): void {
    if (this.disarmed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onExpire();
    }, this.expireMs);
    this.timer.unref?.();
  }

  /** "go" arrived (or the child is shutting down) — the deadline may never fire again. */
  disarm(): void {
    this.disarmed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
