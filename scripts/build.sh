#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo 'Install the stable Rust toolchain from https://rustup.rs, then run this script again.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Node.js 22 or newer is required to bundle the local browser models.' >&2; exit 1; }
rustup target add wasm32-unknown-unknown
npm ci --ignore-scripts
npm run build:assets
npm run build:extension
bindgen_version="$(awk '/name = "wasm-bindgen"/{getline; gsub(/"/, "", $3); print $3; exit}' Cargo.lock)"
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen_version" ]]; then
  cargo install wasm-bindgen-cli --version "$bindgen_version" --locked
fi
cargo build --locked --release -p echo-app --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir public/assets --out-name echo_app target/wasm32-unknown-unknown/release/echo-app.wasm
node scripts/asset-manifest.mjs
cargo build --locked --release -p echo-server
printf '\nEcho Voice is built. Run ./scripts/start.sh and open http://localhost:3000\n'
