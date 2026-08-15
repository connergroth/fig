#!/bin/bash
# Build findmy.dylib — the tier-2 Find My reader that rides the same Messages.app
# injection as the rich-iMessage bridge (see src/transport/inject.ts). Three source
# files, Apple private frameworks only, no socket server.
#
# Output lands in tools/findmy/build/ (gitignored — this is a native artifact, only
# the .m/.h sources are canonical). It is NOT installed automatically: point
# FINDMY_DYLIB at the built file, or copy it to ~/imsg-findmy/, so a bad build can
# never silently replace a working one mid-run.
set -euo pipefail
cd "$(dirname "$0")"
SRC="src"
OUT="build/findmy.dylib"
mkdir -p build

SOURCES=( "$SRC/FindMyRequestSender.m" "$SRC/LocationSpoof.m" "$SRC/FindMyHelper.m" )
SDK="$(xcrun --show-sdk-path)"

echo "==> compiling $OUT (arm64 + arm64e) with clang from $SDK"
xcrun clang \
  -dynamiclib \
  -arch arm64 -arch arm64e \
  -fobjc-arc -fmodules \
  -mmacosx-version-min=11.0 \
  -isysroot "$SDK" \
  -Wno-error=int-conversion -Wno-error=implicit-function-declaration \
  -Wno-deprecated-declarations -Wno-incompatible-pointer-types \
  -Wno-nullability-completeness \
  -DDEBUG=1 \
  -I"$SRC" -I"$SRC/headers" -I"$SRC/headers/SocialAppsCore" \
  -framework Foundation -framework AppKit -framework CoreLocation \
  -F/System/Library/PrivateFrameworks \
  -F"$SDK/System/Library/PrivateFrameworks" \
  -framework IMCore -framework IDS -framework IDSFoundation \
  -framework IMFoundation -framework IMSharedUtilities -framework IMDPersistence \
  -framework FMF \
  -install_name "@rpath/findmy.dylib" \
  -o "$OUT" \
  "${SOURCES[@]}" 2>&1 | tee build/build.log

[ -f "$OUT" ] || { echo "BUILD FAILED — see build/build.log"; exit 1; }

echo "==> adhoc-signing"
codesign --force --sign - --timestamp=none "$OUT"

echo "==> built $(pwd)/$OUT"
file "$OUT"
echo ""
echo "install: point FINDMY_DYLIB at the file above, or copy it into ~/imsg-findmy/."
