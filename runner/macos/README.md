# macOS application audio helper

This command-line helper uses Apple's ScreenCaptureKit on macOS 13 or later.
It captures application playback from **one explicitly supplied Google Chrome
process ID**. It registers only an audio output, requests 16 kHz mono audio, and
writes PCM16 WAV. It never opens a camera or microphone and saves no video.

Build with Xcode Command Line Tools from the repository root:

```sh
sh runner/macos/build.sh
target/native-runner/echo-audio-capture --check
python3 -m unittest discover -s tests -p macos_capture_test.py
```

The runtime binary is `target/native-runner/echo-audio-capture` (Git ignored).
The compiler cache and synthetic test files stay in project `tmp/` and are
removed after building or testing.
The tests use synthetic in-memory audio; they do not capture any application or
request permission. The build script does not launch the helper.

`--check` only calls `CGPreflightScreenCaptureAccess()` and returns one JSON line
with `state: ready | permission_required` and `ready: true | false`. It does not
open a permission prompt or enumerate windows. `ready` describes OS permission,
not a successful live capture. A user must explicitly grant the local runner
Screen & System Audio Recording access in System Settings. The permission may
be attributed to the launching app or terminal; restart the runner afterward.
The helper never requests permission automatically.

The runner starts capture only after confirming the meeting and owned browser:

```text
echo-audio-capture --pid <owned Chrome PID> --output <new absolute .wav path>
```

Integration requirements:

- Supply the main PID of the dedicated browser process launched and owned by
  the runner, never a PID obtained from a general browser search. Only Google
  Chrome's bundle identifier is accepted. A missing process fails closed.
- Use a new `.wav` destination in a runner-owned private (0700) session folder.
  The helper creates a 0600 file with exclusive creation and rejects final-path
  symlinks or replacement of an existing recording.
- Wait for actual PCM data before claiming recording readiness. `capturing`
  means ScreenCaptureKit started; it does not prove audible media has arrived.
- On stop, send SIGTERM and wait for exit before consuming the WAV. SIGINT also
  finalizes it. Forced termination can leave an incomplete header. The supervisor
  should enforce its own bounded startup/shutdown timeouts and reject partial
  files after a forced kill.
- JSON lines on stdout report `capturing`, `stopped`, `permission_required`, or
  `error`. Normal stop exits 0; capture errors exit 1, bad arguments 2, missing
  permission 3. Stopped output includes sample count and duration. No file paths,
  window titles, account details, or raw audio are printed.
- macOS audio filtering is **application-level**, not tab-level. Keep the owned
  browser limited to the meeting. Exact application-PID filtering is used with
  no system-audio fallback. Isolation from other instances of the same browser
  still requires a live two-source qualification test before claiming it.

Apple references:
[ScreenCaptureKit capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos),
[application-level audio filtering](https://developer.apple.com/videos/play/wwdc2022/10155/),
[nonprompting permission preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()).
