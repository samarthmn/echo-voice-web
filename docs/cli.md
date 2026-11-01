---
title: CLI
description: Command-line options of the echo-server binary and Echo's scripts.
---

## echo-server

`target/release/echo-server` runs the server. With no arguments it reads [configuration](configuration.md) and starts listening.

| Option | What it does |
| --- | --- |
| `--version`, `-V` | Prints the version and exits |
| `--check-library` | Opens the configured library offline, verifies it, and exits. It can migrate an older library, so run it on a copy if you want to keep the original untouched |
| `--recover-library` | Restores the library key from the recovery phrase. Reads `{"phrase": "..."}` as JSON on stdin, verifies the database, writes the key back to the Keychain, and prints `Library recovery completed. Reopen Echo.` See [backups and recovery](backups-and-recovery.md#recovering-a-library) |

Stop the running server before using either option; only one process can hold the library.

## Scripts

| Script | What it does |
| --- | --- |
| `scripts/setup.sh` | Checks prerequisites, installs dependencies and builds everything. `--build-only` skips tool installs |
| `scripts/start.sh` | Runs the release server in the foreground |
| `scripts/doctor.sh` | Checks the Mac, tools, build, running server and library, and prints fixes. See [troubleshooting](troubleshooting.md) |
| `scripts/update.sh` | Pulls the latest version, rebuilds, and restarts the login agent. See [updating](updating.md) |
| `scripts/install-service.sh` | Installs the launchd agent that starts Echo at login. `--dry-run` prints the plist |
| `scripts/uninstall-service.sh` | Removes the launchd agent |
| `scripts/dev.sh` | Development server on `.echo-dev-data` (see [development](development.md)) |
| `scripts/check.sh` | Runs the checks and tests: `--rust`, `--lint`, `--app` or `--all` |

## pnpm scripts

| Script | What it does |
| --- | --- |
| `pnpm build:assets` | Browser bundle, design tokens and asset manifest |
| `pnpm build:extension` | The extension, into `extension/dist` |
| `pnpm package:extension` | A release zip of the extension |
| `pnpm build:brand` | Re-renders the logo and brand images |
| `pnpm build:icons` | Regenerates the Lucide icon module |
| `pnpm test`, `pnpm test:integration`, `pnpm test:e2e` | Unit, integration and browser tests |
