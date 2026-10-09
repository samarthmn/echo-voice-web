# Calendar and the browser extension

Google Calendar is optional. You can join meetings normally and record with the [browser extension](browser-extension.md) without connecting a calendar. In a Calendar-enabled release, open Echo's Calendar screen, choose **Connect calendar**, and approve read-only access in your normal browser. Opening a meeting link never starts recording.

Echo stores recordings on your computer. Turbo and speaker models run in the browser; full Large V3 uses the local native speech helper. Notes use local Ollama or optional ChatGPT after explicit consent. Calendar metadata and meeting participation use the meeting service's network connection; Echo does not send audio to a hosted transcription service.

The browser extension records meetings attended in an existing Brave or Chrome tab. It works independently of Calendar and keeps recording when Echo is closed. It never joins as a separate participant. See [installation and recovery](browser-extension.md).

## Connect Calendar

When the local server has Google OAuth configured, open **Calendar → Connect calendar** and choose your intended Google account in the normal browser. Echo shows the connected email and primary-calendar events from the last hour through the next 30 days, up to 250 occurrences. Recognized Meet, Zoom and Teams links offer **Open meeting**; this never starts recording.

An unfinished sign-in expires after ten minutes. **Cancel sign-in** stops it sooner and preserves an existing connection. Authorization uses PKCE S256, one-time browser-bound state and the configured same-origin web callback. State and verifiers remain in server memory and are cleared on completion, cancellation, expiry or restart.

## Configure the local server

Calendar is optional. These one-time configuration steps are for the person setting up the local server; recording and the extension work without them.

1. Create a project in Google Cloud Console and enable **Google Calendar API**.
2. Configure the OAuth consent screen. For a project in testing, add the account you will connect as a test user. Request `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`. Echo requests read-only Calendar access, not event modification.
3. Create an OAuth **Web application** client with the authorized redirect URI exactly `http://localhost:3000/api/integrations/google/callback`.
4. Put the following in the project root `.env`, keeping the real values private and outside version control:

   ```dotenv
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

5. The callback comes from `googleRedirectUri` in `echo.config.json`. If you change it, register the identical URI in Google Cloud Console and open Echo using that hostname and port.
6. Restart the server, open Echo, choose **Connect calendar** and approve read-only access.

Configuration and synthetic tests do not qualify a real grant. Authorization, refresh, revocation and return to the workspace need live browser evidence. Project live tests must use **sublimeinnovationtechnologies@gmail.com only**, with camera access blocked. Broader distribution requires the applicable Google consent and scope verification; see [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) and [verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

## Saved credentials and reconnecting

Tokens never go to frontend JavaScript. The server encrypts `$ECHO_DATA_DIR/credentials/google.json` (default `.echo-data/credentials/google.json`) with the library's protection key; Unix directories and files are restricted to the current account. Tokens record the Google client that issued them. Credentials with a saved client identity are reused only with the same configured client. A different client or revoked grant prompts **Reconnect calendar**. For compatibility with older source libraries, legacy credentials without a saved client identity remain usable; a successful refresh binds them to the currently configured Web client. If you change a legacy library's Google client, reconnect it explicitly. Reconnection preserves the saved credential until a new grant succeeds.

Refresh tokens renew expired access tokens. **Disconnect calendar** removes the local credentials; existing recorded meetings remain. To revoke the original Google grant as well, remove Echo Voice from your Google account's third-party connections.

A Google OAuth project in testing may issue refresh tokens that expire after seven days. Reconnect when prompted. A declined grant, invalid redirect, disabled Calendar API, quota response, and offline connection surface as errors; they never produce pretend calendar results.

## Extension connection

In extension Setup, choose **Connect to Echo** and approve the request once in Echo. Setup finishes automatically. Codes and custom loopback addresses remain under **Advanced connection settings**; Settings and Calendar also let you review or revoke installations. The extension credential is bound to this installation/library and cannot retrieve Calendar tokens. Recording can start offline without a connected Calendar. See [privacy and permissions](browser-extension.md#permissions-and-privacy) and [runner migration](extension-migration.md).
