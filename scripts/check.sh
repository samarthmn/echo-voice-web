#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
# --all runs every check. CI splits the same checks across two parallel jobs:
# --rust (Rust lint and tests) and --app (web checks, builds and browser tests).
mode="${1:-}"
case "$#:$mode" in
  0: | 1:--all | 1:--rust | 1:--app) ;;
  *) echo 'Usage: ./scripts/check.sh [--all|--rust|--app]' >&2; exit 1 ;;
esac
passed=()
summary() { printf '\nPassed checks:'; printf ' %s' "${passed[@]}"; printf '\n'; }
trap summary EXIT
run() { local name="$1"; shift; printf '\n==> %s\n' "$name"; "$@"; passed+=("$name"); }
if [[ $mode != --app ]]; then
  run rust-format cargo fmt --all -- --check
  if command -v dx >/dev/null; then
    run rsx-format dx fmt --check
  else
    printf '\n==> rsx-format skipped (install with: cargo install dioxus-cli --version ^0.7 --locked)\n'
  fi
  run clippy cargo clippy --locked --workspace --all-targets -- -D warnings
  run wasm-clippy cargo clippy --locked -p echo-app --target wasm32-unknown-unknown -- -D warnings
  run rust-tests cargo test --locked --workspace
fi
if [[ $mode != --rust ]]; then
  run formatting pnpm format:check
  run typecheck pnpm typecheck
  run unit-tests pnpm test
fi
if [[ $mode == --all || $mode == --app ]]; then
  run release-build ./scripts/setup.sh --build-only
  run debug-server-build cargo build --locked -p echo-server
  CHROMIUM_PATH="$(node scripts/browser-path.mjs)" || { echo 'Install Chromium with pnpm exec playwright install chromium.' >&2; exit 1; }
  export CHROMIUM_PATH
  run integration-tests pnpm test:integration
  run e2e-tests pnpm test:e2e
fi
