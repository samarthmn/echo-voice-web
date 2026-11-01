# Security policy

Echo is self-hosted software that keeps meeting recordings on your own Mac. Security reports are very welcome.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, the steps to reproduce it, the Echo version or commit, and the impact you expect. You can expect an acknowledgement within a week. Fixes are released as soon as practical, and reporters are credited unless they prefer otherwise.

## Scope

In scope:

- the Echo server (`server/`), web app (`app/`, `web/`) and browser extension (`extension/`);
- anything that lets a website, another machine, or another local user read or change an Echo library, recording, transcript, note or credential;
- weaknesses in the library encryption, recovery phrase, backups or extension pairing.

Out of scope:

- attacks that need your unlocked Mac session or malware running as your user (see the [security model](docs/security-model.md#what-echo-does-not-protect-against));
- vulnerabilities in third-party software such as Ollama, browsers or macOS, unless Echo makes them worse;
- the project website, unless it affects users of the app.

## Supported versions

Security fixes go into the latest release. Update to it before reporting, if you can.
