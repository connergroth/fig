# tools/findmy — the Find My reader dylib (tier 2)

A small dylib that reads a friend's live Find My location from inside Messages.app.
It's the tier-2 lane: it rides the *same* injection the rich-iMessage bridge already
needs (`DYLD_INSERT_LIBRARIES` into Messages.app, SIP off), so it costs no extra
setup step beyond tier 1 — it's a second passenger on that injection, not a second
install.

## What it is

Three source files, Apple private frameworks only, no socket server:

- `src/FindMyRequestSender.m` — the read itself. Sends the Find My "Request Location"
  balloon, then refreshes and reads the friend-location cache off `FMLSession` /
  `IMFMFSession`. This is the reverse-engineered part.
- `src/LocationSpoof.m` — swizzles `-[CLLocationManager location]` so the host Mac
  reports a fixed placeholder coordinate (Apple Park) rather than its real position.
- `src/FindMyHelper.m` — the `__attribute__((constructor))` entry point and the
  ~2s watcher: writes a heartbeat, consumes a trigger JSON, writes the result JSON.

`src/headers/` is a dump of the Apple private-API headers those files compile
against (IMCore, FMF, IDS, …). They're Apple interface declarations, not
implementation.

## The file contract with the host

The watcher talks to the TypeScript side purely through files in the Messages
sandbox tmp dir. These names must stay in sync with the host readers:

| file | written / read by | host reader |
| --- | --- | --- |
| `findmy-heartbeat.txt` | dylib writes ~every 2s | `src/transport/inject.ts` |
| `findmy-trigger.json` | host writes, dylib consumes | `src/location/bridge.ts` |
| `findmy-location.json` | dylib writes the location result | `src/location/bridge.ts` |

## Build

```
tools/findmy/build.sh
```

Output goes to `tools/findmy/build/findmy.dylib` (gitignored). It is **not**
installed automatically — point `FINDMY_DYLIB` at it, or copy it to
`~/imsg-findmy/findmy.dylib`, so a fresh build can never silently replace a working one
mid-run. `npm run doctor` reports whether the dylib is where the harness expects it.

## Provenance & license

This work started inside a fork of the BlueBubbles helper
(https://github.com/BlueBubblesApp/bluebubbles-server-helper, Apache-2.0), so it
carries that project's license and attribution. What is actually retained from
upstream, checked file by file against a fresh clone:

| | |
| --- | --- |
| `src/headers/` (66 files, ~4,800 lines) | upstream's. 65 are byte-identical to the BlueBubbles tree, and `Logging.h` is the same two-macro file with the log subsystem renamed. These are dumped Apple private-API interface declarations, not implementation. |
| `src/*.m` (3 files, ~1,200 lines) | original. Upstream has no `FindMy*.m` and no `LocationSpoof.m` at all. The Find My read, the CoreLocation swizzle, and the constructor and watcher entry point were written here. |
| `build.sh` | original. Upstream builds through Xcode or its own script, and the two have no lines in common. |

The header dump is the real dependency, and it's why the Apache notice stays.
The socket server, the network controller, the message-sending helpers, and
everything else BlueBubbles-specific are gone.
