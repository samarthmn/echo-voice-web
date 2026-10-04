# Calendar and the local meeting guest

Echo Voice's Dioxus interface opens in your browser. The Rust/Axum server stores the meeting library on your computer. Optional speech models run in the browser; optional notes models run in a local provider. Connecting Google Calendar adds an external account connection for calendar metadata. Joining Google Meet connects to Google's meeting service. Recording and AI processing do not use a hosted recording provider.

A browser tab cannot independently join a meeting as another participant or keep a headless meeting browser recording after the tab closes. The optional runner below supplies that local capability. It requires one-time local runtime setup. There is no Chrome extension, hosted recording bot, or silent cloud fallback.

## Google Calendar connection

1. Create a project in Google Cloud Console and enable **Google Calendar API**.
2. Configure the OAuth consent screen. For a project in testing, add the Google account you will connect as a test user. Request `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`. Google may require application verification for broader distribution; a personal testing project can be used with its registered test users.
3. Create an OAuth **Web application** client with the authorized redirect URI exactly `http://localhost:3000/api/integrations/google/callback`.
4. Put the following in the project root `.env` (never commit it):

   ```dotenv
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

The callback is initialized from `googleRedirectUri` in `echo.config.json`; if you change it, register the identical URI in Google Cloud Console.

5. Restart the Rust server. Open the app using `http://localhost:3000` (use the same hostname as the redirect), then choose **Connect Google Calendar** from the Calendar screen.
6. Authorize read-only Calendar access. The app shows primary-calendar events from the last hour through the next 30 days, up to 250 occurrences. Events without a meeting URL remain visible. Zoom and Teams URLs are identified for context but cannot be recorded by this runner.

The OAuth flow checks a ten-minute, HttpOnly, SameSite=Lax state cookie and uses PKCE. Tokens never go to frontend JavaScript. The server writes them to `$ECHO_DATA_DIR/credentials/google.json` (default `.echo-data/credentials/google.json`), with a `0700` directory and `0600` file on Unix. Windows users should restrict the data directory to their account using filesystem permissions. Refresh tokens renew expired access tokens. Disconnect removes the local credentials; existing recorded meetings remain. To revoke the original Google grant as well, remove Echo Voice from your Google account's third-party connections.

A Google OAuth project in testing may issue refresh tokens that expire after seven days. Reconnect when prompted. A declined grant, invalid redirect, disabled Calendar API, quota response, and offline connection surface as errors; they never produce pretend calendar results.

## Optional local Google Meet runner (Linux)

The runner currently supports **Linux with PulseAudio and guest-accessible Google Meet meetings**. macOS/Windows bot capture, Zoom, Teams, organization-only meetings, and unattended scheduled joining are not qualified or implemented. The runner joins only after you choose an event and confirm participant consent. It is a visible guest named **Echo Voice - Recording**; the host must admit it when Meet requires admission.

Use a normal, non-root Linux desktop account. Install Python 3.10+, FFmpeg, PulseAudio tools, and Playwright's Chromium dependencies. On Debian/Ubuntu, an administrator can install prerequisites with:

```bash
sudo apt-get install python3 python3-venv ffmpeg pulseaudio pulseaudio-utils
python3 -m venv runner/.venv
runner/.venv/bin/pip install -r runner/requirements.txt
runner/.venv/bin/python -m playwright install --with-deps chromium
pulseaudio --start
```

The `--with-deps` installation may request administrator access for operating-system packages. Run the recorder itself as your normal user. PipeWire systems need the PulseAudio compatibility service and working `pactl info`.

Run from the project root with the same `echo.config.json` as the Rust server:

```bash
runner/.venv/bin/python runner/meet_runner.py --doctor
runner/.venv/bin/python runner/meet_runner.py
```

The config initializes `dataDir`, `runner.url`, headless mode, and admission timeout. The runner and server automatically share a random secret in `<dataDir>/credentials/runner-token` with private Unix permissions. No bot token or runner URL is needed in `.env`. The runner binds the configured `127.0.0.1` port and rejects browser-origin callers; the Rust server sends authenticated requests directly without proxies or redirects.

## Recording behavior

