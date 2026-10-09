# Calendar and the browser extension

Google Calendar is optional. You can join meetings normally and record with the [browser extension](browser-extension.md) without connecting a calendar. In a Calendar-enabled release, open Echo's Calendar screen, choose **Connect calendar**, and approve read-only access in your normal browser. Opening a meeting link never starts recording.

Echo stores recordings on your computer. Turbo and speaker models run in the browser; full Large V3 uses the local native speech helper. Notes use local Ollama or optional ChatGPT after explicit consent. Calendar metadata and meeting participation use the meeting service's network connection; Echo does not send audio to a hosted transcription service.

The browser extension records meetings attended in an existing Brave or Chrome tab. It works independently of Calendar and keeps recording when Echo is closed. It never joins as a separate participant. See [installation and recovery](browser-extension.md).

## Installed Echo

The publisher supplies Google sign-in configuration with the application. Everyday users do not create a Google Cloud project, copy a client secret, or edit `.env`. If Calendar is unavailable, ask the publisher for a Calendar-enabled release; recording and the browser extension remain available.

Choose your intended Google account when signing in. Once connected, Echo shows the account email and primary-calendar events from the last hour through the next 30 days, up to 250 occurrences. Events without a meeting URL remain visible. Recognized Meet, Zoom and Teams links provide **Open meeting**.

An unfinished sign-in expires after ten minutes. Return to Calendar and choose **Cancel sign-in** to stop it sooner. Cancellation or a declined grant preserves any existing connection. If you selected the wrong account, cancel before granting access; if sign-in already completed, disconnect and connect the intended account.

The installed flow uses PKCE S256 and a temporary listener on `127.0.0.1` at an available random port. The server keeps the one-time state and verifier in memory and clears them on completion, cancellation, expiry or restart. The callback returns to Echo's existing workspace address; its temporary port does not change your library or browser model cache. This follows Google's [desktop OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

### Publisher configuration

Create a Google Cloud project, enable Google Calendar API, configure the consent screen, and create an OAuth **Desktop app** client. Keep the requested scopes `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`. The Calendar scope allows reading calendars; Echo does not request calendar modification. See Google's [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth).

The installed resources contain an immutable `google-oauth.json` Desktop-client descriptor, covered by the release resource manifest. The checked-in template is unconfigured:

```json
{
  "version": 1,
  "clientType": "desktop",
  "clientId": null
}
```

For a configured release, supply an absolute `ECHO_GOOGLE_OAUTH_CONFIG` path to a private build-input JSON file with this schema and the publisher's Desktop client ID. When Google requires that Desktop client's secret, include an optional `clientSecret` string in the private input. It must contain 1–1024 printable ASCII characters with no whitespace or control characters. Keep the checked-in [`release/google-oauth.json`](../release/google-oauth.json) unconfigured; never commit publisher credentials. Keep the private input in an ignored, access-restricted location. Do not pass its contents through command arguments or paste them into logs.

Packaging copies the validated descriptor into native application resources with private file permissions. Installed users can extract these shared Desktop parameters: they are not an authentication boundary. Google explicitly describes installed-client secrets as embedded parameters that cannot remain confidential; its official client library sends the parameter alongside the PKCE verifier. Echo retains PKCE S256, browser-bound state, the ephemeral loopback callback and encrypted per-user tokens. The secret is sent only in HTTPS POST bodies to Google's fixed token endpoint during code exchange and refresh; it is absent from browser URLs, cookies, status, errors and saved user-token records. See Google's [installed-application overview](https://developers.google.com/identity/protocols/oauth2#installed-applications), [official client-library implementation](https://googleapis.dev/python/google-auth-oauthlib/latest/_modules/google_auth_oauthlib/flow.html#Flow.fetch_token), and [credential handling policy](https://developers.google.com/identity/protocols/oauth2/policies#secure-credentials).

A null or missing descriptor leaves Calendar unavailable. Web clients, user tokens, endpoint overrides and redirect URIs remain disallowed; the strict schema rejects additional fields. The installed application ignores source-mode Google environment variables and `.env` files. Publish a new release to change this configuration. Supplying the real publisher credential and distributing a configured artifact are release-owner actions; synthetic fixtures do not grant that authorization.

Register test users while the Google project is in testing. Complete applicable Google consent and [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) requirements before broader distribution. Publisher configuration and synthetic tests do not qualify a real grant: authorization, refresh, revocation, and return to the installed application still need an approved live-account release check on each supported platform.

## Source builds — developers

Source mode retains web-client configuration for local development. These are developer setup steps, not an installed-user requirement.

1. Create a project in Google Cloud Console and enable **Google Calendar API**.
2. Configure the OAuth consent screen. For a project in testing, add the Google account you will connect as a test user. Request `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`. Google may require application verification for broader distribution; a personal testing project can be used with its registered test users.
3. Create an OAuth **Web application** client with the authorized redirect URI exactly `http://localhost:3000/api/integrations/google/callback`.
4. Put the following in the project root `.env` (never commit it):

   ```dotenv
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

The callback is initialized from `googleRedirectUri` in `echo.config.json`; if you change it, register the identical URI in Google Cloud Console.

5. Restart the Rust server. Open the app using `http://localhost:3000` (use the same hostname as the redirect), then choose **Connect calendar** from the Calendar screen.
6. Authorize read-only Calendar access. Browser/service qualification remains required.

Source authorization also uses one-time state, PKCE and a ten-minute expiry. Its callback uses the configured web redirect URI rather than the installed flow's temporary listener.

## Saved credentials and reconnecting

Tokens never go to frontend JavaScript. The server encrypts `$ECHO_DATA_DIR/credentials/google.json` (default `.echo-data/credentials/google.json`) with the library's protection key; Unix directories and files are restricted to the current account. Tokens record the Google client that issued them. A copied library can reuse its connection only with the same configured client. A legacy token without client identity, a changed release client, or a revoked grant prompts **Reconnect calendar** instead of sending the old refresh token to a different client. Reconnection preserves the saved credential until a new grant succeeds.

Refresh tokens renew expired access tokens. **Disconnect calendar** removes the local credentials; existing recorded meetings remain. To revoke the original Google grant as well, remove Echo Voice from your Google account's third-party connections.

A Google OAuth project in testing may issue refresh tokens that expire after seven days. Reconnect when prompted. A declined grant, invalid redirect, disabled Calendar API, quota response, and offline connection surface as errors; they never produce pretend calendar results.

## Extension connection

Calendar and Settings expose a five-minute connection code, pending installation approval and revocation. The extension credential is bound to this installation/library and cannot retrieve Calendar tokens. Recording can start offline without a connected Calendar. See [privacy and permissions](browser-extension.md#permissions-and-privacy) and [runner migration](extension-migration.md).
