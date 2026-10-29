#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
[[ $# -eq 0 || ( $# -eq 1 && $1 == --all ) ]] || { echo 'Usage: ./scripts/check.sh [--all]' >&2; exit 1; }
passed=()
summary() { printf '\nPassed checks:'; printf ' %s' "${passed[@]}"; printf '\n'; }
trap summary EXIT
run() { local name="$1"; shift; printf '\n==> %s\n' "$name"; "$@"; passed+=("$name"); }
run rust-format cargo fmt --all -- --check
run clippy cargo clippy --locked --workspace --all-targets -- -D warnings
run wasm-clippy cargo clippy --locked -p echo-app --target wasm32-unknown-unknown -- -D warnings
run rust-tests cargo test --locked --workspace
run formatting pnpm format:check
run unit-tests pnpm test
if [[ ${1:-} == --all ]]; then
  run release-build ./scripts/setup.sh --build-only
  run debug-server-build cargo build --locked -p echo-server
  CHROMIUM_PATH="$(node scripts/browser-path.mjs)" || { echo 'Install Chromium with pnpm exec playwright install chromium.' >&2; exit 1; }
  export CHROMIUM_PATH
  run integration-tests pnpm test:integration
  run e2e-tests pnpm test:e2e
fi
