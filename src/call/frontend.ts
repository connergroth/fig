import path from "node:path";

import { config } from "../core/config";

/**
 * Which mouth+ears the call lane boots, and how to spawn the matching session child.
 *
 *   CALL_FRONTEND=local     (default) whisper → REAL streamed fig turn → kokoro,
 *                           clause-streamed. Every reply is actually fig; latency is
 *                           ~2-4s to first word, judgment is the full brain. Runs as
 *                           the Rust session child (tools/call/child).
 *   CALL_FRONTEND=realtime  the OpenAI realtime front-end, kept fully alive as the
 *                           fallback flag ("if it feels like voicemail tennis we flip
 *                           the flag same day"). Snappier turn-taking, small model,
 *                           ask_fig for substance. Runs as the TypeScript session
 *                           child (src/call/realtimeSessionChild.ts).
 *
 * Everything else — lane, bridge, pre-warm, transcripts, hangup, outbound dial — is
 * front-end-agnostic and shared.
 */

export type CallFrontendKind = "local" | "realtime";

export function resolveCallFrontend(env: NodeJS.ProcessEnv = process.env): CallFrontendKind {
  const v = (env.CALL_FRONTEND || "").trim().toLowerCase();
  if (v === "realtime") return "realtime";
  return "local"; // default, and the answer for unknown values (fail toward the real brain)
}

/** The local front-end's session child binary (override: CALL_RUST_CHILD_BIN). */
export function rustCallChildBinary(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CALL_RUST_CHILD_BIN?.trim() ||
    path.join(config.repoRoot, "tools", "call", "child", "target", "release", "fig-call-child")
  );
}

export interface CallChildLaunch {
  frontend: CallFrontendKind;
  command: string;
  args: string[];
}

/** How the lane spawns the session child for a front-end. */
export function callChildLaunch(
  frontend: CallFrontendKind,
  childArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CallChildLaunch {
  if (frontend === "realtime") {
    return {
      frontend,
      command: process.execPath,
      args: ["--import", "tsx", path.join(config.repoRoot, "src", "call", "realtimeSessionChild.ts"), ...childArgs],
    };
  }
  return { frontend, command: rustCallChildBinary(env), args: [...childArgs] };
}
