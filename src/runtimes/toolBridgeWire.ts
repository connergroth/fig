/**
 * Wire format for the Codex tool bridge — deliberately its own leaf module, importing nothing.
 *
 * The child half (`fig-tools-mcp.ts`) is spawned fresh for EVERY codex run under a 20s startup
 * budget, so it must not import the server half (permissions, the lane surface, every
 * specialist's handler graph) just to learn the shape of a request. Types plus the two flag
 * names, nothing else, safe for both sides to import.
 *
 * The endpoint arrives as ARGV rather than env: codex spawns the stdio server itself, so the
 * only channel we control end-to-end is the `mcp_servers.fig_tools.args` list we already build
 * per run. Env would have to survive codex's own process plumbing, which we don't own.
 */

export const BRIDGE_SOCKET_FLAG = "--bridge-socket";
export const BRIDGE_TOKEN_FLAG = "--bridge-token";

export type BridgeMethod = "instructions" | "tools/list" | "tools/call";

export interface BridgeRequest {
  id: number;
  /** Per-run secret. A request without the run's own token is refused — see toolBridge.ts. */
  token: string;
  method: BridgeMethod;
  /** `tools/call` only: the flat (`server__tool`) name and its arguments. */
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface BridgeToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeCallResult {
  text: string;
  isError: boolean;
}

/**
 * One ok shape with per-method optional payloads rather than a discriminated union: the child
 * asks for exactly one thing per request and validates the field it asked for, so a union would
 * only add ceremony on both sides of a two-consumer protocol.
 */
export type BridgeResponse =
  | { id: number; ok: true; instructions?: string; tools?: BridgeToolInfo[]; call?: BridgeCallResult }
  | { id: number; ok: false; error: string };

/** Endpoint out of an argv list. Absent/blank → no bridge, i.e. today's in-child behaviour. */
export function readBridgeArgs(argv: readonly string[]): { socketPath: string; token: string } | null {
  const value = (flag: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? "").trim() : "";
  };
  const socketPath = value(BRIDGE_SOCKET_FLAG);
  const token = value(BRIDGE_TOKEN_FLAG);
  return socketPath && token ? { socketPath, token } : null;
}

/** Newline-delimited JSON framing, shared so the two halves can't disagree about it. */
export function lineFramer(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}
