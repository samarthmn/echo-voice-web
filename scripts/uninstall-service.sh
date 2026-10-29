#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
plist="$HOME/Library/LaunchAgents/dev.echo-voice.server.plist"
launchctl bootout "gui/$(id -u)/dev.echo-voice.server" 2>/dev/null || true
rm -f "$plist"
echo 'Echo Voice launch agent removed (or was already absent).'
