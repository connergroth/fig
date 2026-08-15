#!/bin/zsh
# launchd wrapper. launchd hands a process a bare PATH and no working directory, so
# both are set here rather than assumed. The cwd is this script's own directory, so
# the repo can live anywhere without editing the plist.
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin
cd "${0:A:h}" || exit 1
exec node_modules/.bin/tsx src/index.ts
