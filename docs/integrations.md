# Integrations

## Speech models

Pick models under **Models → Speech models**. The default for new meetings is set in **Settings → General → Default speech model**. For an existing meeting use **Details → Processing choices → Speech recognition**, then **Save choices**. Download the model first.

| Model                            | Runs                                                                             | Size                                     |
| -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| Whisper Large V3 Turbo (default) | In the browser, via transformers.js in a web worker                              | about 1.2 GB (speech and speaker models) |
| Whisper Large V3                 | Natively in a Node.js process supervised by the server, using `onnxruntime-node` | about 1.7 GB                             |

Downloads need internet once; after that everything is local.

- **Turbo** is cached in the browser (Cache Storage) per origin, so changing the port or hostname re-downloads it. Keep an Echo tab open while it transcribes.
- **Large V3** needs Node.js 22+ and the packages from `pnpm install` (`setup.sh` installs them). **Check engine** on the model card verifies this. The download is the pinned q8 export `Xenova/whisper-large-v3` (the saved model id stays `onnx-community/whisper-large-v3`). Files and a readiness marker live under `<dataDir>/models/native-large-v3/`. They are not part of library backups. Removing the model in **Models** deletes that folder.
- Only one native job runs at a time. The browser decodes audio to 16 kHz mono and uploads it; the server keeps it in an encrypted per-job spool under the repo's `tmp/` with the key passed to the helper over stdin, and removes it when the job ends. Abandoned jobs are cleaned up at the next start.

Review transcripts yourself: you can edit passages, rename speakers, and return to earlier versions.

## Speaker grouping

Speaker labels come from PyAnnote segmentation (`onnx-community/pyannote-segmentation-3.0`) and WavLM speaker embeddings (`Xenova/wavlm-base-plus-sv`), run in the browser alongside transcription. Grouping is approximate, especially with short or overlapping speech. Speaker models are cached with the browser profile and are not removed when you remove Large V3.

## Notes

Notes are generated from a completed transcript on the meeting's **Notes** tab (**Generate meeting notes**). Choose the default provider in **Settings → General → Default notes provider**: **Ollama · Local** or **ChatGPT · Optional cloud**. Providers never fall back to each other automatically.

### Local notes (Ollama)

Install and start [Ollama](https://ollama.com/download). In **Models → Local notes**, **Check connection**, pick a model and **Download selected**. The default model is `qwen2.5:3b`; the default URL is `http://127.0.0.1:11434`. Only loopback URLs are accepted. The address is editable under **Settings → General → Local notes connection** (shown while Ollama is the provider).

### ChatGPT notes

Uses your ChatGPT plan's Codex allowance through the official Codex CLI, pinned to **0.160.0** (the `@openai/codex` package installed by `pnpm install`). No OpenAI API key is used.

What is sent: for each request you confirm, the **entire selected transcript version, including speaker labels**, plus the note-writing instructions. Selecting passages does not narrow it. Audio is never sent. Generated notes are saved in the meeting with provider and model.

Setup:

1. **Models → ChatGPT → Sign in with ChatGPT** and finish the OpenAI sign-in in the browser. Echo does not reuse another Codex login; a separate `codex login` has no effect.
2. Optionally pick a model (otherwise the account default).
3. Choose **ChatGPT · Optional cloud** as the default provider.

**Disconnect ChatGPT** signs out; saved notes remain.

The helper is found in this order: `ECHO_CODEX_BIN`, `codexBinary` in `echo.config.json`, `tools/codex/codex`, `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, then `codex` on `PATH`. If `ECHO_CODEX_BIN` or `codexBinary` is set but points at a missing file, Echo reports the helper as missing instead of continuing the search. A helper whose version is not 0.160.0 is rejected. The helper's account credential and temporary files live in an encrypted sparse disk image (`chatgpt-runtime.sparseimage` in the data folder) that is mounted while in use. If protected storage is unavailable the connection fails rather than writing plaintext. Credentials are not included in backups; sign in again after restoring.

## Google Calendar

Optional and read-only (scopes `openid`, `email`, `calendar.readonly`). It lists primary-calendar events and offers **Open meeting** for Meet, Zoom and Teams links; it never starts a recording.

1. In Google Cloud Console, enable the Google Calendar API and configure the consent screen (add yourself as a test user while in testing).
2. Create an OAuth client of type **Web application**. Add the redirect URI `http://localhost:<port>/api/integrations/google/callback`, where `<port>` is the port of `bind` (or `ECHO_BIND`), for example `http://localhost:3000/api/integrations/google/callback`. To use another URI, set `googleRedirectUri` in `echo.config.json` and register that exact value.
3. Put the credentials in the repo's `.env` (see `.env.example`):

   ```dotenv
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

4. Restart the server, open **Calendar**, and choose **Connect calendar**. Use **Reconnect calendar** if the grant is revoked or the client changed, and **Disconnect calendar** to remove the local tokens.

Tokens stay on the server, encrypted with the library key, in `<dataDir>/credentials/`. The sign-in uses PKCE and expires after ten minutes. A Google project left in testing mode can issue refresh tokens that expire after seven days; reconnect when asked. To revoke the grant on Google's side, remove Echo from your Google account's third-party connections.
