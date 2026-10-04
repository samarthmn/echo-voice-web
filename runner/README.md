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

Run both processes from the repository root using the same `echo.config.json`. Its `dataDir` and `runner.url` initialize shared storage and the runner's loopback port. Both processes automatically generate or read the private credential in `<dataDir>/credentials/runner-token`; no token or URL environment variable is needed.

```bash
runner/.venv/bin/python runner/meet_runner.py --doctor
runner/.venv/bin/python runner/meet_runner.py
```

The runner does not need `.env`. That file holds only optional Google Calendar credentials for the Rust server. When isolating development tests, use the same `ECHO_CONFIG_FILE` and `ECHO_DATA_DIR` overrides for both processes. Shared storage lets deletion remove imported audio and runner source files.

The service binds `127.0.0.1:8765`, requires the token for every request, and rejects browser-origin access. Keep it private on loopback. In Echo Voice, connect Calendar, select a Google Meet event and confirm participant consent. The app distinguishes joining, waiting for admission and actual recording. Stop the guest in the app and wait for its WAV to finalize before importing and transcribing. Ctrl+C or SIGTERM requests a graceful shutdown.

A start carries a unique request ID. Retrying that ID returns its session; cancellation persists a fence so a delayed request cannot restart it. Echo saves pending start intent before requesting entry and cancels an ambiguous acceptance. If cancellation is offline, the intent survives a restart, deletion is blocked, and Stop bot remains available. Echo retries cancellation every five seconds while the runner returns.

A single guest runs at a time. The browser UI and runner must remain available to control the recording. Closing Echo Voice's browser tab does not stop the separate runner. An interrupted import can be retried safely: Echo Voice verifies deterministic 64 MB chunks, preserving earlier chunks without duplicating them. The overall WAV import limit is 512 MB.

Run offline checks without joining a meeting:

```bash
python3 tests/integrations_runner_test.py
cargo test -p echo-server integrations::tests
```

Real OAuth, Meet admission and audible recording require your Google project and meeting host. Meet UI changes can require runner maintenance; the runner stops if it cannot verify disabled microphone/camera controls rather than claiming to record.
