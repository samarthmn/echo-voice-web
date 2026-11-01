---
title: Google Calendar
description: Connect Google Calendar read-only to see upcoming meetings in Echo, using your own Google OAuth client.
---

Calendar is optional. When connected, Echo lists events from your primary Google Calendar and offers **Open meeting** for Google Meet, Zoom and Teams links. It is read-only (scopes `openid`, `email` and `calendar.readonly`) and never starts a recording by itself.

Echo has no shared Google app: you create your own OAuth client, so the grant is between your Google account and your own Mac.

## Create a Google OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (for example "Echo").
2. **APIs & Services → Library**: enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and your email, and add the scopes `openid`, `.../auth/userinfo.email` and `.../auth/calendar.readonly`.
4. While the app is in **Testing**, add your own Google account under **Test users**.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
6. Under **Authorized redirect URIs** add `http://localhost:3000/api/integrations/google/callback`. Use the port Echo listens on (`bind` or `ECHO_BIND`). To use another URI, set `googleRedirectUri` in `echo.config.json` and register that exact value.
7. Copy the client ID and secret.

## Give Echo the credentials

Copy `.env.example` to `.env` in the checkout and fill in:

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Restart Echo, open **Calendar** and choose **Connect calendar**.

## Day to day

- **Reconnect calendar** if the grant is revoked or you change the client.
- **Disconnect calendar** removes the tokens from your Mac.
- A project left in **Testing** issues refresh tokens that expire after seven days, so Echo asks you to reconnect weekly. Publishing the app (it can stay unverified for your own account) avoids that.

## Where the tokens live

Tokens stay on the server, encrypted with the library key, in `<dataDir>/credentials/`. Sign-in uses PKCE and an attempt expires after ten minutes. To revoke the grant on Google's side, remove Echo from your Google account's third-party connections. Calendar tokens are not included in backups; reconnect after a restore.
