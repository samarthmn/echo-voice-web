#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ $# -eq 0 || ( $# -eq 1 && $1 == --dry-run ) ]] || { echo 'Usage: ./scripts/install-service.sh [--dry-run]' >&2; exit 1; }
[[ -x "$ROOT/target/release/echo-server" ]] || { echo 'Release server missing. Run ./scripts/setup.sh first.' >&2; exit 1; }
node_executable="$(command -v node)" || { echo 'Node.js is required. Run ./scripts/setup.sh.' >&2; exit 1; }
node_dir="$(dirname "$("$node_executable" -p 'require("node:fs").realpathSync(process.execPath)')")"
service_path="$(NODE_DIR="$node_dir" "$node_executable" -e 'process.stdout.write([...new Set([process.env.NODE_DIR, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"))')"
plist="$HOME/Library/LaunchAgents/dev.echo-voice.server.plist"
log="$HOME/Library/Logs/Echo Voice/server.log"
make_plist() {
  ECHO_SERVICE_ROOT="$ROOT" ECHO_SERVICE_LOG="$log" ECHO_SERVICE_PATH="$service_path" "$node_executable" <<'NODE'
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const root = xml(process.env.ECHO_SERVICE_ROOT), log = xml(process.env.ECHO_SERVICE_LOG), servicePath = xml(process.env.ECHO_SERVICE_PATH);
console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.echo-voice.server</string>
<key>ProgramArguments</key><array><string>${root}/target/release/echo-server</string></array>
<key>WorkingDirectory</key><string>${root}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${servicePath}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
</dict></plist>`);
NODE
}
if [[ ${1:-} == --dry-run ]]; then make_plist; exit 0; fi
mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
launchctl bootout "gui/$(id -u)/dev.echo-voice.server" 2>/dev/null || true
make_plist > "$plist"
plutil -lint "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
printf 'Installed dev.echo-voice.server. Log: %s\n' "$log"
launchctl print "gui/$(id -u)/dev.echo-voice.server"
