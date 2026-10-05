# Calendar and the local meeting runner

Echo Voice's Dioxus interface opens in your browser. The Rust/Axum server stores the meeting library on your computer. Turbo and speaker models run in the browser; full Large V3 uses the local native speech helper. Optional notes models run in a local provider. Connecting Google Calendar adds an external account connection for calendar metadata. Joining Google Meet connects to Google's meeting service. Recording and AI processing do not use a hosted recording provider.

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

## Optional local Google Meet runner

The runner runs directly on **macOS and Linux** with installed Google Chrome and a private saved browser profile. Docker is not included. Follow [native setup](../runner/README.md) for prerequisites and startup.

On macOS, playback capture uses the application-specific ScreenCaptureKit helper and requires explicit Screen & System Audio Recording permission. Linux uses a private PulseAudio sink, also available through PipeWire's PulseAudio compatibility service, and FFmpeg. Both platforms require a desktop session for direct Google sign-in. Camera and microphone remain denied.

The runner joins only after you choose an event and confirm participant consent. Meet displays the signed-in Google account's identity. Host admission and Google organization policies still apply. Zoom, Teams, unattended scheduled joining and a native Windows runner are not implemented.

Run the server and helper with the same config and library. The config initializes `dataDir`, `runner.url` and admission timeout. Native sign-in and meetings use a visible dedicated browser regardless of the legacy headless setting. Both processes share a random secret in `<dataDir>/credentials/runner-token` with private Unix permissions. The runner binds only the configured `127.0.0.1` port and rejects browser-origin callers. The Rust server sends authenticated requests directly without proxies or redirects.

## Runner browser sign-in

After connecting Calendar and starting the runner, use **Sign in to runner** on the Calendar page. Echo opens a dedicated native Chrome window. Sign in to Google yourself using the displayed Calendar account, complete any Google verification, then choose **Save session**. Echo accepts the session only when it can verify the active Meet account matches Calendar. The runner also rechecks that identity immediately before each join.

The session lives in the library’s private credentials directory, survives runner restarts on that computer, and is excluded from library backups. **Sign out of runner** removes this dedicated saved session; Calendar access is managed separately. Reconnect after Google expires the session. Switching Calendar accounts does not grant the old runner session access to the new account.

The login browser and recording cannot run simultaneously. Echo exposes Save and Cancel controls through its authenticated loopback API. Native Google login happens directly in the browser window; credentials and login screenshots are not sent through the Echo interface. Camera and microphone remain denied. The user completes passwords, passkeys, two-factor verification and CAPTCHAs; Google can refuse automated browsers, and Echo does not bypass those restrictions.

## Recording behavior

1. Connect Calendar, sign into the runner using the same account, select a Google Meet event, acknowledge participant consent, and start the local recording participant.
2. The guest denies camera and microphone permission before navigating to Meet. It never opens real or fake capture devices, and refuses to request entry unless both browser permission states are denied. Blocked devices may have different pre-join labels; it never clicks a control to enable them. The dedicated local profile retains the session after the user signs in. The runner checks its active account before joining; expired or mismatched sessions require reconnecting.
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
| `GET /api/integrations/runner/auth` | Saved runner account and current login state |
| `POST /api/integrations/runner/auth` | Open a dedicated login session for the connected Calendar account |
| `POST /api/integrations/runner/auth/finish` | Verify and save the current runner session |
| `POST /api/integrations/runner/auth/cancel` | Close the matching interactive login session |
| `DELETE /api/integrations/runner/auth` | Remove the dedicated saved runner profile while idle |
| `POST /api/integrations/bot` | Start a guest with `{meetingId,url,consent:true}` |
| `GET /api/integrations/bot?meetingId=...` | Read real joining/waiting/recording/completed/failed state |
| `DELETE /api/integrations/bot?meetingId=...` | Request the guest stop and finalize its audio |
| `GET /api/integrations/bot/audio?meetingId=...` | Download a completed local WAV |
| `POST /api/integrations/bot/import?meetingId=...` | Idempotently import a completed WAV into its saved meeting |

The Python runner exposes authenticated `/auth` login operations, `/health`, `/sessions`, `/sessions/:id`, and `/sessions/:id/audio` routes. Only Echo Voice's server should call them.

## Verification and limits

Rust unit tests exercise OAuth state expiry/tampering, URL and ID validation, event extraction and cookie matching. Python standard-library tests exercise token enforcement, browser-origin rejection, mandatory consent and restart recovery without making a real meeting connection:

```bash
cargo test -p echo-server integrations::tests
python3 tests/integrations_runner_test.py
```

A real Google OAuth authorization, Google Meet admission, and audible capture must be validated with the user's Google project, network, operating system and meeting host. They cannot be simulated into a claim of production compatibility. Google's meeting UI can change; failures to locate or verify pre-join controls stop the bot safely and require runner maintenance. For local microphone recording or imported audio, no Calendar connection or bot is required.

## Live meeting qualification

The [Ubuntu qualification guide](ubuntu-native-runner-test.md) provides installation commands, an isolated test library, live checks and cleanup steps.

Native macOS and Linux need separate live qualification: saved Google session verification and reuse, meeting admission, audible playback capture, stop/finalization, import and transcription. macOS also needs a two-source audio test to prove exclusion of unrelated browser playback. These checks remain pending; offline lifecycle tests and earlier results from the removed container do not qualify native capture.

Google may reject a browser or meeting entry even with a saved session. The runner fails closed on unverifiable identity, permission or capture state. It does not bypass Google security checks. Use local recording or upload when Meet declines entry.
