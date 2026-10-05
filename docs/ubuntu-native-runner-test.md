# Ubuntu native meeting runner: setup and qualification

This guide tests Echo's native runner without Docker. Run it from a terminal in your Ubuntu **desktop session**, as your normal user. Use only **sublimeinnovationtechnologies@gmail.com** for Calendar, Google Meet and runner sign-in. Keep camera access denied throughout.

**Status:** awaiting execution on Ubuntu. Automated tests on another operating system do not qualify Ubuntu sign-in, audio routing or live Meet admission. Use a checkout containing the native runner changes; these changes may not yet be on the remote branch.

## 1. Prepare the desktop and project

Use an Ubuntu desktop with installed Google Chrome. Follow [Google's Linux installation instructions](https://support.google.com/chrome/answer/95346) for the official Debian/Ubuntu package. This guide targets a desktop on which that package is supported; ARM Linux and headless servers have not been qualified.

From the repository root, check your environment:

```sh
uname -m
lsb_release -ds
printf 'Desktop: %s; display: %s; Wayland: %s\n' "$XDG_CURRENT_DESKTOP" "$DISPLAY" "$WAYLAND_DISPLAY"
command -v google-chrome-stable || command -v google-chrome
```

Install Python, FFmpeg and the PulseAudio client tools:

```sh
sudo apt-get update
sudo apt-get install python3 python3-venv ffmpeg pulseaudio-utils
pactl info
```

`pactl info` must connect to the desktop audio service. PipeWire with its PulseAudio compatibility service is supported by the capture design. Do not start a second audio server or replace the desktop's working audio service. If `pactl info` fails, resolve that before proceeding.

Build Echo using the [developer guide](development.md#build-and-start), including Rust, Node.js 22+ and the build prerequisites:

```sh
bash scripts/build.sh
```

Create a fresh, isolated test folder. Stop if this folder already exists; reuse it only deliberately to continue the same review.

```sh
mkdir -p tmp
mkdir tmp/ubuntu-runner-qualification
export TMPDIR="$PWD/tmp/ubuntu-runner-qualification"
export ECHO_DATA_DIR="$PWD/tmp/ubuntu-runner-qualification/library"
python3 -m venv runner/.venv
runner/.venv/bin/pip install -r runner/requirements.txt
```

The test library is separate from your normal `.echo-data` library. Do not copy your Mac browser profile, everyday browser profile, Google cookies or saved credentials into it. Authenticate directly on Ubuntu.

## 2. Run prerequisite and synthetic checks

These tests do not sign into Google or join a meeting:

```sh
python3 -B tests/native_auth_test.py
python3 -B tests/integrations_runner_test.py
sh scripts/start-runner.sh --doctor
runner/.venv/bin/python -B tests/native_auth_browser_smoke.py --run
runner/.venv/bin/python -B runner/audio_smoke.py
```

Expected: lifecycle tests pass; doctor reports ready; the native browser check verifies synthetic cookie persistence across reopen, correct process ownership and denied media permissions without signing into Google. The audio check reports `ready: true`, denied camera/microphone permissions and audible mono 16 kHz audio. The tone test creates and cleans up its own browser profile, WAV and private sink. A running browser or nonempty WAV alone is not a pass.

If a check fails, retain its error and stop the live flow until the prerequisite is fixed. Do not use a container to work around a native failure.

## 3. Start Echo and the native runner

Configure Calendar OAuth using the [integration guide](integrations.md#google-calendar-connection). Register `http://localhost:3000/api/integrations/google/callback`; add the approved account as an OAuth test user if required. Enter client credentials into local `.env`, never into a report or Git.

In terminal A, from the repository root:

```sh
export TMPDIR="$PWD/tmp/ubuntu-runner-qualification"
export ECHO_DATA_DIR="$PWD/tmp/ubuntu-runner-qualification/library"
bash scripts/start.sh
```

In terminal B, from the same repository root:

```sh
export TMPDIR="$PWD/tmp/ubuntu-runner-qualification"
export ECHO_DATA_DIR="$PWD/tmp/ubuntu-runner-qualification/library"
sh scripts/start-runner.sh
```

Use the same configuration for both processes. Open `http://localhost:3000` in Brave. Keep both terminals open. Neither process should run as root.

## 4. Verify sign-in and session reuse

1. In Calendar, connect **sublimeinnovationtechnologies@gmail.com** and grant only the displayed read-only Calendar access.
2. Select **Sign in to runner**. Confirm a separate native Chrome window opens, with no embedded login viewer in Echo.
3. Sign into that same account directly in Google's window. Complete any verification yourself. Camera and microphone must remain blocked. If Google blocks sign-in, record the visible error and stop; do not weaken browser security or copy cookies.
4. Return to Echo and select **Save session**. Confirm the account is saved and matches Calendar. The owned login window should close; unrelated browser windows should stay open.
5. Stop only the runner with Ctrl+C, then restart it with the same command and test library. Refresh Echo. Confirm the saved session is still shown.
6. The real reuse check is the meeting join in the next section: the runner must join with the saved account without requiring another login. A saved-account label alone is insufficient proof.

## 5. Test a real meeting and audio isolation

Create a short Google Calendar event using only the approved account, with a Google Meet link and a name such as **Echo Ubuntu native qualification**. Keep ordinary host admission settings. Do not invite unrelated accounts or change organization settings.

1. Open the meeting as the host using the approved account. Keep the host camera off. For a controlled audio source, share a browser tab containing synthetic or public test audio, with tab audio enabled; no microphone is necessary. Confirm the host hears that source.
2. In Echo, select the event, confirm participant consent and start the runner. Admit it if Meet asks. Confirm it appears under the expected account and progresses from joining/waiting to recording. If Meet refuses entry, save the visible error as a failed qualification.
3. Send two or three minutes of the controlled meeting audio. In a separate ordinary browser tab, play a clearly different short sound **without sharing that tab into Meet**. Note its timing. Echo's recording should include the shared meeting audio and exclude the unrelated local sound. Turn off that separate sound afterward.
4. Stop the runner in Echo. Wait for completion. Select **Save recording**, open the saved meeting, play the audio and transcribe it. Confirm expected speech, useful duration and no unrelated sound. Speaker/accuracy improvement is outside this test's scope.
5. Restart Echo and the runner. Confirm the saved meeting and transcript remain available. Join a second short test meeting using the saved Google session; stop and import it successfully.

A pass requires real audible meeting audio, finalization, successful import and saved-session reuse. Silence, a zero-length or unfinished WAV, a stuck recording state, an account mismatch, or unrelated desktop audio in the capture is a failure. A Google admission failure should be reported separately from local audio failure.

## 6. Check cancellation and recovery

- Start sign-in, then choose **Cancel sign-in**. Only the owned login window should close, and another sign-in should work afterward.
- During a test join, choose Stop before recording starts. It must not join later from a delayed request.
- During a recording, stop the runner with Ctrl+C. Restart it and verify there is no false active recording or importable unfinished WAV. A finalized recording may be recovered; a partial one must be reported as failed.
- Open the Calendar page at a narrow mobile-sized window. Save, Cancel and status text must remain usable without horizontal overflow.

## 7. Record results

Copy this table into your review notes. Record the exact commit with `git rev-parse HEAD` and describe any uncommitted changes. Do not include `.env`, tokens, cookies, browser profile files or private meeting links.

| Check | Result / evidence |
| --- | --- |
| Ubuntu version, CPU architecture, desktop/session | |
| Chrome and Python versions | |
| Echo commit and local changes | |
| `pactl info` service: PulseAudio or PipeWire | |
| Offline tests and doctor | |
| Synthetic native tone capture | |
| Google login and Save session | |
| Session reuse after runner restart | |
| Live Meet admission | |
| Meeting playback audible in imported WAV | |
| Unrelated local audio excluded | |
| Stop, finalization and import | |
| Transcript and library survive restart | |
| Cancel/recovery and narrow layout | |
| Overall pass/fail and remaining issues | |

When a failure needs diagnosis, share the visible error and sanitized relevant log excerpts. Runner recordings and private join diagnostics live under the isolated test library. Review them before sharing; never upload the credentials directory.

## 8. Clean up

Stop the test recording and leave the test Meet. Delete only the event you created for this test.

While Echo and the runner are still running, use **Sign out of runner** and **Disconnect Google Calendar** in the isolated test library if you do not want to keep its sessions. To repeat the persistence test later, retain the test library and state that it remains on the machine. Local Calendar disconnect does not revoke Google's original app grant; revoke that separately in the Google account only if desired.

Then close the test-owned Echo/Meet tabs and dedicated runner window; keep unrelated tabs open. Stop both terminal processes with Ctrl+C.

Save the sanitized result report outside scratch storage. When the review is complete and you no longer need its recordings or credentials, remove **only** `tmp/ubuntu-runner-qualification`, the folder created for this guide. Never delete the whole project `tmp/` or your regular `.echo-data` directory. Synthetic audio-check scratch directories clean themselves up. The reusable `runner/.venv` is an installed dependency and can remain.

## Optional: run the review with Codex on Ubuntu

Open the repository in Codex on your Ubuntu desktop. Use a checkout that contains this guide and `scripts/start-runner.sh`. Give Codex access to the project terminal and, if available, computer-use control of Brave. Then paste the prompt below. This test does not require a hosted speech or notes provider.

```text
Work in this echo-voice-web repository on Ubuntu. Read AGENTS.md if present,
then docs/ubuntu-native-runner-test.md, runner/README.md and docs/integrations.md.
Perform the Ubuntu native meeting-runner qualification from that guide.

Scope and constraints:
- Use native Ubuntu processes only. Do not install, start, restore or depend on
  Docker. Do not switch to a remote-browser login modal.
- Use only sublimeinnovationtechnologies@gmail.com for Calendar, Meet and the
  runner. Never inspect, sign into or test another Google account.
- Never access the camera. Keep camera and microphone denied for the runner.
  Use synthetic/public audio shared into the test meeting for playback.
- Sign-in must occur in the runner's normal dedicated native browser window.
  Ask me to enter passwords, passkeys, verification codes and CAPTCHA myself.
  Do not copy another browser's cookies/profile or bypass Google restrictions.
- Reuse only the runner-owned saved profile on this Ubuntu machine. Preserve
  unrelated browser windows, tabs, libraries and local changes.
- Put every scratch file, download and temporary log under the project tmp/.
  Use the isolated test library in the guide for both server and runner.
  Do not overwrite an existing review folder or delete someone else's scratch.
- Do not push commits or modify a pull request. Keep any fixes local and report
  them. Do not tune speech accuracy or speaker models as part of this review.

Work to completion where the environment permits:
1. Inspect branch, commit, worktree changes, Ubuntu/CPU/desktop, installed Chrome,
   Python, desktop audio service and current listeners. Confirm the checkout
   has the native changes; if missing, report that instead of using old Docker
   instructions or overwriting local work. Install missing project dependencies
   within authorized scope and explain any necessary system installation.
2. Build Echo and run the native auth, integration and audio smoke tests.
   Use the actual installed desktop browser and PulseAudio/PipeWire service.
   Record failures honestly; mocked tests are not live qualification.
3. Start Echo and the runner on an isolated library. Use Brave computer use to
   test the app as a person would, with only test-owned tabs. If computer use is
   unavailable, finish terminal checks and give me precise manual UI steps;
   do not claim those steps passed.
4. Help me connect the allowed Calendar account and complete direct native
   Google sign-in. Verify Save session, exact account matching and session reuse
   after a runner restart. Pause for my credential entry when needed.
5. Create only a clearly named test event owned by the allowed account, with
   no unrelated invitees. Confirm consent and test Meet admission, 2–3 minutes
   of controlled playback, unrelated local audio exclusion, stop/finalization,
   import, transcription and persistence. Keep normal host security settings;
   do not weaken access restrictions to hide an admission failure.
6. Check cancel during sign-in/join, runner interruption and recovery, a second
   meeting using the saved session, and the Calendar controls at mobile width.
7. Keep a concrete review log. For reproducible product bugs, use a subagent to
   propose or implement a focused fix, review the change, run the relevant
   checks and repeat the affected human flow. Do not claim success while a
   blocker remains; separate product bugs from missing setup, Google policy
   restrictions and pending human actions. Do not loop endlessly on the same
   externally blocked sign-in or admission attempt.
8. Write docs/ubuntu-native-runner-results.md with the commit/local changes,
   environment versions, each test result, sanitized evidence, fixes, remaining
   blockers and exactly which steps still need human verification. Never put
   credentials, cookies, account tokens or private meeting links in the report.
9. Stop owned recordings/processes, leave the test meeting, close owned test
   tabs and clean up only scratch files created for this review. Follow the
   guide for event/test-library cleanup; ask before any permanent deletion
   that is not already authorized. Keep useful failure evidence and name its
   location. Preserve the saved runner session if it is needed for follow-up.

Finish with the report path, a concise pass/fail summary and any action I need
to take. Do not describe Linux as qualified unless its real native sign-in,
session reuse and live meeting audio/import checks have actually passed.
```

No LLM is required inside the meeting to run the recorder. Codex can coordinate the checks and fix repository issues; Google credential entry and any required operating-system permissions remain yours. Notes generation is optional and is not a prerequisite for validating the meeting runner.
