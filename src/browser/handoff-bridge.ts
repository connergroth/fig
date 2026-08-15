import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { CDPSession, Page } from "playwright";
import { WebSocketServer, type WebSocket } from "ws";

import { log, warn } from "../core/log";

/**
 * Browser handoff streaming bridge (P1).
 *
 * Stands up a standalone, self-contained live "drive one step" surface for a SINGLE
 * Chrome tab: the tab's viewport is screencast to a phone web app over a WebSocket, and
 * the phone's taps/keystrokes are forwarded back into that same tab via CDP. The user
 * sees the exact live page, does the one un-automatable step (captcha, app-push 2FA, a
 * one-off credential), and taps "Done".
 *
 * This module is deliberately decoupled from any job/pause-resume orchestration — it just
 * exposes the tab and resolves `onDone` when the user is finished. Wiring it into the
 * approval/pause primitive is a later phase.
 *
 * WS protocol (shared verbatim with the phone web app in handoff-public/):
 *   server→client: {t:"frame",data,w,h} · {t:"status",msg} · {t:"bye"}
 *   client→server: {t:"mouse",type,x,y,button} · {t:"wheel",x,y,dx,dy}
 *                  {t:"key",type,key,code,text} · {t:"done"}
 */

const DEFAULT_PORT = 8723;
const PUBLIC_DIR = path.join(__dirname, "handoff-public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Virtual key codes for non-printable keys forwarded from the phone keyboard.
// CDP's Input.dispatchKeyEvent only triggers Chrome's editing/navigation commands
// (delete, submit, caret moves) when the windows/native virtual key code is set.
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

// Minimal placeholder so the server boots and is testable even before the frontend
// agent has dropped its files into handoff-public/.
const PLACEHOLDER_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>handoff bridge</title>
<body style="font-family:system-ui;margin:2rem;line-height:1.5">
<h1>handoff bridge is live</h1>
<p>The phone app (handoff-public/) hasn't been built yet. The WebSocket endpoint at
<code>/ws</code> is up and streaming.</p>
</body>`;

export interface HandoffBridge {
  /** URL the phone opens — e.g. http://<mini-LAN-ip>:<port>/ */
  url: string;
  /** Resolves when the user taps "Done" in the web app (or stop() is called). */
  onDone: Promise<void>;
  /** Stops screencast + closes WS + closes http server. Idempotent. */
  stop(): Promise<void>;
}

export async function startHandoffBridge(
  page: Page,
  opts?: { status?: string; port?: number },
): Promise<HandoffBridge> {
  const port = opts?.port ?? DEFAULT_PORT;
  const statusMsg = opts?.status ?? "drive this one step, then tap Done";

  // --- onDone wiring: resolved by a client {t:"done"} or by stop() ---------------------
  let resolveDone!: () => void;
  const onDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // --- static http server --------------------------------------------------------------
  const server = http.createServer((req, res) => serveStatic(req, res));

  // --- websocket server (upgrade /ws) --------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  let client: WebSocket | null = null;
  let metricsOverridden = false;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws));
  });

  // --- CDP screencast session ----------------------------------------------------------
  // One CDP session attached to this exact tab. Detached on stop().
  const cdp: CDPSession = await page.context().newCDPSession(page);

  // Forward each screencast frame to the connected client, THEN ack. The ack is
  // MANDATORY: Chrome will not emit the next frame until the prior one is acked, so the
  // stream silently stalls after frame 1 if we skip it.
  cdp.on("Page.screencastFrame", async (event: ScreencastFrame) => {
    if (client && client.readyState === client.OPEN) {
      send(client, {
        t: "frame",
        data: event.data,
        w: event.metadata.deviceWidth,
        h: event.metadata.deviceHeight,
      });
    }
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch (e) {
      // Session detached mid-flight (stop() raced the frame) — harmless.
      warn(`handoff: screencast ack failed: ${e}`);
    }
  });

  async function startScreencast(): Promise<void> {
    // A HEADED Chrome only renders — and therefore only screencasts — the FOREGROUND tab
    // in its window. If the tab we're handing off isn't the active one (multiple tabs open,
    // or the Chrome window isn't frontmost on the mini), Page.startScreencast succeeds but
    // emits ZERO frames, so the phone sits on "waiting for the live page…" forever with a
    // healthy WebSocket. Activating the tab first forces Chrome to render it so frames flow.
    try {
      await page.bringToFront();
    } catch (e) {
      warn(`handoff: bringToFront failed (continuing): ${e}`);
    }
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 1280,
    });
  }
  await startScreencast();

  // --- client lifecycle ----------------------------------------------------------------
  function attachClient(ws: WebSocket): void {
    // Only one driver at a time — a new connection replaces the old one.
    if (client && client.readyState === client.OPEN) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    client = ws;
    log("handoff: phone connected");
    send(ws, { t: "status", msg: statusMsg });

    // The screencast only emits a frame on visual CHANGE. A page that has already
    // settled (e.g. a static captcha) emits nothing, so a freshly-connected client
    // would sit on a black "waiting for the live page…" frame forever. Restart the
    // screencast on every connect to force an immediate fresh keyframe.
    void cdp
      .send("Page.stopScreencast")
      .then(() => startScreencast())
      .catch((e) => warn(`handoff: screencast restart failed: ${e}`));

    // Keep the WS hot. Without periodic traffic an idle connection (no new frames on
    // a static page) gets dropped by intermediaries (e.g. the tailscale serve proxy),
    // which is what caused the connect/disconnect churn.
    const keepalive = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 10_000);

    ws.on("message", (raw) => handleClientMessage(String(raw)));
    ws.on("close", () => {
      clearInterval(keepalive);
      if (client === ws) client = null;
      log("handoff: phone disconnected");
    });
    ws.on("error", (e) => warn(`handoff: ws error: ${e}`));
  }

  async function handleClientMessage(raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      warn("handoff: dropped non-JSON client message");
      return;
    }
    try {
      switch (msg.t) {
        case "mouse":
          await cdp.send("Input.dispatchMouseEvent", {
            type: msg.type,
            x: msg.x,
            y: msg.y,
            button: msg.button || "none",
            // clickCount must be 1 for press/release so the page registers a real click.
            clickCount: msg.type === "mousePressed" || msg.type === "mouseReleased" ? 1 : 0,
          });
          break;
        case "wheel":
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: msg.x,
            y: msg.y,
            deltaX: msg.dx,
            deltaY: msg.dy,
          });
          break;
        case "key": {
          // "char" inserts a literal character (insertText path). "keyDown"/"keyUp"
          // are real key events — Chrome only runs editing/navigation commands
          // (Backspace delete, Enter submit, arrows) when the virtual key code is
          // present, so map known control keys to their VK codes. Without this,
          // Backspace etc. dispatch but do nothing.
          const vk = VIRTUAL_KEY_CODES[msg.key];
          await cdp.send("Input.dispatchKeyEvent", {
            type: msg.type,
            key: msg.key,
            code: msg.code,
            text: msg.type === "char" ? msg.text : msg.text || undefined,
            ...(vk
              ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
              : {}),
          });
          break;
        }
        case "viewport": {
          // Reshape the remote tab to the phone's portrait viewport so the screencast
          // fills the screen instead of letterboxing a desktop-wide page. Cleared on stop().
          const w = Math.max(280, Math.min(1024, Math.round(msg.w)));
          const h = Math.max(480, Math.min(2048, Math.round(msg.h)));
          const dpr = Math.max(1, Math.min(3, msg.dpr || 1));
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: w,
            height: h,
            deviceScaleFactor: dpr,
            mobile: true,
          });
          metricsOverridden = true;
          // restart the screencast so a fresh frame at the new size lands immediately
          await cdp.send("Page.stopScreencast").catch(() => {});
          await startScreencast();
          break;
        }
        case "done":
          log("handoff: user tapped Done");
          resolveDone();
          break;
        default:
          warn(`handoff: unknown client message type`);
      }
    } catch (e) {
      warn(`handoff: failed to dispatch ${msg.t}: ${e}`);
    }
  }

  // --- stop (idempotent) ---------------------------------------------------------------
  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

    // Undo any phone-viewport reshaping so the tab returns to its real size for automation.
    if (metricsOverridden) {
      try {
        await cdp.send("Emulation.clearDeviceMetricsOverride");
      } catch {
        /* already detached */
      }
    }
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      /* already gone */
    }
    if (client && client.readyState === client.OPEN) {
      send(client, { t: "bye" });
    }
    try {
      await cdp.detach();
    } catch {
      /* already detached */
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resolveDone(); // no-op if already resolved
    log("handoff: bridge stopped");
  }

  // --- bind the server -----------------------------------------------------------------
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const url = `http://${lanIp()}:${port}/`;
  log(`handoff: bridge up at ${url} (open on a phone on the same LAN)`);

  return { url, onDone, stop };
}

