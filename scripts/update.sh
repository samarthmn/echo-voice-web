#!/usr/bin/env bash
# Update Echo from Git, rebuild, and restart the login agent if it is installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'This checkout has local changes. Commit or stash them, then run update.sh again.' >&2
  exit 1
fi
cat <<'NOTE'
Before updating, let the extension finish uploading any recordings, and export
a backup (Settings -> Storage -> Export library). See docs/updating.md.
NOTE
before="$(git rev-parse --short HEAD)"
git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [[ "$before" == "$after" ]]; then
  echo "Already up to date ($after)."
else
  echo "Updated $before -> $after."
fi
./scripts/setup.sh
agent="gui/$(id -u)/dev.echo-voice.server"
if launchctl print "$agent" >/dev/null 2>&1; then
  launchctl kickstart -k "$agent"
  echo 'Restarted the Echo login agent. If macOS asks, allow the new echo-server to use the Keychain.'
else
  echo 'Restart Echo to use the new version: stop start.sh (Ctrl+C) and run ./scripts/start.sh again.'
fi
echo 'If the extension changed, reload it at brave://extensions or chrome://extensions.'
