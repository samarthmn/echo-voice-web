# Echo Voice local Google Meet runner

This optional Python service joins Google Meet as a visible **Echo Voice - Recording** guest and records meeting playback to local WAV. The host must admit it. It supports **Linux with PulseAudio**; Zoom, Teams, organization-only guest restrictions, macOS and Windows bot capture are not supported.

Full setup, Google Calendar OAuth configuration, privacy details and troubleshooting are in [docs/integrations.md](../docs/integrations.md).

From the repository root, after installing Python 3.10+, FFmpeg, PulseAudio tools and the browser's Linux dependencies:

```bash
python3 -m venv runner/.venv
runner/.venv/bin/pip install -r runner/requirements.txt
runner/.venv/bin/python -m playwright install --with-deps chromium
pulseaudio --start
```

Generate a secret with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Set that same secret as `ECHO_BOT_TOKEN` in the Rust server's `.env` and in the runner's shell:

```bash
export ECHO_BOT_TOKEN='your-generated-secret-at-least-32-characters'
# Optional: use the SAME absolute ECHO_DATA_DIR for server and runner.
# export ECHO_DATA_DIR='/home/your-user/.local/share/echo-voice'
runner/.venv/bin/python runner/meet_runner.py --doctor
runner/.venv/bin/python runner/meet_runner.py
```

The runner does not load `.env` automatically. Run from the repository root to share the default `.echo-data` directory, or explicitly export the identical absolute `ECHO_DATA_DIR` used by the server. There is no separate `ECHO_BOT_DATA_DIR` setting. Shared storage lets meeting deletion remove both imported audio and runner source files.

The service binds `127.0.0.1:8765`, requires the token for every request, and rejects browser-origin access. Keep it private on loopback. In Echo Voice, connect Calendar, select a Google Meet event and confirm participant consent. The app distinguishes joining, waiting for admission and actual recording. Stop the guest in the app and wait for its WAV to finalize before importing and transcribing. Ctrl+C or SIGTERM requests a graceful shutdown.

A single guest runs at a time. The browser UI and runner must remain available to control the recording. Closing Echo Voice's browser tab does not stop the separate runner. An interrupted import can be retried safely: Echo Voice verifies deterministic 64 MB chunks, preserving earlier chunks without duplicating them. The overall WAV import limit is 512 MB.

Run offline checks without joining a meeting:

```bash
python3 tests/integrations_runner_test.py
cargo test -p echo-server integrations::tests
```

Real OAuth, Meet admission and audible recording require your Google project and meeting host. Meet UI changes can require runner maintenance; the runner stops if it cannot verify disabled microphone/camera controls rather than claiming to record.