// --- static file serving ---------------------------------------------------------------

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  // Confine reads to PUBLIC_DIR — reject any path that escapes it (../ traversal).
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.readFile(filePath, (e, data) => {
    if (e) {
      // No frontend files yet (or a missing asset) — serve a placeholder for the root so
      // the bridge itself stays testable before the phone app exists.
      if (rel === "index.html") {
        res.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
        res.end(PLACEHOLDER_HTML);
        return;
      }
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

// --- helpers ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    warn(`handoff: ws send failed: ${e}`);
  }
}

/**
 * The phone connects over the LAN, so the URL must use the mini's LAN address — not
 * 127.0.0.1 (loopback, unreachable from the phone). Pick the first non-internal IPv4;
 * fall back to localhost so the bridge still returns a usable URL for same-machine tests.
 */
function lanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}

// --- protocol + CDP event types --------------------------------------------------------

interface ScreencastFrame {
  data: string;
  sessionId: number;
  metadata: { deviceWidth: number; deviceHeight: number };
}

type ServerMessage =
  | { t: "frame"; data: string; w: number; h: number }
  | { t: "status"; msg: string }
  | { t: "bye" };

type ClientMessage =
  | { t: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "left" | "none" }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; type: "keyDown" | "keyUp" | "char"; key: string; code: string; text: string }
  | { t: "viewport"; w: number; h: number; dpr: number }
  | { t: "done" };
