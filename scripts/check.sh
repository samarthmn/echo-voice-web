#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
# --all runs every check. CI splits them across --rust, --lint and --app.
# No argument runs Rust, lint and unit tests without builds or browser tests.
# --pre-commit runs every lint and type check, without tests or builds; the git
# pre-commit hook (.githooks/pre-commit) runs it, and it must not be bypassed.
mode="${1:-}"
case "$#:$mode" in
  0: | 1:--all | 1:--rust | 1:--lint | 1:--app | 1:--pre-commit) ;;
  *) echo 'Usage: ./scripts/check.sh [--all|--rust|--lint|--app|--pre-commit]' >&2; exit 1 ;;
esac
# In CI and in the pre-commit hook a missing linter is a failure, not a skip.
strict=''
[[ -n ${CI+x} || $mode == --pre-commit ]] && strict=1
passed=()
summary() { printf '\nPassed checks:'; printf ' %s' "${passed[@]}"; printf '\n'; }
trap summary EXIT
run() { local name="$1"; shift; printf '\n==> %s\n' "$name"; "$@"; passed+=("$name"); }
if [[ -z $mode || $mode == --all || $mode == --rust || $mode == --pre-commit ]]; then
  run rust-format cargo fmt --all -- --check
  if command -v dx >/dev/null; then
    run rsx-format dx fmt --check
  else
    printf '\n==> rsx-format skipped (install with: cargo install dioxus-cli --version ^0.7 --locked)\n'
  fi
  run clippy cargo clippy --locked --workspace --all-targets -- -D warnings
  run wasm-clippy cargo clippy --locked -p echo-app --target wasm32-unknown-unknown -- -D warnings
fi
if [[ -z $mode || $mode == --all || $mode == --rust ]]; then
  run rust-tests cargo test --locked --workspace
  if command -v cargo-deny >/dev/null; then
    run cargo-deny cargo deny check
  elif [[ -n ${CI+x} ]]; then
    printf '\n==> cargo-deny missing (install with: brew install cargo-deny)\n' >&2
    exit 1
  else
    printf '\n==> cargo-deny skipped (install with: brew install cargo-deny)\n'
  fi
fi
if [[ -z $mode || $mode == --all || $mode == --lint || $mode == --pre-commit ]]; then
  run formatting pnpm format:check
  # Generates site/.astro types (astro:content), which ESLint and the type checks need.
  run site-types env ASTRO_TELEMETRY_DISABLED=1 pnpm --filter echo-site exec astro sync
  run eslint pnpm lint
  run stylelint pnpm lint:css
  run markdownlint pnpm lint:md
  for tool in shellcheck actionlint; do
    if command -v "$tool" >/dev/null; then
      case "$tool" in
        shellcheck) run shellcheck shellcheck scripts/*.sh .githooks/pre-commit ;;
        actionlint) run actionlint actionlint .github/workflows/*.yml ;;
      esac
    elif [[ -n $strict ]]; then
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
  run version-sync node scripts/version.ts --check
  if [[ $mode == --pre-commit ]]; then
    run site-typecheck env ASTRO_TELEMETRY_DISABLED=1 pnpm --filter echo-site exec astro check
  else
    run site-build pnpm --filter echo-site build
  fi
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
