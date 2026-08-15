import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { KOKORO_VOICES } from "./provider";
import { speak } from "./speak";

/**
 * Local text-to-speech. Kokoro-82M on the mini, free, offline, unlimited.
 *
 * The ask: fig should be able to send audio the owner can listen to while driving —
 * briefings, digests, "read me this." That makes TTS a habit rather than a one-off, and a
 * habit has to cost nothing per use: a daily 5-minute briefing through ElevenLabs is ~$14/mo.
 * So there are deliberately TWO lanes, and this is the volume one.
 *
 *   volume  (here)      Kokoro-82M, local, $0/use, ~7x realtime.
 *   publish (untouched) ElevenLabs eleven-v3, ~$0.40/run, for anything with the owner's name on
 *                       it. Quality is the product there. Don't route it through this tool.
 *   calls   (untouched) Vapi, TTS bundled in the per-minute rate.
 *
 * Chosen over Piper, Edge TTS, Orpheus 3B and macOS `say` in a measured bake-off.
 * Named `speak` on a `tts` server, not
 * `kokoro`: the engine is swappable behind the provider seam (provider.ts), the capability
 * isn't. Same reason `lights` isn't called `govee`.
 *
 * DELIVERY: this returns a path, it does not send anything. Put that path alone on its own
 * line in the reply and chunking lifts it into its own bubble, which delivery sends as a real
 * playable iMessage audio attachment (see render/chunking.ts `isLocalFilePath`).
 */
export const ttsServerDef = defineServer({
  key: "tts",
  kind: "direct",
  purpose: "render text to a local .m4a with Kokoro-82M so fig can send listenable audio at zero cost",
  exposure: "both",
  capabilities: [
    {
      name: "speak",
      purpose: "render text to a playable .m4a on disk with the local Kokoro voice",
      mutates: "write",
      fallback: "deny",
      fallbackReason:
        "nothing about it is unsafe — it's local and free — but the Codex stdio surface is pinned to the pre-rewrite 16 on purpose, and the fallback runtime has no delivery path to put the rendered file in front of the owner anyway. Flip to allow the day it does.",
      description:
        "Turn text into speech as a native iMessage audio message, rendered locally with Kokoro-82M — free, offline, no per-use cost, so use it freely. Best for anything the owner would rather LISTEN to than read: a morning briefing, a digest, a long article, 'read me this'. Returns the absolute path to an .m4a. To actually send it, put that path ALONE ON ITS OWN LINE in your reply — it then arrives as the real waveform-style iMessage audio bubble, not a generic file attachment. Write the text the way it should SOUND (spoken sentences, no markdown, no bullet lists, spell out anything you want read as letters), because it is read literally. Renders at ~7x realtime: a 5-minute briefing takes ~45s. Not for anything published under the owner's name — that's the ElevenLabs lane.",
      input: {
        text: z.string().describe("What to say, written as it should sound when read aloud."),
        voice: z
          .enum(KOKORO_VOICES as unknown as [string, ...string[]])
          .optional()
          .describe("am_michael = US male (default), bm_george = British male, af_heart = US female."),
        speed: z
          .number()
          .optional()
          .describe("Speech rate multiplier, 0.5–2.0. Default 1.0. Only set it if they ask for faster/slower."),
      },
      handler: async (args) => {
        try {
          const r = await speak({ text: String(args.text ?? ""), voice: args.voice, speed: args.speed });
          const mins = Math.floor(r.seconds / 60);
          const secs = Math.round(r.seconds % 60);
          const length = mins ? `${mins}m ${secs}s` : `${secs}s`;
          return (
            `${r.path}\n` +
            `${length} of audio (${r.voice}), rendered in ${(r.renderMs / 1000).toFixed(1)}s via ${r.engine}. ` +
            `Send it by putting that path alone on its own line.`
          );
        } catch (e) {
          return `speak failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const ttsServer = toSdkServer(ttsServerDef);
