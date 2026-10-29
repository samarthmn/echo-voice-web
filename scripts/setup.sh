#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib.sh
source "$ROOT/scripts/lib.sh"
mkdir -p "$ROOT/tmp"
export TMPDIR="$ROOT/tmp"
[[ $# -eq 0 || ( $# -eq 1 && $1 == --build-only ) ]] || { echo 'Usage: ./scripts/setup.sh [--build-only]' >&2; exit 1; }
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Echo requires Apple Silicon macOS.' >&2; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo 'Install Xcode command line tools: xcode-select --install' >&2; exit 1; }
command -v rustup >/dev/null || { echo 'Install Rust with rustup: https://rustup.rs' >&2; exit 1; }
command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo 'Install Node.js 22 or newer.' >&2; exit 1; }
command -v pnpm >/dev/null || { echo 'Install pnpm: corepack enable or brew install pnpm' >&2; exit 1; }
if [[ ${1:-} != --build-only ]]; then
  rustup target add wasm32-unknown-unknown || { echo 'Could not install Rust wasm target; check rustup.' >&2; exit 1; }
  pnpm install --frozen-lockfile || { echo 'Dependency install failed; check pnpm and network access.' >&2; exit 1; }
  helper="$ROOT/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
  if [[ ! -x "$helper" ]] || [[ "$("$helper" --version 2>/dev/null || true)" != 'codex-cli 0.160.0' ]]; then
    echo 'Warning: Codex 0.160.0 helper unavailable; ChatGPT notes will be unavailable.' >&2
  fi
  bindgen_version="$(awk '/name = "wasm-bindgen"/{getline; gsub(/"/, "", $3); print $3; exit}' Cargo.lock)"
  if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen_version" ]]; then
    cargo install wasm-bindgen-cli --version "$bindgen_version" --locked || { echo 'Could not install wasm-bindgen-cli; check Rust and network access.' >&2; exit 1; }
  fi
fi
pnpm build:assets || { echo 'Asset build failed; run pnpm install and retry.' >&2; exit 1; }
pnpm build:extension || { echo 'Extension build failed; run pnpm install and retry.' >&2; exit 1; }
cargo build --locked --release -p echo-app --target wasm32-unknown-unknown || { echo 'Web app build failed; check the Rust wasm target.' >&2; exit 1; }
wasm-bindgen --target web --out-dir public/assets --out-name echo_app target/wasm32-unknown-unknown/release/echo-app.wasm || { echo 'wasm-bindgen failed; rerun setup without --build-only.' >&2; exit 1; }
node scripts/asset-manifest.mjs || { echo 'Asset manifest generation failed.' >&2; exit 1; }
cargo build --locked --release -p echo-server || { echo 'Server build failed; check Rust and Xcode tools.' >&2; exit 1; }
url="$(echo_url)"
printf '\nEcho is ready. Run ./scripts/start.sh and open %s\nLoad the unpacked browser extension from extension/dist.\n' "$url"
