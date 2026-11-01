---
title: Start at login
description: Run Echo automatically when you log in, as a macOS launchd agent.
---

Instead of keeping `./scripts/start.sh` open in Terminal, you can install Echo as a launchd agent that starts when you log in.

```bash
./scripts/setup.sh                      # build first
./scripts/install-service.sh            # install and start the agent
./scripts/install-service.sh --dry-run  # print the plist without installing
./scripts/uninstall-service.sh          # stop and remove it
```

## What gets installed

| | |
| --- | --- |
| Agent label | `dev.echo-voice.server` |
| Plist | `~/Library/LaunchAgents/dev.echo-voice.server.plist` |
| Program | `target/release/echo-server` in your checkout |
| Log | `~/Library/Logs/Echo Voice/server.log` |
| Restart policy | Restarted if it exits with an error |

`install-service.sh` records your current Node.js folder in the agent's `PATH`, so Whisper Large V3 can find Node. Run it again after you change Node versions.

## After rebuilding

Restart the agent so it runs the new binary:

```bash
launchctl kickstart -k "gui/$(id -u)/dev.echo-voice.server"
```

macOS may ask again to let the new `echo-server` binary use the Keychain. Allow it, or the library stays locked.

## Checking on it

```bash
launchctl print "gui/$(id -u)/dev.echo-voice.server" | head -20
tail -f ~/Library/Logs/Echo\ Voice/server.log
```
