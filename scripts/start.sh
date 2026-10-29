#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib.sh
source "$ROOT/scripts/lib.sh"
for output in target/release/echo-server public/assets/echo_app.js public/js/asset-manifest.json public/wasm extension/dist/manifest.json; do
  [[ -e "$output" ]] || { echo 'Build outputs missing. Run ./scripts/setup.sh first.' >&2; exit 1; }
done
[[ -x target/release/echo-server ]] || { echo 'Server is not executable. Run ./scripts/setup.sh.' >&2; exit 1; }
url="$(echo_url)"
port="${url##*:}"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
  echo "Port $port is in use. Stop the process above or set ECHO_BIND to another port." >&2
  exit 1
fi
printf 'Echo is available at %s\nPress Ctrl+C to stop.\n' "$url"
exec "$ROOT/target/release/echo-server"
