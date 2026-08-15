#!/usr/bin/env python3
"""Persistent Kokoro-82M clause renderer for the LOCAL call front-end.

~/.fig/tts/render.py (the iMessage voice-note engine) pays the KPipeline model load on
EVERY invocation — fine for a one-shot voice note, fatal for a call where each clause
must be audible ~1s after its text exists. This worker loads the model ONCE at pre-warm
(the lane spawns it at ring time) and then renders clauses on demand for the whole call.

Contract (the seam tools/call/child/src/worker.rs depends on):
  - stdin : one JSON request per line   {"id": 1, "text": "...", "voice": "am_michael", "speed": 1.0}
  - stdout: one JSON reply per line
      startup:  {"ready": true, "load_s": ...}
      success:  {"id": 1, "ok": true, "b64": "<base64 pcm16le mono 24k>", "gen_s": ..., "audio_s": ...}
      failure:  {"id": 1, "ok": false, "error": "..."}
  - stderr: diagnostics only.

PCM (not wav) on purpose: the mouth eats raw pcm16/mono/24k, so the caller
concatenates and plays with zero conversion. Runs on the SAME venv as render.py
(~/.fig/tts/venv) so there is exactly one Kokoro install to keep working.
"""

import base64
import json
import sys
import time

SAMPLE_RATE = 24000


def main() -> int:
    import numpy as np
    from kokoro import KPipeline

    pipes = {}

    def pipe_for(voice: str):
        lang = "b" if voice.startswith("b") else "a"
        if lang not in pipes:
            pipes[lang] = KPipeline(lang_code=lang)
        return pipes[lang]

    t0 = time.time()
    pipe_for("am_michael")  # default voice's pipeline warm before we claim ready
    print(json.dumps({"ready": True, "load_s": round(time.time() - t0, 3)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            voice = req.get("voice", "am_michael")
            speed = float(req.get("speed", 1.0))
            t1 = time.time()
            pieces = []
            for result in pipe_for(voice)(req["text"], voice=voice, speed=speed):
                if result.audio is None:
                    continue
                pieces.append(np.asarray(result.audio, dtype=np.float32))
            pcm = b""
            if pieces:
                audio = np.concatenate(pieces)
                pcm = np.clip(audio * 32767.0, -32768, 32767).astype("<i2").tobytes()
            print(
                json.dumps(
                    {
                        "id": req.get("id"),
                        "ok": True,
                        "b64": base64.b64encode(pcm).decode("ascii"),
                        "gen_s": round(time.time() - t1, 3),
                        "audio_s": round(len(pcm) / 2 / SAMPLE_RATE, 3),
                    }
                ),
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 — one bad clause must not kill the call's mouth
            rid = req.get("id") if isinstance(req, dict) else None
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:400]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
