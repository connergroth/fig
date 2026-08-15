import net from "node:net";

import { lineFramer, type CallBridgeRequest, type CallBridgeResponse } from "./wire";

/**
 * The call brain bridge, CLIENT half — what a TypeScript session child speaks to the
 * lane's server (the Rust child has its own client in tools/call/child/src/bridge.rs).
 *
 * Two request shapes:
 *  - request():       one frame back (context / ask / hangup / note / ended)
 *  - requestStream(): many frames back for `ask_stream` — every `{delta}` frame calls
 *    onDelta, the `{done}` frame resolves with the full text. The timeout is an IDLE
 *    timeout (reset on every frame), because a fig turn with tools legitimately takes
 *    30s+ between deltas at the start but must never wedge the call forever.
 */
export class BridgeClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { onFrame: (r: CallBridgeResponse) => void }>();

  constructor(private readonly socketPath: string, private readonly token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.socketPath, () => resolve());
      s.setEncoding("utf8");
      s.on("error", (e) => {
        reject(e);
        for (const p of this.pending.values()) p.onFrame({ id: 0, ok: false, error: String(e) });
        this.pending.clear();
      });
      s.on(
        "data",
        lineFramer((line) => {
          try {
            const res = JSON.parse(line) as CallBridgeResponse;
            this.pending.get(res.id)?.onFrame(res);
          } catch {
            /* ignore malformed */
          }
        }),
      );
      this.socket = s;
    });
  }

  request(req: Omit<CallBridgeRequest, "id" | "token">, timeoutMs: number): Promise<CallBridgeResponse> {
    const id = this.nextId++;
    const full: CallBridgeRequest = { id, token: this.token, ...req };
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        resolve({ id, ok: false, error: "bridge socket not connected" });
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ id, ok: false, error: `bridge ${req.method} timed out (${timeoutMs}ms)` });
      }, timeoutMs);
      this.pending.set(id, {
        onFrame: (r) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(r);
        },
      });
      this.socket.write(`${JSON.stringify(full)}\n`);
    });
  }

  /**
   * Streaming ask: resolves with the FULL final text once the done frame lands.
   * Rejects into an error-shaped resolve (never throws) to match request().
   */
  requestStream(
    req: Omit<CallBridgeRequest, "id" | "token">,
    onDelta: (delta: string) => void,
    idleTimeoutMs: number,
  ): Promise<CallBridgeResponse> {
    const id = this.nextId++;
    const full: CallBridgeRequest = { id, token: this.token, ...req };
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        resolve({ id, ok: false, error: "bridge socket not connected" });
        return;
      }
      let timer: NodeJS.Timeout;
      const finish = (r: CallBridgeResponse): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ id, ok: false, error: `bridge ${req.method} idle for ${idleTimeoutMs}ms` }), idleTimeoutMs);
      };
      arm();
      this.pending.set(id, {
        onFrame: (r) => {
          if (!r.ok) return finish(r);
          if (r.delta !== undefined && !r.done) {
            arm();
            if (r.delta) onDelta(r.delta);
            return;
          }
          finish(r); // done frame (or a legacy single-frame reply)
        },
      });
      this.socket.write(`${JSON.stringify(full)}\n`);
    });
  }

  /** Fire-and-forget (still token-framed; the reply is discarded). */
  notify(req: Omit<CallBridgeRequest, "id" | "token">): void {
    void this.request(req, 5000);
  }

  close(): void {
    try {
      this.socket?.destroy();
    } catch {
      /* gone */
    }
  }
}
