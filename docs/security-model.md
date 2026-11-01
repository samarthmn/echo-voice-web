---
title: Security model
description: How Echo protects your recordings on your Mac, what it defends against, and what it does not.
---

Echo is built for one person on one Mac. Its job is to keep meeting recordings on that Mac and out of reach of websites, other machines on the network, and anyone who copies the data folder without your Keychain or recovery phrase.

## The server listens only on loopback

The server refuses to start on any address that isn't loopback (`127.0.0.1` or `::1`), so nothing else on your network can reach it. On top of that:

- **DNS rebinding:** every request must carry a loopback `Host` header. Page requests on `127.0.0.1` are redirected to `localhost`.
- **Cross-site requests:** the workspace API (`/api`) accepts only same-origin requests from Echo's own pages. A website you visit cannot call it.
- **Responses** carry `Cache-Control: no-store` for API data, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`).

## The library is encrypted at rest

- The database is SQLCipher. Audio chunks are encrypted and authenticated individually.
- The library key lives in the **macOS Keychain**, never on disk. There is no plaintext fallback: if the key is missing or the Keychain is locked, Echo refuses to open the library rather than creating a new one.
- The **recovery phrase** (24 words) can restore the key. Echo shows it once and never stores it.
- Exported backups are encrypted and need the recovery phrase to restore elsewhere.
- Google Calendar tokens are encrypted with the library key.

## The extension is paired, not trusted by default

- The extension talks only to `/extension/v1`, which accepts a loopback `Host` and a `chrome-extension://` origin.
- Pairing needs your approval in Echo (and a click in the extension's Setup page for an Echo-started request). Requests expire after 10 minutes.
- Each credential is bound to the extension origin that paired, is stored on the server only as a hash, and can only upload recordings. It cannot read your library, settings or calendar.
- While recordings wait to upload, the extension encrypts them in IndexedDB with a non-extractable device key.

The full protocol is in the [HTTP API reference](http-api.md#extension-api-extensionv1).

## Speech and notes stay local

- Whisper runs in your browser tab or in a Node process the server starts on your Mac.
- Notes go only to Ollama at a loopback address; other URLs are rejected.
- Echo has no telemetry and no update checks. See [privacy](privacy.md) for every request it can make.

## What Echo does not protect against

- **Someone using your unlocked Mac.** With your session unlocked, they can open Echo, and the Keychain will hand the key to `echo-server`.
- **Malware running as your user.** It can read what you can read, including the browser profile that holds pending extension recordings.
- **Exports you make.** Meeting exports (Markdown, text, SRT, JSON, audio) and WAV exports from the extension are ordinary unencrypted files.
- **Other software on your Mac reaching loopback.** Local programs can connect to `localhost:3000`. The API rejects requests without Echo's own origin, but Echo is not a sandbox against local software.
- **Ollama and model downloads.** Once installed, Ollama is its own program with its own network behaviour; model files come from Hugging Face and the Ollama registry over HTTPS.
- **Losing both the Keychain key and the recovery phrase.** Then the library cannot be decrypted by anyone, including you.

## Reporting a vulnerability

Please report security issues privately, as described in the repository's [security policy](../SECURITY.md).
