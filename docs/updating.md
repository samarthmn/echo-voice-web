---
title: Updating
description: Update Echo to a newer version safely, without losing recordings.
---

Echo updates from Git. A newer server migrates your library forward on first start; it never downgrades a migrated library, and it refuses to open a library written by a newer version.

## Before you update

1. Finish any recording, and let the extension upload what it has pending (its popup shows when everything is saved).
2. Export a backup: **Settings → Storage → Export library**. See [backups and recovery](backups-and-recovery.md).

## Update

The quickest way is the update script. It refuses to run over local changes, pulls with `--ff-only`, rebuilds with `setup.sh`, and restarts the login agent if you installed it:

```bash
./scripts/update.sh
```

If you use `start.sh`, restart it afterwards. To update by hand instead:

1. Stop Echo: Ctrl+C in the `start.sh` Terminal, or `./scripts/uninstall-service.sh` if it runs at login.
2. Pull and rebuild:

   ```bash
   git pull
   ./scripts/setup.sh
   ```

3. Start Echo again (`./scripts/start.sh`, or `./scripts/install-service.sh`).
4. If the extension changed, `setup.sh` has already rebuilt it. Reload it on `brave://extensions` or `chrome://extensions`. Reloading keeps its data and connection.

Read the [changelog](https://github.com/samarthmn/echo-voice-web/releases) for anything that needs your attention before updating.

## Going back

To return to an older version, check out the older tag and rebuild, then restore the backup you exported before updating. An older server cannot open a library that a newer one has migrated.
