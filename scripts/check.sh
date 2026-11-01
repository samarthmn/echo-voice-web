#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
# --all runs every check. CI splits them across --rust, --lint and --app.
# No argument runs Rust, lint and unit tests without builds or browser tests.
mode="${1:-}"
case "$#:$mode" in
  0: | 1:--all | 1:--rust | 1:--lint | 1:--app) ;;
  *) echo 'Usage: ./scripts/check.sh [--all|--rust|--lint|--app]' >&2; exit 1 ;;
esac
passed=()
summary() { printf '\nPassed checks:'; printf ' %s' "${passed[@]}"; printf '\n'; }
trap summary EXIT
run() { local name="$1"; shift; printf '\n==> %s\n' "$name"; "$@"; passed+=("$name"); }
if [[ -z $mode || $mode == --all || $mode == --rust ]]; then
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
if [[ -z $mode || $mode == --all || $mode == --lint ]]; then
  run formatting pnpm format:check
  run eslint pnpm lint
  run stylelint pnpm lint:css
  run markdownlint pnpm lint:md
  for tool in shellcheck actionlint; do
    if command -v "$tool" >/dev/null; then
      case "$tool" in
        shellcheck) run shellcheck shellcheck scripts/*.sh ;;
        actionlint) run actionlint actionlint .github/workflows/*.yml ;;
      esac
    elif [[ -n ${CI+x} ]]; then
      printf '\n==> %s missing (install with: brew install shellcheck actionlint)\n' "$tool" >&2
      exit 1
    else
      printf '\n==> %s skipped (install with: brew install shellcheck actionlint)\n' "$tool"
    fi
  done
  run typecheck pnpm typecheck
  run typecheck-compat pnpm typecheck:compat
  run knip pnpm knip
  run icons-fresh node scripts/build-icons.ts --check
fi
if [[ -z $mode || $mode == --all || $mode == --app ]]; then
  run unit-tests pnpm test
fi
if [[ $mode == --all || $mode == --app ]]; then
  run release-build ./scripts/setup.sh --build-only
  run debug-server-build cargo build --locked -p echo-server
  CHROMIUM_PATH="$(node scripts/browser-path.ts)" || { echo 'Install Chromium with pnpm exec playwright install chromium.' >&2; exit 1; }
  export CHROMIUM_PATH
  run integration-tests pnpm test:integration
  run e2e-tests pnpm test:e2e
fi
