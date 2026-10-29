# Storage and recovery

## Where data lives

Everything is under the data folder: `.echo-data` by default, resolved relative to the repo (`dataDir` in `echo.config.json`, or `ECHO_DATA_DIR`). **Settings → Storage** shows the actual path. The development server uses `.echo-dev-data`.

| Path (inside the data folder)             | Contents                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `workspace.sqlite`                        | Library database (SQLCipher)                                                |
| `audio/`, `extension-pcm/`                | Encrypted audio chunks                                                      |
| `protection.json`                         | Pointer to the Keychain entry (no key material)                             |
| `workspace.lock`                          | Held by the running server; never delete it to get around a running process |
| `recovery.json`                           | Sealed data for the recovery phrase                                         |
| `credentials/`                            | Encrypted Google Calendar tokens                                            |
| `chatgpt/`, `chatgpt-runtime.sparseimage` | ChatGPT helper state                                                        |
| `models/`                                 | Native Large V3 files (not backed up)                                       |

Only one server may use a library at a time.

## Encryption

The database uses SQLCipher and audio files are authenticated-encrypted. The library key is held in the macOS Keychain; it is never written to disk and there is no plaintext fallback. If the key is missing or Keychain is locked, Echo refuses to open the library rather than creating a new key. Exported meeting files (JSON, text, SRT, Markdown, audio) are ordinary readable files.

## Recovery phrase

In **Settings → Storage → Protect your library**, choose **Save recovery phrase**, write down the 24 words, choose **I saved the phrase**, enter the three requested words, and **Confirm recovery phrase**. Echo then shows "Recovery phrase saved". The phrase is shown once and is never stored. It restores the Keychain key and opens encrypted backups on another computer. Backups require it to be saved. A new phrase does not change what older backups need; keep the phrase that belongs to each backup.

## Backup and restore

- **Export:** **Settings → Storage → Export library** downloads an encrypted archive (meetings, audio, versions, settings, vocabulary). The archive is limited to about 180 MB of audio; for a larger library, stop the server and copy the whole data folder.
- **Restore:** only into an empty library and empty vocabulary. Choose **Choose library file** under **Restore library**, enter the **Library recovery phrase** (optional when restoring on the same unlocked library), then **Restore library**. Wrong phrases or damaged archives are rejected before anything is imported.
- Restore does not merge with existing meetings.
- To use a copied data folder instead, stop the server, copy the folder while it is stopped, point `dataDir` or `ECHO_DATA_DIR` at the copy, and start. Never copy a live database. Optionally validate it first with `./target/release/echo-server --check-library` (this can migrate an older library, so run it on the copy).

**Not in backups:** Google and ChatGPT credentials (reconnect afterwards), downloaded models, extension connections (re-pair), and recordings still pending in the browser extension.

## Recovering a library

If Keychain is merely locked, unlock the login keychain, allow the prompt, and restart. If the Keychain key is truly gone, stop the server, make sure `echo.config.json` or `ECHO_DATA_DIR` points at the library, and run:

```bash
python3 - <<'PYTHON'
import getpass, json, subprocess
phrase = getpass.getpass("Library recovery phrase (hidden): ")
subprocess.run(["./target/release/echo-server", "--recover-library"],
               input=json.dumps({"phrase": phrase}), text=True, check=True)
PYTHON
```

The phrase is read from stdin as JSON (`{"phrase": "..."}`). On success it prints "Library recovery completed. Reopen Echo." and restores the key to Keychain after verifying the database. Without the key or the phrase the data cannot be recovered; keep the original folder untouched.
