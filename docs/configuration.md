---
title: Configuration
description: Every Echo setting in echo.config.json and the environment, including the port, bind address and data folder.
---

Echo reads `echo.config.json` from the checkout, then applies environment overrides. Edit the file and restart Echo for changes to apply.

## echo.config.json

```json
{
  "bind": "127.0.0.1:3000",
  "dataDir": ".echo-data"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `bind` | `127.0.0.1:3000` | IP and port to listen on. It must be a loopback IP, such as `127.0.0.1:3000` or `[::1]:3000`; Echo refuses to start on any other interface |
| `dataDir` | `.echo-data` | The library folder. A relative path resolves against the checkout |
| `googleRedirectUri` | derived from `bind` | Optional. Overrides the Google OAuth redirect URI; see [calendar](calendar.md) |

Unknown keys are ignored with a warning in the log.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ECHO_BIND` | Overrides `bind`. The scripts read it too |
| `ECHO_DATA_DIR` | Overrides `dataDir` |
| `ECHO_CONFIG_FILE` | Read this file instead of `echo.config.json` |
| `ECHO_RESOURCE_ROOT` | The folder that contains `public/`. Normally found automatically from the binary's location or the checkout |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your Google OAuth client, for [calendar](calendar.md) |
| `RUST_LOG` | Log level for the server, for example `RUST_LOG=debug` |

`.env` in the checkout is loaded at start. Keep only the Google client there; copy `.env.example` to begin.

## Changing the port

Set `bind` (or `ECHO_BIND`) to another loopback port, for example `127.0.0.1:3100`, and restart. Then:

- The extension finds Echo automatically only on ports 3000 to 3005. On another port, open Echo in the browser once (it announces itself to the extension), or enter the address under **Advanced** on the extension's Setup page.
- Whisper Turbo is cached per browser origin, so a new port downloads it again.
- Update the Google redirect URI if you use [calendar](calendar.md).

## The data folder

Everything Echo stores is in the data folder: the encrypted database, audio, settings and downloaded Large V3 files. **Settings → Storage** shows its path. Only one Echo server can use a data folder at a time. The development server (`scripts/dev.sh`) uses `.echo-dev-data`, so it never touches your real library.

See [backups and recovery](backups-and-recovery.md) for what is inside and how to move it.
