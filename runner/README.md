# Echo Voice native Google Meet runner

The optional local runner joins Google Meet using a saved browser session for the connected Calendar account and records meeting playback to WAV. It runs directly on macOS or Linux. Docker is not part of the runtime or installation. The runner still uses a dedicated Google Chrome process; host admission and Google account policies apply. Zoom, Teams and Windows runner support are not implemented.

## Native macOS setup

Install Google Chrome, Python 3.10 or later, and Xcode Command Line Tools. macOS 13 or later is required for audio capture. From the repository root:

```sh
python3 -m venv runner/.venv
runner/.venv/bin/pip install -r runner/requirements.txt
sh runner/macos/build.sh
sh scripts/start-runner.sh --doctor
sh scripts/start-runner.sh
```

Recording requires explicit Screen & System Audio Recording permission for the helper's launching application in System Settings. Sign-in can work before capture permission is granted. The [audio helper](macos/README.md) selects the owned Chrome process and saves only audio. Camera and microphone remain blocked. Application-audio isolation still requires the live qualification described below.

## Native Linux setup

Use a normal, non-root desktop account with Google Chrome installed, Python 3.10+, FFmpeg and PulseAudio tools. A graphical desktop session is required for direct Google sign-in. On Debian/Ubuntu, install `python3-venv`, `ffmpeg` and `pulseaudio-utils` using the system package manager. Use the desktop's existing PulseAudio service or PipeWire with its PulseAudio compatibility service; do not replace a working PipeWire installation with another audio server. `pactl info` must succeed as your desktop user.

From the repository root:

```sh
python3 -m venv runner/.venv
runner/.venv/bin/pip install -r runner/requirements.txt
sh scripts/start-runner.sh --doctor
sh scripts/start-runner.sh
```

Playback from the owned meeting browser is routed to a private audio sink. FFmpeg records that sink's monitor rather than the microphone or the desktop's default output. The native browser uses the same desktop login and credential storage during sign-in and subsequent meetings. A bare SSH shell without the desktop display and session environment cannot perform interactive sign-in.

## Connect the meeting account

Run the Echo server and runner with the same `echo.config.json` and library directory. Both read or create the same private `<dataDir>/credentials/runner-token`. For an isolated development library, pass the same `ECHO_CONFIG_FILE` and `ECHO_DATA_DIR` overrides to both processes.

1. Connect Google Calendar in Echo.
2. Select **Sign in to runner**. A separate, normal Chrome window opens with the runner's private profile.
3. Sign into the connected Calendar account directly in Google. Return to Echo and select **Save session**.
4. Echo closes only its owned browser window and verifies that the saved session matches Calendar.
5. Choose an event and confirm participant consent before joining. Stop the guest and wait for the WAV to finalize, then select **Save recording**.

The profile is stored in `<dataDir>/credentials/meet-native-profile`, excluded from backups and Git. It stays on that computer and is reused across meetings. Do not copy an everyday browser profile or share it across operating systems. Login and recording acquire an exclusive lock; only one can use the profile at a time. **Sign out of runner** removes this dedicated session while idle. Calendar authorization is separate. Google may require sign-in again after expiry or a security check.

The native flow has no embedded credential form or remote login viewer. Passwords, passkeys and verification codes are entered directly into Google Chrome. Chrome sync and password saving are disabled in this profile. The runner checks the active account before every join and rejects mismatch or expiration.

## Runtime and controls

The runner listens only on `127.0.0.1`, requires its secret for requests and rejects browser-origin callers. No bot token or runner URL is needed in `.env`. Keep the helper running for the duration of the meeting. Closing Echo's browser tab does not stop the separate runner. Ctrl+C or SIGTERM requests graceful recording finalization.

A start carries a unique request ID. Retrying that ID returns its session; cancellation persists a fence so a delayed request cannot restart it. Echo saves pending start intent before requesting entry and cancels an ambiguous acceptance. If cancellation is offline, the intent survives a restart, deletion is blocked, and Stop bot remains available. Echo retries cancellation every five seconds while the runner returns.

A single guest runs at a time. The browser UI and runner must remain available to control the recording. Closing Echo Voice's browser tab does not stop the separate runner. An interrupted import can be retried safely: Echo Voice verifies deterministic 64 MB chunks, preserving earlier chunks without duplicating them. The overall WAV import limit is 512 MB.

## Verification

For the full Ubuntu checklist and results template, use [Ubuntu native runner qualification](../docs/ubuntu-native-runner-test.md).

Offline lifecycle tests do not contact Google:

```sh
python3 -B tests/integrations_runner_test.py
python3 -B tests/native_auth_test.py
python3 -B tests/runner_auth_test.py
cargo test -p echo-server integrations::tests
```

After installing native prerequisites, run the synthetic audio check as your desktop user:

```sh
runner/.venv/bin/python -B tests/native_auth_browser_smoke.py --run
runner/.venv/bin/python -B runner/audio_smoke.py
```

The browser check validates synthetic cookie persistence and account mismatch rejection without Google login. The audio check launches an owned native browser with an isolated scratch profile, plays a generated tone, verifies denied camera/microphone permissions and checks audible PCM samples. It removes its own temporary files and audio sink. It does not authenticate Google. On macOS it requires already-granted recording permission and never opens a permission prompt.

Each target system still needs a real sign-in → Save session → restart → meeting admission → audio capture → import test. macOS additionally needs a two-source test proving unrelated browser playback is excluded. Automated lifecycle tests and synthetic tones do not establish live Google compatibility. Current native live qualification is pending; historical tests of the removed container are not evidence for these native paths.

When Meet rejects entry, the runner stores a private `join-diagnostics.json` with the last phase, sanitized visible controls and known errors. It excludes browser cookies, credentials and page URLs. Meet UI changes can require runner maintenance. Use local microphone recording or upload when a meeting cannot be joined.

See [Google Calendar setup and API details](../docs/integrations.md).
