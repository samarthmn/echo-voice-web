#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x target/release/echo-server || ! -f public/assets/echo_app.js ]]; then
  echo 'Build Echo first with ./scripts/build.sh' >&2
  exit 1
fi
printf 'Opening your local workspace at http://localhost:3000\nKeep this terminal open while using Echo. Press Ctrl+C to stop.\n'
exec target/release/echo-server
