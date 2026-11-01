---
title: Uninstall
description: Remove Echo, its data, its Keychain entry and the browser extension from your Mac.
---

1. **Keep what you want.** Export a backup (**Settings → Storage → Export library**) or individual meetings. The default data folder, `.echo-data`, is inside the checkout and is deleted with it.
2. **Let pending recordings upload**, or export them from the extension's **Setup → Local recordings & recovery**. Removing the extension deletes recordings it has not uploaded.
3. **Stop the agent** if you installed it: `./scripts/uninstall-service.sh`.
4. **Remove the extension** from `brave://extensions` or `chrome://extensions`.
5. **Delete the checkout** folder. If you set `dataDir` to a folder outside the checkout, delete that too.
6. **Remove the Keychain entry** (optional): open Keychain Access, search for `com.echo.voice.library`, and delete that item. Only do this once you no longer need the library.
7. **Disconnect Google Calendar** (optional): remove Echo from your Google account's third-party connections, and delete the OAuth client in Google Cloud console.

Downloaded Ollama models belong to Ollama; remove them with `ollama rm <model>` if you no longer need them.
