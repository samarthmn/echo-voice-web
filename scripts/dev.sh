#!/usr/bin/env bash
# Debug builds accept an isolated test key only when ECHO_TEST_MODE=1 and
# ECHO_TEST_STORAGE_KEY is set. Normal development uses the OS library key;
# its separate data directory keeps the real library untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
pnpm build:assets
cargo build --locked -p echo-app --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir public/assets --out-name echo_app target/wasm32-unknown-unknown/debug/echo-app.wasm
node scripts/asset-manifest.mjs
export ECHO_BIND=127.0.0.1:3100 ECHO_DATA_DIR="$ROOT/.echo-dev-data"
printf 'Development server: http://localhost:3100 (data: %s)\n' "$ECHO_DATA_DIR"
exec cargo run --locked -p echo-server
