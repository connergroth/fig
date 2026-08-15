#!/usr/bin/env python3
"""Persistent mlx_whisper transcriber for the LOCAL call front-end.

src/stt/transcribe.ts shells out to the mlx_whisper CLI per utterance, which reloads the
model on EVERY invocation — ~1.4s of a ~1.5s stt step on a call turn (kokoro_worker.py
exists for the same reason on the TTS side). Fine for a one-shot iMessage voice note,
which still takes that path; fatal on a call where the reload tax lands between
the owner finishing a sentence and fig starting to think. This worker loads the model ONCE
at pre-warm (spawned at ring time alongside the kokoro worker) and transcribes wav paths
on demand for the whole call.

Contract (the seam tools/call/child/src/worker.rs depends on — same line-JSON protocol
as kokoro_worker.py):
  - argv   : [1] model (HF repo or local dir), [2] language ("" = auto-detect)
  - stdin  : one JSON request per line   {"id": 1, "path": "/tmp/utt.wav"}
  - stdout : one JSON reply per line
      startup:  {"ready": true, "load_s": ...}       (model genuinely hot, not just imported)
      success:  {"id": 1, "ok": true, "text": "...", "tr_s": ...}
      failure:  {"id": 1, "ok": false, "error": "..."}
  - stderr : diagnostics only.

Run with the SAME interpreter as the mlx_whisper CLI (the caller reads the CLI's
shebang) so there is exactly one mlx_whisper install to keep working. mlx_whisper's
transcribe() caches the loaded model per repo path in-process (ModelHolder), so the
warm-up transcription below is what actually pays the load — every later call reuses it.
"""

import json
import os
import sys
import time

DEFAULT_MODEL = "mlx-community/whisper-small-mlx"  # transcribe.ts's default — keep in step


def main() -> int:
    model = (sys.argv[1] if len(sys.argv) > 1 else "").strip() or DEFAULT_MODEL
    language = (sys.argv[2] if len(sys.argv) > 2 else "en").strip() or None

    # Same offline policy as transcribe.ts: a cache miss must fail fast, never hang a
    # live call on a multi-GB download. STT_ALLOW_DOWNLOAD=1 opts back in.
    if os.environ.get("STT_ALLOW_DOWNLOAD") != "1":
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

    import numpy as np
    import mlx_whisper

    def transcribe(audio, **kw):
        # A forced language (default en, mirroring transcribe.ts) stops whisper from
        # "detecting" a foreign language out of 2s of noise and hallucinating in it.
        opts = {"language": language} if language else {}
        return mlx_whisper.transcribe(audio, path_or_hf_repo=model, verbose=None, **opts, **kw)

    # Warm-up: half a second of silence forces the real model load NOW, so "ready"
    # means hot — the whole point of being a resident worker.
    t0 = time.time()
    transcribe(np.zeros(8000, dtype=np.float32))
    print(json.dumps({"ready": True, "load_s": round(time.time() - t0, 3), "model": model}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            t1 = time.time()
            result = transcribe(req["path"])
            text = (result.get("text") or "").strip()
            print(
                json.dumps({"id": req.get("id"), "ok": True, "text": text, "tr_s": round(time.time() - t1, 3)}),
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 — one bad utterance must not kill the call's ears
            rid = req.get("id") if isinstance(req, dict) else None
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:400]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
