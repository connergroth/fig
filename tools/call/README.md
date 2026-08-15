# tools/call — the FaceTime audio lane (tier 3)

Everything the agent needs to place a FaceTime audio call, talk, listen, and hang
up. Unlike tiers 1 and 2, none of this touches SIP: it drives FaceTime through
the accessibility API and captures audio through a virtual device, both of which
are supported paths.

## What's here

| file | what it does |
| --- | --- |
| `injectin.swift` | plays synthesized speech into the call's input device |
| `tapout.swift` | taps the call's output so the agent hears the other side |
| `ax-answer.swift` | accepts an incoming call via the accessibility API |
| `ax-confirm.swift` | clicks through FaceTime's dial confirmation |
| `ax-hangup.swift` | ends the call |
| `kokoro_worker.py` | local text-to-speech worker (no network) |
| `whisper_worker.py` | local speech-to-text worker (no network) |
| `blackhole.patch` | the audio-driver patch, see below |

`build.sh` compiles the Swift tools into `tools/call/bin/`, which is gitignored.
`src/call/paths.ts` resolves them from there and refuses to run a binary from
outside the tree, so a stray build elsewhere on the machine can't be picked up by
accident.

## The BlackHole patch

Audio capture needs a virtual device. Stock BlackHole gives you one, but macOS
runs echo cancellation across it, so the agent's own voice gets subtracted out of
what it hears and half the conversation disappears.

The fix is a second, distinctly-named device. `blackhole.patch` gives device B its
own UID and display name and leaves device A byte-identical to stock, so the
machine's default input keeps working exactly as before and FaceTime needs no
reconfiguration.

Setup clones upstream and applies the patch. There is no fork to maintain:

```bash
git clone https://github.com/ExistentialAudio/BlackHole ~/blackhole
git -C ~/blackhole apply /path/to/fig/tools/call/blackhole.patch
# then build and install per BlackHole's own instructions
```

`npm run doctor` checks whether the patched device is present and reports tier 3
accordingly. One known edge: it matches the driver by name, so renaming the
device makes the check read as missing even when it works.

## License

BlackHole is GPL-3.0, so `blackhole.patch` is GPL-3.0 as well. It patches a
separate program and is not linked into this one. The Swift and Python files in
this directory are original and fall under the repository's MIT license.
