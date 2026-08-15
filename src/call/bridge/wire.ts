/**
 * Wire format for the call brain bridge — the reverse-direction sibling of the codex
 * tool bridge (`runtimes/toolBridgeWire.ts`). There the child asks to run FIG'S TOOLS;
 * here the session child asks fig itself: give me opening context, answer a
 * question with your real memory/tools, hang up the call, remember this transcript line.
 *
 * Deliberately a leaf module (imports nothing but the shared framer) so the session
 * child can load it without dragging the server half's dependency graph into a process
 * whose whole job is sub-second audio.
 */

export { lineFramer } from "../../runtimes/toolBridgeWire";

export const CALL_BRIDGE_SOCKET_FLAG = "--bridge-socket";
export const CALL_BRIDGE_TOKEN_FLAG = "--bridge-token";

export type CallBridgeMethod =
  /** Opening context block for the session instructions (who/when/agenda/pendings). */
  | "context"
  /** Run a REAL fig turn on `question`; resolves with fig's text answer. Long (5–60s). */
  | "ask"
  /**
   * Same real fig turn, STREAMED: the server sends any number of `{delta}` frames as
   * text arrives, then one `{done: true, text}` frame with the full reply. This is the
   * clause-streaming seam — the local front-end speaks fig's first sentence while the
   * rest of the turn is still cooking.
   */
  | "ask_stream"
  /** End the call on the machine (AX press End/Leave, FaceTime-kill fallback). */
  | "hangup"
  /** Fire-and-forget transcript line, logged into Conversations/ as it happens. */
  | "note"
  /** The session is over; `reason` says why. The lane finalizes (digest + teardown). */
  | "ended";

export interface CallBridgeRequest {
  id: number;
  /** Per-session secret — a request without this session's token is refused. */
  token: string;
  method: CallBridgeMethod;
  /** `ask` only. */
  question?: string;
  /**
   * `ask_stream` only: the question IS the owner's own words, verbatim, and the lane
   * owns writing them into the conversation transcript — once, when the turn starts.
   * The local front-end sets it (everything it asks is speech it just transcribed); the
   * realtime front-end's `ask_fig` does not, because that question is composed by its
   * model and it logs their speech itself.
   */
  spoken?: boolean;
  /**
   * `ask_stream` only: they talked over the LAST reply, and this is the text they had actually
   * heard of it when they cut in (empty when the flush landed before any clause did). Present
   * = interrupted. Annotates the MODEL INPUT for this one turn and nothing else — it is not
   * a transcript line, it never reaches the day file, and it expires in the child if no
   * turn claims it (tools/call/child/src/interrupt.rs).
   */
  interrupted?: string;
  /** `note` only. */
  speaker?: "owner" | "fig";
  text?: string;
  /** `ended` only. */
  reason?: string;
}

export type CallBridgeResponse =
  | {
      id: number;
      ok: true;
      text?: string;
      /** `ask_stream` progress frame: one chunk of fig's reply as it generates. */
      delta?: string;
      /** `ask_stream` final frame marker — `text` carries the full reply. */
      done?: boolean;
    }
  | { id: number; ok: false; error: string };

/** Parse the bridge endpoint out of a child argv. Absent → no bridge (bench-only run). */
export function readCallBridgeArgs(argv: readonly string[]): { socketPath: string; token: string } | null {
  const value = (flag: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? "").trim() : "";
  };
  const socketPath = value(CALL_BRIDGE_SOCKET_FLAG);
  const token = value(CALL_BRIDGE_TOKEN_FLAG);
  return socketPath && token ? { socketPath, token } : null;
}
