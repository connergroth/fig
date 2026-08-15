#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release
echo "call session child: $(pwd)/target/release/fig-call-child"
