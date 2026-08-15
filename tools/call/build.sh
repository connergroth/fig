#!/bin/bash
# Build the call-lane native helpers into tools/call/bin/ (gitignored — the .swift
# sources here are canonical; run this after editing one).
#
#   ax-answer   inbound answer watcher v2 (AX press of the real Answer control)
#   ax-confirm  outbound dial confirm (presses Call/Cancel on the Click-to-Call banner)
#   ax-hangup   ends the live call (AX press of End/Leave; exit 2 = not found)
#   tapout      EARS — CoreAudio process tap → pcm16/mono/24k on stdout
#   injectin    MOUTH — pcm16/mono/24k stdin → BlackHole Inject 2ch (AEC bypass; NEVER
#               point this at plain BlackHole 2ch — the echo canceller erases it)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
for t in ax-answer ax-confirm ax-hangup tapout injectin; do
  echo "building $t…"
  swiftc -O -o "bin/$t" "$t.swift"
done
echo "done — binaries in $(pwd)/bin"
