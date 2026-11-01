#!/usr/bin/env bash
# Check that this Mac can build and run Echo, and print a fix for anything that is off.
# The output contains no secrets, so it is safe to paste into a bug report.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
# shellcheck source=scripts/lib.sh
source "$ROOT/scripts/lib.sh"

failures=0
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n        -> %s\n' "$1" "$2"; }
fail() { printf '  FAIL  %s\n        -> %s\n' "$1" "$2"; failures=$((failures + 1)); }
section() { printf '\n%s\n' "$1"; }

printf 'Echo doctor (%s)\n' "$(git describe --tags --always --dirty 2>/dev/null || echo 'no git')"

section 'This Mac'
if [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]; then ok "Apple Silicon macOS"; else fail "Not an Apple Silicon Mac ($(uname -sm))" 'Echo runs only on Apple Silicon Macs.'; fi
macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [[ "${macos%%.*}" -ge 14 ]]; then ok "macOS $macos"; else fail "macOS $macos" 'Update to macOS 14 or later.'; fi
if xcode-select -p >/dev/null 2>&1; then ok 'Xcode command line tools'; else fail 'Xcode command line tools missing' 'xcode-select --install'; fi

section 'Build tools'
if command -v rustup >/dev/null; then
  ok "$(rustc --version 2>/dev/null || echo rustc)"
  if rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$'; then ok 'Rust wasm32 target'; else fail 'Rust wasm32 target missing' 'rustup target add wasm32-unknown-unknown (or run ./scripts/setup.sh)'; fi
else
  fail 'rustup missing' 'Install Rust from https://rustup.rs'
fi
locked="$(awk '/name = "wasm-bindgen"/{getline; gsub(/"/, "", $3); print $3; exit}' Cargo.lock)"
installed="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [[ -n "$installed" && "$installed" == "$locked" ]]; then ok "wasm-bindgen $installed"; else fail "wasm-bindgen ${installed:-missing} (Cargo.lock wants $locked)" './scripts/setup.sh installs the matching version'; fi
if command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  ok "Node.js $(node --version)"
else
  fail "Node.js $(node --version 2>/dev/null || echo missing)" 'Install Node.js 22.18 or newer (brew install node)'
fi
if command -v pnpm >/dev/null; then ok "pnpm $(pnpm --version)"; else fail 'pnpm missing' 'corepack enable, or brew install pnpm'; fi
if [[ -d node_modules/@huggingface/transformers ]]; then ok 'Node packages installed'; else fail 'Node packages missing' './scripts/setup.sh'; fi

section 'Build outputs'
missing=()
for output in target/release/echo-server public/assets/echo_app.js public/js/asset-manifest.json public/tokens.css extension/dist/manifest.json; do
  [[ -e "$output" ]] || missing+=("$output")
done
if [[ ${#missing[@]} -eq 0 ]]; then ok "Release server, web app and extension built"; else fail "Missing: ${missing[*]}" './scripts/setup.sh'; fi

section 'Running Echo'
url="$(echo_url)" || url='http://localhost:3000'
port="${url##*:}"
health="$(curl -fsS -m 3 "$url/api/health?deep" 2>/dev/null || true)"
if [[ -n "$health" ]]; then
  ok "Echo answers at $url"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions.
  summary="$(node -e '
    const h = JSON.parse(process.argv[1]);
    const gb = typeof h.diskFreeBytes === "number" ? (h.diskFreeBytes / 1e9).toFixed(1) + " GB free" : "disk free unknown";
    console.log(`version ${h.version}, library ${h.library}, Keychain ${h.keychain}, ${gb}, Ollama ${h.ollama}`);
  ' "$health" 2>/dev/null || echo 'unreadable health response')"
  ok "$summary"
  [[ "$health" == *'"ollama":"reachable"'* ]] || warn 'Ollama is not reachable from Echo' 'Optional, for notes: install and start Ollama, then check Models -> Local notes'
elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $port is in use by something that is not Echo" "lsof -nP -iTCP:$port -sTCP:LISTEN, or set ECHO_BIND to another port"
else
  ok "Echo is not running; port $port is free"
  if curl -fsS -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then ok 'Ollama answers on 127.0.0.1:11434'; else warn 'Ollama not running on 127.0.0.1:11434' 'Optional, for notes: https://ollama.com/download'; fi
fi

section 'Library'
data_dir="${ECHO_DATA_DIR:-}"
[[ -z "$data_dir" && -f echo.config.json ]] && data_dir="$(node -e 'const c = require("./echo.config.json"); process.stdout.write(c.dataDir || "")' 2>/dev/null)"
data_dir="${data_dir:-.echo-data}"
[[ "$data_dir" = /* ]] || data_dir="$ROOT/$data_dir"
if [[ -d "$data_dir" ]]; then
  if [[ -w "$data_dir" ]]; then ok "Data folder is writable"; else fail 'Data folder is not writable' "Check the permissions of $data_dir"; fi
  if [[ -f "$data_dir/workspace.sqlite" ]]; then
    if security find-generic-password -s com.echo.voice.library >/dev/null 2>&1; then ok 'Library key found in the Keychain'; else fail 'Library exists but its Keychain key was not found' 'Unlock the login keychain, or recover with the phrase: docs/backups-and-recovery.md'; fi
    if [[ -f "$data_dir/recovery.json" ]]; then ok 'Recovery phrase saved'; else warn 'No recovery phrase saved yet' 'Settings -> Storage -> Protect your library'; fi
  fi
  free_kb="$(df -Pk "$data_dir" | awk 'NR == 2 {print $4}')"
  if [[ "${free_kb:-0}" -ge 5000000 ]]; then ok "$((free_kb / 1000000)) GB free for recordings and models"; else warn "Only $((free_kb / 1000)) MB free" 'Free some disk space; an hour of audio is about 115 MB and models need several GB'; fi
else
  ok 'No library yet; Echo creates it on first start'
fi

printf '\n'
if [[ $failures -eq 0 ]]; then
  echo 'Everything needed to run Echo looks fine.'
else
  echo "$failures problem(s) found. See docs/troubleshooting.md for more help."
  exit 1
fi
