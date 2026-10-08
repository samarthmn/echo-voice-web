# Calendar and the browser extension

Echo Voice's Dioxus interface opens in your browser. The Rust/Axum server stores the meeting library on your computer. Turbo and speaker models run in the browser; full Large V3 uses the local native speech helper. Optional notes models run in a local provider. Connecting Google Calendar adds an external account connection for calendar metadata. Joining Google Meet connects to Google's meeting service. Recording and AI processing do not use a hosted recording provider.

The browser extension records meetings attended in an existing Brave or Chrome tab. It works independently of Calendar and keeps recording when Echo is closed. It never joins as a separate participant. See [installation and recovery](browser-extension.md).
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
6. Authorize read-only Calendar access. The app shows primary-calendar events from the last hour through the next 30 days, up to 250 occurrences. Events without a meeting URL remain visible. Recognized Meet, Zoom and Teams links provide Open meeting; opening a link never starts capture. Browser/service qualification remains required.

The OAuth flow checks a ten-minute, HttpOnly, SameSite=Lax state cookie and uses PKCE. Tokens never go to frontend JavaScript. The server writes them to `$ECHO_DATA_DIR/credentials/google.json` (default `.echo-data/credentials/google.json`), with a `0700` directory and `0600` file on Unix. Windows users should restrict the data directory to their account using filesystem permissions. Refresh tokens renew expired access tokens. Disconnect removes the local credentials; existing recorded meetings remain. To revoke the original Google grant as well, remove Echo Voice from your Google account's third-party connections.

A Google OAuth project in testing may issue refresh tokens that expire after seven days. Reconnect when prompted. A declined grant, invalid redirect, disabled Calendar API, quota response, and offline connection surface as errors; they never produce pretend calendar results.


## Extension connection

Calendar and Settings expose a five-minute connection code, pending installation approval and revocation. The extension credential is bound to this installation/library and cannot retrieve Calendar tokens. Recording can start offline without a connected Calendar. See [privacy and permissions](browser-extension.md#permissions-and-privacy) and [runner migration](extension-migration.md).
