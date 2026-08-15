# Call session child

The session child for the default local call front-end (`CALL_FRONTEND=local`):
in-process cpal playback, energy-VAD endpointing, persistent Whisper/Kokoro
Python workers, clause-streamed fig turns over the lane's bridge socket. The
TypeScript lane (`src/call/lane.ts`) is the orchestrator and spawns the release
binary; `CALL_FRONTEND=realtime` uses the TypeScript realtime child
(`src/call/realtimeSessionChild.ts`) instead.

Nothing on a call speaks except the two of them. There is no greeting, no filler,
no status line: an inbound call answers into silence and listens, and only an
OUTBOUND call opens with anything (fig dialed, so fig says why).

Turn-taking rules (`src/barge.rs` holds the decisions, `src/transcript.rs` decides
what counts as speech at all):

- WORDS cut fig off, not sound. Barge-in waits for whisper to come back with real
  words; an utterance that transcribes to nothing leaves the reply playing and
  the turn alone
- speech over audio they can actually hear cuts fig off, as always
- speech into a turn's THINKING silence does not: the utterance folds into the
  running turn and is answered when that turn lands, instead of throwing away a
  reply they never heard and restarting the clock cold
- a superseded turn's brain request is CANCELLED, not just ignored — it runs in
  the bot, where its tool calls would otherwise still fire
- whisper loops on near-silence (one clause repeated 3-50 times) are collapsed to
  a single copy, and a runaway loop with nothing else in it is not a turn; the
  phantom phrases whisper invents on silence ("Thank you.", subtitle credits) are
  dropped outright
- when they DO cut fig off, the next turn's prompt is told so, and told exactly
  what they heard first (`src/interrupt.rs`). Prompt-only: never a transcript line
- nothing they SAY ends the call: the model's `hang_up` and their own hangup button are
  the only two ways out, and words like "hang up" reach the brain as ordinary speech

Playback is PACED by the device, not by the renderer (`src/audio.rs`): kokoro runs
several times faster than realtime, so a clause is handed to the mouth in chunks
and only as the queue drains under `PLAYBACK_LEAD_MS`. At most one clause is ever
rendered-but-unplayed, a barge-in throws away a fraction of a clause instead of a
whole reply, and the pre-hangup drain is finite by construction.

The mic bar is MEASURED, never hardcoded (`src/vad.rs`): the first
`CALL_VAD_CALIBRATION_MS` of a call sample the quiet room, the trigger is that floor
×`CALL_VAD_MULTIPLIER` clamped at both ends, the floor keeps drifting with the room
but freezes while fig is talking so bleed can't be calibrated in, and an utterance
starts on a windowed majority (80% of the last `CALL_VAD_SUSTAINED_MS`) rather than
a consecutive run. `CALL_VAD_DEBUG=1` prints floor / rms / trigger / window per
frame — that's the tool for tuning a bad call instead of guessing at constants.

Junk is rejected by CONTENT, not by duration. `CALL_VAD_MIN_SPEECH_MS` is 200 — under
the 240ms the start window already implies — so a short greeting reaches whisper, and
what throws out noise is whisper having to return words plus the phantom blocklist.
Every rejection names itself in the log ("too short to be a turn … never reached
whisper" from the VAD, "whisper found no words" / "invented one of its silence
phrases" / "runaway whisper loop" from the turn), so a silent call can be read off
its own log. The case that shaped it: 48s, zero turns, and both of a caller's 280-300ms
"hello?"s dead on a 450ms duration bar that had never sampled a greeting.

Calibration measures the SOURCE, not the clock: the window opens on the first frame
tapout actually delivers, and a window is rejected and remeasured rather than locked
when what it measured would put the trigger at the ceiling — a bar their voice can't
clear. A window cut short by playback keeps the sensitive default instead of
measuring a floor off a fragment.

The mouth's render callback is watched in WALL CLOCK (`MOUTH_STALL_MS`), and a stream
restart has to prove the callback moved before it may claim it worked.

External seams:

- stdin control lines: `hold` (heartbeat), `go`, `abort [reason]`, and `drain`
- stdout markers: the exact lines `READY` and `DRAINED` (parsed by the lane)
- newline-delimited JSON to the per-call fig-runtime Unix socket
- newline-delimited JSON to the Whisper and Kokoro Python workers
- raw PCM16/mono/24k from the `tapout` CoreAudio process-tap helper

`cpal` owns playback in-process. Capture deliberately remains in `tapout`: cpal
can open hardware input devices but cannot create the macOS 14.2+ system process
tap required to hear FaceTime while excluding this child's own output process.
The child passes its PID to `tapout`, retaining structural no-self-echo.

The mouth is selected by device name because cpal does not expose CoreAudio UIDs.
The default is `BlackHole Inject 2ch`; override it with
`CALL_INJECT_DEVICE_NAME`. Selection fails loudly and never falls back to the
system default.

Build and test:

```sh
npm run build:call-rust
npm run test:call-rust
```

Run the local bench against it:

```sh
npx tsx scripts/dev/call-local-bench.ts --fake-brain
```

Ask the mouth directly whether it still renders after sitting idle, with no call in
the loop (`src/bin/mouth-bench.rs` — opens the same pinned device, idles for each N,
plays a tone, and reports render-callback progress per phase):

```sh
cargo run --manifest-path tools/call/child/Cargo.toml --bin mouth-bench -- 5 15 30 45 60
```

The lane spawns `target/release/fig-call-child` (override the path with
`CALL_RUST_CHILD_BIN`).
