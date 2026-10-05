# Echo Voice local Google Meet runner

This optional Python service joins Google Meet as a signed-in participant using the connected Calendar account and records meeting playback to local WAV. The host must admit it. Run it in **Docker on macOS, Windows, or Linux**, or directly on Linux with PulseAudio. Zoom and Teams are not supported. Google account, organization and host policies still apply.

Full setup, Google Calendar OAuth configuration, privacy details and troubleshooting are in [docs/integrations.md](../docs/integrations.md).

## Docker setup (macOS, Windows and Linux)

Install Docker Desktop on macOS/Windows, or Docker Engine with Compose on Linux. Start Docker, then run from the repository root. Keep the Echo Voice server running on the host. The container contains its own Chromium, PulseAudio and FFmpeg; it needs no host microphone, screen recording permission or audio device. Its dedicated browser uses a saved Google session created through Echo’s runner sign-in dialog. The participant appears under that Google account’s identity; camera and microphone remain denied.

On macOS/Linux, match the host user's file ownership before building:

```bash
export ECHO_RUNNER_UID="$(id -u)"
export ECHO_RUNNER_GID="$(id -g)"
mkdir -p .echo-data
docker compose -f compose.runner.yaml up --build -d
docker compose -f compose.runner.yaml ps
```

On Windows PowerShell with Docker Desktop's Linux containers:

```powershell
New-Item -ItemType Directory -Force .echo-data | Out-Null
docker compose -f compose.runner.yaml up --build -d
docker compose -f compose.runner.yaml ps
```

The default mounts `./.echo-data` at `/data` and `./echo.config.json` read-only in the container. **Mount the same library and config used by the host server.** For a custom `dataDir`, `ECHO_DATA_DIR`, or `ECHO_CONFIG_FILE`, set `ECHO_RUNNER_DATA_DIR` and `ECHO_RUNNER_CONFIG_FILE` to those host paths before running Compose (PowerShell: `$env:ECHO_RUNNER_DATA_DIR = "C:\path\to\library"`). Create the data directory first. Relative mount paths resolve from this repository's Compose file; absolute paths work too. If `runner.url` uses a different loopback port, set `ECHO_RUNNER_PORT` to that same host port; the internal port stays 8765.

Both processes read or atomically create the same private `<dataDir>/credentials/runner-token`. The server downloads finalized WAV over authenticated HTTP, so `/data` need not equal the host's absolute path. Sharing storage also lets meeting deletion remove both recording copies. Do not mount a different library just to bypass a permission error; check host UID/GID and Docker Desktop file sharing, then rebuild with the matching UID/GID. On Windows, keep the library in a Docker Desktop shared folder with access restricted to your account.

The only published port is `127.0.0.1:8765`. All audio routing stays in the container. Startup first verifies actual audible Chromium playback through a temporary private sink and PCM WAV. It starts the recording service only when that test passes. The health check also verifies Python, Chromium and PulseAudio prerequisites; a running process alone does not mean capture is ready. Inspect or stop it with:

```bash
docker compose -f compose.runner.yaml logs meeting-runner
docker compose -f compose.runner.yaml exec meeting-runner python3 /app/meet_runner.py --doctor
docker compose -f compose.runner.yaml exec meeting-runner python3 /app/audio_smoke.py
docker compose -f compose.runner.yaml down
```

The smoke test records a generated tone from its own temporary Chromium process, verifies denied camera/microphone permissions and audible PCM WAV samples, then removes its test files and private sink. It does not join a meeting. Stop a real recording in Echo and wait for completion before shutting down Docker; container shutdown also requests graceful finalization. Recreating the container preserves the bind-mounted library, credentials and WAVs. The image download requires internet and several GB of disk space. Google Meet admission and playback still require a live host test on each target setup; Docker does not bypass guest or organization policies.

## Native Linux setup

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

The service binds `127.0.0.1:8765`, requires the token for every request, and rejects browser-origin access. Keep it private on loopback. In Echo Voice, connect Calendar, choose **Sign in to runner**, sign into the same Google account yourself, and choose **Save session**. Then select a Google Meet event and confirm participant consent. Login uses a headed Chromium window (Docker supplies a private virtual display); native Linux needs a working display. The private profile is stored with the library credentials and survives container recreation. Sign out through Echo to remove it. The runner rechecks the active account before joining and fails closed on mismatch or expiration. The app distinguishes joining, waiting for admission and actual recording. Stop the guest in the app and wait for its WAV to finalize before importing and transcribing. Ctrl+C or SIGTERM requests a graceful shutdown.

A start carries a unique request ID. Retrying that ID returns its session; cancellation persists a fence so a delayed request cannot restart it. Echo saves pending start intent before requesting entry and cancels an ambiguous acceptance. If cancellation is offline, the intent survives a restart, deletion is blocked, and Stop bot remains available. Echo retries cancellation every five seconds while the runner returns.

A single guest runs at a time. The browser UI and runner must remain available to control the recording. Closing Echo Voice's browser tab does not stop the separate runner. An interrupted import can be retried safely: Echo Voice verifies deterministic 64 MB chunks, preserving earlier chunks without duplicating them. The overall WAV import limit is 512 MB.

Run offline checks without joining a meeting:

```bash
python3 tests/integrations_runner_test.py
python3 -B tests/runner_auth_test.py
cargo test -p echo-server integrations::tests
```

To verify the real Chromium login transport and profile persistence against synthetic pages inside a running container:

```bash
docker compose -f compose.runner.yaml exec -T meeting-runner python3 - < tests/runner_auth_browser_smoke.py
```

This isolated check blocks external requests and removes its own temporary profile. It verifies input, screenshots, persistent cookies, account mismatch rejection, cancellation, profile locking and denied capture permissions. It does not authenticate with Google or qualify live meeting admission.

Real OAuth, Meet admission and audible recording require your Google project and meeting host. Meet UI changes can require runner maintenance. The receive-only prejoin flow handles explicit Continue/Use/Join without microphone/camera prompts and stops if denied camera/microphone permissions cannot be verified. Each guest stores private `join-diagnostics.json` with its last prejoin/admission phase, sanitized visible button names, known status phrases and visible error messages. It never reads or saves browser cookies, credentials or page URLs in that diagnostic. Review it when a guest cannot request entry; links, meeting codes and email addresses in control labels are redacted.

## Live meeting qualification

The Docker runner has passed receive-only browser playback and WAV capture checks on macOS with an ARM64 Docker container: camera and microphone permission remain denied while an isolated generated tone reaches the recording. This verifies the local capture pipeline.

A real Google Meet test returned “You can't join this video call” before guest-name entry or an admission request, including with the test meeting temporarily allowing Open access. Google did not expose a more specific reason. Successful live Meet recording is therefore not qualified on that setup; Docker portability does not guarantee that Google accepts the dedicated anonymous browser. The saved-session flow now allows manual sign-in through Echo’s local UI and retains that dedicated profile. It never copies the user’s everyday browser cookies, signs in automatically, or enables camera/microphone capture. Signed-in admission still requires a real qualification test. Use local recording or upload an existing recording when Meet declines the guest.
