#!/usr/bin/env python3
"""Local, consent-gated Google Meet guest recorder. Linux + PulseAudio (native or Docker).

No meeting audio is sent to a recording service. Google Meet itself remains an
external communications service. Run only on loopback; requests require a token.
"""
from __future__ import annotations
import argparse
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import load_config, runner_token
from capture import browser_options, capture_command, deny_capture, verify_receive_only, wait_for_pcm
from meet_ui import capture_join_failure, prepare_guest, diagnostics as join_diagnostics

os.umask(0o077)
CONFIG, DATA_ROOT, RUNNER_PORT = load_config()
DATA = DATA_ROOT / "bot"
TOKEN = ""  # Initialized only when the runner is started, not when tests import it.
SESSIONS: dict[str, "Session"] = {}
LOCK = threading.RLock()
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
MEET_PATTERN = re.compile(r"^/[a-z]{3}-[a-z]{4}-[a-z]{3}/?$")
ACTIVE = {"joining", "waiting", "recording", "stopping"}


def utc_now() -> str:
    """Return an aware UTC timestamp for durable session metadata."""
    return datetime.now(timezone.utc).isoformat()


def validate_url(raw: str) -> str:
    """Canonicalize a standard Google Meet code and reject other destinations."""
    if not isinstance(raw, str):
        raise ValueError("Choose a standard Google Meet link.")
    p = urlparse(raw)
    if p.scheme != "https" or p.netloc != "meet.google.com" or not MEET_PATTERN.fullmatch(p.path):
        raise ValueError("Only standard https://meet.google.com/xxx-xxxx-xxx links are supported.")
    return "https://meet.google.com" + p.path.rstrip("/")


def readiness() -> tuple[bool, str]:
    """Check Linux, PulseAudio, FFmpeg, and Playwright prerequisites without joining a meeting."""
    missing = [x for x in ("ffmpeg", "pactl") if not shutil.which(x)]
    if importlib.util.find_spec("playwright") is None:
        missing.append("Python playwright")
    if missing:
        return False, "Install local runner prerequisites: " + ", ".join(missing)
    if os.name != "posix" or not Path("/proc").exists():
        return False, "The recording runner currently supports Linux with PulseAudio."
    try:
        probe = subprocess.run(["pactl", "info"], capture_output=True, timeout=5)
        if probe.returncode:
            return False, "PulseAudio is not running. Start pulseaudio --start as your normal user."
    except (OSError, subprocess.TimeoutExpired):
        return False, "PulseAudio could not be reached."
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            executable = Path(playwright.chromium.executable_path)
            if not executable.is_file() or not os.access(executable, os.X_OK):
                return False, "Install the runner's Chromium browser with python -m playwright install chromium."
    except Exception:
        return False, "Playwright's Chromium installation could not be checked. Reinstall the runner browser."
    if os.environ.get("ECHO_RUNNER_CONTAINER") == "1" and not (Path(os.environ["XDG_RUNTIME_DIR"]) / "audio-qualified").is_file():
        return False, "The container has not verified audible Chromium playback yet. Check its startup audio test and logs."
    return True, "Local Google Meet runner is ready; hosts must admit its visible recording guest."