1. Connect Calendar, select a Google Meet event, acknowledge participant consent, and start the local recording guest.
2. The guest starts with a fake silent microphone and camera, disables both in Meet's pre-join controls, and refuses to request entry if it cannot verify they are off. It does not capture the local computer's microphone or camera. No Google login cookies are stored or automated.
3. While the host admits it, the status is **Waiting**, and no meeting audio is recorded. Admission times out after five minutes. Organization restrictions, rejection, invalid links, missing Chromium, or changed Meet controls produce a failed status.
4. Once admitted, Chromium's playback routes to a private PulseAudio sink, separate from the user's general desktop output. FFmpeg saves that sink's monitor as mono, 16 kHz PCM WAV. Playwright's default mute-audio flag is explicitly disabled. The status becomes **Recording** only after the capture process is running.
5. Stop the guest from Echo Voice. It leaves the call, finalizes the WAV header, and offers completed audio for import. Import saves the track into the meeting library as `meeting-bot` in deterministic 64 MB chunks. Retrying a partially completed import verifies existing chunk hashes and resumes safely; importing twice cannot duplicate it. Then use the meeting's local transcription workflow.

The runner retains its source WAV under `$ECHO_DATA_DIR/bot/<meeting-id>/meeting.wav`, plus a small state file and FFmpeg error log. An app-managed copy is stored with the meeting after import. Both copies are local. After the bot has stopped, deleting a meeting removes its library recording and the runner source directory under the shared data folder. Keep the app and runner on the same `ECHO_DATA_DIR` so deletion covers both managed copies. Exports, recordings in a separately configured runner data folder, and external backups remain separate copies.

Recording starts have a durable unique ID. A lost response or failure to finalize start state triggers cancellation of that exact attempt. The runner persists cancellation before acknowledging it, so a delayed start cannot join later. If the runner cannot be reached, Echo reports that recording may still be active, preserves pending intent, blocks meeting deletion, and retries cancellation after restart or every five seconds. **Stop bot** also reconciles pending starts.

One guest can run at a time. It stops on low disk space (less than 100 MB), capture failure, meeting departure, user stop, or the eight-hour maximum. The app can import WAVs up to 512 MB (approximately 4.6 hours at this format); use shorter sessions or recover larger source files manually. Completed audio is preserved if transcription fails. A runner restart marks an active saved session interrupted rather than claiming that it is still recording. Abrupt operating-system termination can leave an unfinished WAV requiring external repair; the original remains on disk.

The browser interface and Rust server must stay available to issue Stop and import. The runner process itself must remain running throughout the call. Closing Echo Voice's browser tab does not stop the separate bot; reopen the same meeting to stop it, or press Ctrl+C in the runner terminal for a graceful shutdown.

## REST endpoints

All routes below are on the local Rust server. The server's loopback Host and same-origin protections apply. OAuth callback navigation is the sole narrow cross-site exception; its state cookie is required.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/integrations/status` | Calendar configuration/connection and runner availability; no credentials |
| `GET /api/integrations/google/connect` | Begin Google OAuth |
| `GET /api/integrations/google/callback` | Verify state, exchange code and store private credentials |
| `POST /api/integrations/google/disconnect` | Delete local Google credentials |
| `GET /api/integrations/calendar` | Upcoming primary-calendar event summaries and known meeting URLs |
| `POST /api/integrations/bot` | Start a guest with `{meetingId,url,consent:true}` |
| `GET /api/integrations/bot?meetingId=...` | Read real joining/waiting/recording/completed/failed state |
| `DELETE /api/integrations/bot?meetingId=...` | Request the guest stop and finalize its audio |
| `GET /api/integrations/bot/audio?meetingId=...` | Download a completed local WAV |
| `POST /api/integrations/bot/import?meetingId=...` | Idempotently import a completed WAV into its saved meeting |

The Python runner exposes authenticated `/health`, `/sessions`, `/sessions/:id`, and `/sessions/:id/audio` routes. Only Echo Voice's server should call them.

## Verification and limits

Rust unit tests exercise OAuth state expiry/tampering, URL and ID validation, event extraction and cookie matching. Python standard-library tests exercise token enforcement, browser-origin rejection, mandatory consent and restart recovery without making a real meeting connection:

```bash
cargo test -p echo-server integrations::tests
python3 tests/integrations_runner_test.py
```

A real Google OAuth authorization, Google Meet admission, and audible capture must be validated with the user's Google project, network, operating system and meeting host. They cannot be simulated into a claim of production compatibility. Google's meeting UI can change; failures to locate or verify pre-join controls stop the bot safely and require runner maintenance. For local microphone recording or imported audio, no Calendar connection or bot is required.