class Session:
    def __init__(self, meeting_id: str, url: str, request_id: str):
        """Persist a new start identity before its guest browser thread is launched."""
        self.id, self.url, self.request_id = meeting_id, url, request_id
        self.folder = DATA / meeting_id
        self.folder.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.audio = self.folder / "meeting.wav"
        self.status = "joining"
        self.detail = "Opening Google Meet with microphone and camera disabled."
        self.started_at = None
        self.ended_at = None
        self.duration = 0.0
        self.stop_event = threading.Event()
        self.recording_process = None
        self.sink_module = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.persist()

    def audio_available(self) -> bool:
        """Expose audio only after capture has stopped and the WAV contains sample data."""
        return self.audio.exists() and self.audio.stat().st_size > 44 and self.status not in ACTIVE

    def public(self) -> dict:
        """Return a lock-consistent session snapshot without URLs or bearer credentials."""
        with LOCK:
            return {"meetingId": self.id, "requestId": self.request_id, "status": self.status, "detail": self.detail,
                    "startedAt": self.started_at, "endedAt": self.ended_at,
                    "audioAvailable": self.audio_available(), "duration": self.duration}

    def persist(self):
        """Atomically replace the saved session snapshot for restart recovery."""
        temporary = self.folder / "session.json.tmp"
        temporary.write_text(json.dumps(self.public()), encoding="utf8")
        temporary.replace(self.folder / "session.json")

    def set_state(self, status: str, detail: str):
        """Update and persist a lifecycle transition under the session lock."""
        with LOCK:
            self.status, self.detail = status, detail
            self.persist()

    def stop(self):
        """Signal the guest to leave and publish its stopping state."""
        self.stop_event.set()
        if self.status in ACTIVE:
            self.set_state("stopping", "Leaving the meeting and saving local audio.")

    def run(self):
        """Join as a visible muted guest, record after admission, and finalize local resources on exit."""
        browser = None
        sink = "echo_" + secrets.token_hex(8)
        failure = None
        try:
            from playwright.sync_api import sync_playwright
            sink_result = subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=" + sink,
                                          "sink_properties=device.description=EchoVoice"], capture_output=True, text=True, timeout=10)
            if sink_result.returncode:
                raise RuntimeError("A private audio sink could not be created. Check PulseAudio.")
            self.sink_module = sink_result.stdout.strip()
            with sync_playwright() as p:
                browser = p.chromium.launch(**browser_options(sink, CONFIG["runner"]["headless"]))
                context = browser.new_context(locale="en-US", viewport={"width": 1280, "height": 900})
                page = context.new_page()
                with capture_join_failure(page, self.folder):
                    _permissions_guard = deny_capture(context, page, "https://meet.google.com")
                    try:
                        page.goto(self.url + "?hl=en", wait_until="domcontentloaded", timeout=60_000)
                    except Exception:
                        join_diagnostics(page, self.folder, "navigation-failed")
                        raise
                    # Guest entry is intentionally used. Do not automate a Google login or save account cookies.
                    join = prepare_guest(page, self.stop_event, self.folder)
                    if join is None or self.stop_event.is_set():
                        return
                    verify_receive_only(page)
                    join.click(timeout=15_000)
                    join_diagnostics(page, self.folder, "entry-requested")
                    self.set_state("waiting", "Waiting for the host to admit Echo Voice - Recording. No meeting audio is being recorded yet.")
                    admission_timeout = CONFIG["runner"]["admissionTimeoutSeconds"]
                    deadline = time.monotonic() + admission_timeout
                    leave = page.get_by_role("button", name=re.compile("leave call", re.I))
                    while not self.stop_event.is_set():
                        if leave.count() and leave.first.is_visible():
                            break
                        if page.get_by_text(re.compile("request.*denied|can.t join this.*call|meeting.*ended|no one responded", re.I)).count():
                            join_diagnostics(page, self.folder, "entry-declined")
                            raise RuntimeError("The host declined entry, the meeting ended, or guest access is blocked.")
                        if time.monotonic() > deadline:
                            join_diagnostics(page, self.folder, "admission-timed-out")
                            raise RuntimeError(f"No host admitted the recording guest within {admission_timeout} seconds. Ask the host to admit it, then start a new recording.")
                        page.wait_for_timeout(1000)
                    if not self.stop_event.is_set():
                        join_diagnostics(page, self.folder, "admitted")
                        log = open(self.folder / "capture.log", "wb")
                        try:
                            self.recording_process = subprocess.Popen(capture_command(sink, self.audio),
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
                            wait_for_pcm(self.recording_process, self.audio)
                            self.started_at = utc_now()
                            self.set_state("recording", "Recording this Google Meet locally. Microphone and camera remain off.")
                            start = time.monotonic()
                            while not self.stop_event.is_set():
                                if self.recording_process.poll() is not None:
                                    raise RuntimeError("Audio capture stopped unexpectedly. Any completed audio has been preserved.")
                                if not leave.count() or not leave.first.is_visible():
                                    break
                                if time.monotonic() - start > 8 * 3600:
                                    raise RuntimeError("The eight-hour recording limit was reached. Saved audio remains available.")
                                if shutil.disk_usage(self.folder).free < 100 * 1024 * 1024:
                                    raise RuntimeError("Local disk space is low. Recording stopped safely; completed audio remains available.")
                                page.wait_for_timeout(1000)
                            if leave.count() and leave.first.is_visible():
                                leave.first.click(timeout=5000)
                        finally:
                            self.finish_audio()
                            log.close()
                    browser.close()
                    browser = None
        except Exception as error:
            # Playwright errors may contain remote page internals. Keep API messages concise.
            failure = str(error).split("\n")[0][:350]
            if "Executable doesn't exist" in failure:
                failure = "Install the runner's Chromium browser with python -m playwright install chromium."
            elif "Target page, context or browser has been closed" in failure:
                failure = "The meeting browser closed. Any completed recording has been preserved."
        finally:
            self.finish_audio()
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            if self.sink_module:
                try:
                    subprocess.run(["pactl", "unload-module", self.sink_module], capture_output=True, timeout=10)
                except Exception:
                    pass
            self.ended_at = utc_now()
            if self.audio.exists():
                try:
                    with wave.open(str(self.audio), "rb") as audio:
                        self.duration = audio.getnframes() / audio.getframerate()
                except (wave.Error, EOFError):
                    failure = failure or "The audio file was interrupted and could not be finalized. The file remains on disk for recovery."
            self.set_state("failed" if failure else "completed", failure or ("Local recording saved. Import it into your meeting to transcribe." if self.duration else "The bot left before recording any meeting audio."))

    def finish_audio(self):
        """Ask FFmpeg to finalize its WAV, escalating termination if graceful shutdown stalls."""
        if self.recording_process and self.recording_process.poll() is None:
            try:
                self.recording_process.communicate(input=b"q\n", timeout=10)
            except (subprocess.TimeoutExpired, BrokenPipeError):
                self.recording_process.terminate()
                try:
                    self.recording_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.recording_process.kill()
                    self.recording_process.wait()


def previous_session(meeting_id: str) -> dict | None:
    """Read saved session state and qualify unfinished capture as interrupted after restart."""
    state = DATA / meeting_id / "session.json"
    if not state.exists():
        return None
    try:
        data = json.loads(state.read_text(encoding="utf8"))
        if data.get("status") in ACTIVE:
            data.update(status="failed", detail="The runner restarted during this session. Review any saved audio before trying again.")
        audio = DATA / meeting_id / "meeting.wav"
        data["audioAvailable"] = audio.exists() and audio.stat().st_size > 44
        return data
    except (OSError, json.JSONDecodeError):
        return None


def recover_sessions():
    """Persist interruption state before accepting new requests after a restart."""
    if not DATA.exists():
        return
    for directory in DATA.iterdir():
        if not directory.is_dir() or not ID_PATTERN.fullmatch(directory.name):
            continue
        state = previous_session(directory.name)
        if state:
            temporary = directory / "session.json.tmp"
            temporary.write_text(json.dumps(state), encoding="utf8")
            temporary.replace(directory / "session.json")


class Handler(BaseHTTPRequestHandler):
    server_version = "EchoVoiceLocalRunner/1"

    def log_message(self, *_args):
        """Suppress HTTP logs that could reveal bearer credentials or meeting metadata."""
        pass  # Do not log bearer credentials, meeting URLs, or titles.

    def reply(self, status: int, payload: dict):
        """Return a private JSON response with explicit length and security headers."""
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        """Require the local shared secret and reject direct browser-origin requests."""
        expected = "Bearer " + TOKEN
        if not TOKEN or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            self.reply(401, {"error": "The local runner token is missing or incorrect."})
            return False
        if self.headers.get("Origin"):
            self.reply(403, {"error": "Use the Echo Voice server to access this local runner."})
            return False
        return True

    def session_id(self) -> str | None:
        """Validate endpoint paths before using a meeting ID in managed storage."""
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) not in (2, 3) or parts[0] != "sessions" or not ID_PATTERN.fullmatch(parts[1]) or (len(parts) == 3 and parts[2] != "audio"):
            return None
        return parts[1]

    def do_GET(self):
        """Report readiness or session state, or stream a finalized local recording."""
        if not self.authorized():
            return
        if self.path == "/health":
            ready, detail = readiness()
            self.reply(200, {"ready": ready, "detail": detail, "provider": "google-meet", "platform": "linux"})
            return
        meeting_id = self.session_id()
        if not meeting_id:
            self.reply(404, {"error": "Unknown runner endpoint."})
            return
        with LOCK:
            session = SESSIONS.get(meeting_id)
            state = session.public() if session else previous_session(meeting_id)
        if not state:
            self.reply(404, {"error": "No local recording session exists for this meeting."})
            return
        if self.path.endswith("/audio"):
            if not state.get("audioAvailable"):
                self.reply(409, {"error": "Recording audio is not ready. Stop the bot and wait for it to finish."})
                return
            audio = DATA / meeting_id / "meeting.wav"
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(audio.stat().st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                with audio.open("rb") as file:
                    shutil.copyfileobj(file, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.reply(200, state)

    def do_POST(self):
        """Start one consent-checked guest with retry identity and reject cancelled attempts."""
        if not self.authorized():
            return
        if self.path != "/sessions":
            self.reply(404, {"error": "Unknown runner endpoint."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                raise ValueError("Provide a JSON session request smaller than 8 KB.")
            payload = json.loads(self.rfile.read(length))
            meeting_id = payload.get("meetingId")
            if not isinstance(meeting_id, str) or not ID_PATTERN.fullmatch(meeting_id):
                raise ValueError("A valid meeting ID is required.")
            request_id = payload.get("requestId")
            if not isinstance(request_id, str) or not ID_PATTERN.fullmatch(request_id):
                raise ValueError("A valid recording start ID is required.")
            url = validate_url(payload.get("url"))
            if payload.get("consent") is not True:
                raise ValueError("Participant consent is required before the bot joins.")
        except (ValueError, TypeError, AttributeError, json.JSONDecodeError) as error:
            self.reply(400, {"error": str(error)})
            return
        ready, detail = readiness()
        if not ready:
            self.reply(503, {"error": detail})
            return
        with LOCK:
            if (DATA / ".cancelled" / request_id).exists():
                self.reply(409, {"error": "This recording start was cancelled."})
                return
            existing = SESSIONS.get(meeting_id)
            if existing and existing.request_id == request_id:
                self.reply(202, existing.public())
                return
            previous = previous_session(meeting_id)
            if previous and previous.get("requestId") == request_id:
                self.reply(202, previous)
                return
            if any(s.status in ACTIVE for s in SESSIONS.values()):
                self.reply(409, {"error": "A recording guest is already active. Stop it before joining another meeting."})
                return
            if (DATA / meeting_id / "meeting.wav").exists():
                self.reply(409, {"error": "This meeting already has recorded audio. Import it, then create a new meeting for another recording."})
                return
            session = Session(meeting_id, url, request_id)
            SESSIONS[meeting_id] = session
            session.thread.start()
        self.reply(202, session.public())

    def do_DELETE(self):
        """Stop a matching guest or persist a cancellation fence for an uncertain start."""
        if not self.authorized():
            return
        meeting_id = self.session_id()
        request_id = parse_qs(urlparse(self.path).query).get("requestId", [None])[0]
        if not meeting_id or (request_id is not None and not ID_PATTERN.fullmatch(request_id)):
            self.reply(400, {"error": "A valid meeting and recording start ID are required."})
            return
        with LOCK:
            session = SESSIONS.get(meeting_id)
            if request_id:
                # Persist a cancellation fence before acknowledging it. A delayed
                # POST for this attempt cannot start after a lost response/restart.
                folder = DATA / ".cancelled"
                folder.mkdir(parents=True, exist_ok=True, mode=0o700)
                fence = folder / request_id
                with fence.open("w") as output:
                    output.write(meeting_id)
                    output.flush()
                    os.fsync(output.fileno())
                descriptor = os.open(folder, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                if not session or session.request_id != request_id:
                    self.reply(202, {"meetingId": meeting_id, "requestId": request_id, "status": "completed", "detail": "The recording start was cancelled."})
                    return
            elif not session:
                self.reply(404, {"error": "No active session exists for this meeting."})
                return
            session.stop()
        self.reply(202, session.public())


def main():
    """Initialize shared credentials, recover sessions, and serve the loopback runner until shutdown."""
    global TOKEN
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=RUNNER_PORT)
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--container-bind", action="store_true", help="Listen inside the isolated runner container; publish only on host loopback.")
    args = parser.parse_args()
    if args.container_bind and (sys.platform != "linux" or os.environ.get("ECHO_RUNNER_CONTAINER") != "1"):
        parser.error("--container-bind requires the Linux runner container. Native runners always bind loopback.")
    if args.doctor:
        ready, detail = readiness()
        folder = DATA_ROOT / "credentials"
        token_file = folder / "runner-token"
        try:
            configured = (not folder.is_symlink() and not token_file.is_symlink()
                          and token_file.is_file()
                          and re.fullmatch(r"[A-Za-z0-9_-]{32,}", token_file.read_text(encoding="utf8")) is not None)
        except (OSError, UnicodeError):
            configured = False
        print(json.dumps({"ready": ready, "detail": detail, "tokenConfigured": configured, "dataDirectory": str(DATA)}))
        return 0 if ready else 1
    TOKEN = runner_token(DATA_ROOT)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    def terminate(_signum, _frame):
        """Route process termination through the runner's normal cleanup path."""
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    bind = "0.0.0.0" if args.container_bind else "127.0.0.1"
    server = ThreadingHTTPServer((bind, args.port), Handler)
    server.daemon_threads = True
    recover_sessions()
    print(f"Echo Voice local runner listening at http://{bind}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for session in list(SESSIONS.values()):
            session.stop()
        for session in list(SESSIONS.values()):
            session.thread.join(timeout=15)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
