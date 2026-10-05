"""Runner tests require only Python's standard library; no meeting is joined."""
import importlib.util
import io
import json
import tempfile
import threading
import unittest
import wave
import sys
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch, Mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("meet_runner", Path(__file__).resolve().parents[1] / "runner" / "meet_runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
import meet_ui
SCRATCH = Path(__file__).resolve().parents[1] / "tmp"
SCRATCH.mkdir(exist_ok=True)


class RunnerTests(unittest.TestCase):
    """Exercise runner trust and retry boundaries without Google or browser access."""
    def test_visible_refusals_preserve_evidence_without_guessing_account_policy(self):
        """Generic refusal cannot become a claim that an account or headless mode is required."""
        generic = meet_ui.refusal(["You can't join this video call"])
        self.assertIn("You can't join this video call", generic)
        self.assertNotIn("signed-in", generic)
        self.assertNotIn("browser", generic)
        self.assertIn("does not support this recording browser", meet_ui.refusal(["This browser is not supported"]))
        self.assertIn("requires a signed-in participant", meet_ui.refusal(["Sign in to join"]))
        self.assertIsNone(meet_ui.refusal(["Ready to join?", "Continue without microphone and camera"]))
        redacted = meet_ui.refusal(["Cannot join https://meet.google.com/abc-defg-hij as person@example.com"])
        self.assertNotIn("abc-defg-hij", redacted)
        self.assertNotIn("person@example.com", redacted)

    def test_blocked_device_prejoin_continues_without_enabling_capture(self):
        """Guest-name entry appears after the receive-only prompt; dangerous controls stay untouched."""
        page = Mock()
        continuation, name, join = Mock(), Mock(), Mock()
        stage = [0]
        continuation.is_visible.return_value = True
        continuation.click.side_effect = lambda **_: stage.__setitem__(0, 1)
        name.is_visible.return_value = True
        name.input_value.side_effect = lambda: "" if stage[0] < 2 else "Echo Voice - Recording"
        name.fill.side_effect = lambda _: stage.__setitem__(0, 2)
        join.is_visible.return_value = True
        join.is_enabled.side_effect = lambda: stage[0] == 2

        def controls(role, name):
            found = []
            if role == "button" and stage[0] == 0 and name.search("Continue without microphone and camera"):
                found = [continuation]
            elif role == "textbox" and stage[0] >= 1:
                found = [globals_name]
            elif role == "button" and stage[0] >= 1 and name.search("Ask to join"):
                found = [join]
            locator = Mock()
            locator.all.return_value = found
            return locator

        globals_name = name
        page.get_by_role.side_effect = controls
        page.get_by_text.return_value.count.return_value = 0
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(meet_ui, "diagnostics"), patch.object(meet_ui, "verify_receive_only") as verify:
            self.assertIs(meet_ui.prepare_guest(page, threading.Event(), Path(root)), join)
            continuation.click.assert_called_once()
            name.fill.assert_called_once_with("Echo Voice - Recording")
            join.click.assert_not_called()  # Actual entry remains with the caller's stop/consent fence.
            self.assertGreaterEqual(verify.call_count, 3)
            self.assertFalse(any(call.kwargs["name"].search("Turn off camera") or call.kwargs["name"].search("Turn off microphone")
                                 for call in page.get_by_role.call_args_list if call.args[0] == "button"))
        for dangerous in ("Use microphone and camera", "Turn on camera", "Turn on microphone", "Join now"):
            self.assertIsNone(meet_ui.WITHOUT_DEVICES.fullmatch(dangerous))

    def test_join_exception_is_diagnosed_before_browser_cleanup_and_remains_failure(self):
        """Actionability/timeout failures retain current visible evidence without masking the error."""
        page = Mock()
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(meet_ui, "diagnostics") as snapshot:
            folder = Path(root)
            with self.assertRaisesRegex(RuntimeError, "blocked control"):
                with meet_ui.capture_join_failure(page, folder):
                    raise RuntimeError("blocked control")
            snapshot.assert_called_once_with(page, folder, "join-failed")

    def test_join_diagnostics_redact_links_codes_and_email_and_failed_entry_stays_bounded(self):
        """Diagnostics retain safe controls while unsupported UI cannot enter a meeting."""
        self.assertEqual(meet_ui.sanitized_label("Copy https://meet.google.com/abc-defg-hij for person@example.com abc-defg-hij"), "Copy [link] for [email] [meeting code]")
        page = Mock()
        page.evaluate.return_value = ["Continue without camera", "Copy https://meet.google.com/abc-defg-hij", "person@example.com"]
        page.get_by_text.return_value.all.return_value = []
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root:
            folder = Path(root)
            meet_ui.diagnostics(page, folder, "prejoin")
            data = json.loads((folder / "join-diagnostics.json").read_text())
            self.assertEqual(data["buttons"], ["Continue without camera", "Copy [link]", "[email]"])
            self.assertNotIn("url", data)
            with self.assertRaisesRegex(RuntimeError, "could not join this Google Meet"):
                meet_ui.prepare_guest(page, threading.Event(), folder, timeout=0)
            self.assertEqual(json.loads((folder / "join-diagnostics.json").read_text())["phase"], "prejoin-timed-out")
            cancelled = threading.Event()
            cancelled.set()
            self.assertIsNone(meet_ui.prepare_guest(page, cancelled, folder))

    def test_recording_requires_written_pcm_not_only_a_live_capture_process(self):
        """Header-only files and failed processes cannot produce a recording-ready state."""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root:
            audio = Path(root) / "meeting.wav"
            process = Mock()
            process.poll.return_value = None
            audio.write_bytes(b"header" + bytes(38))
            with self.assertRaisesRegex(RuntimeError, "no PCM"):
                runner.wait_for_pcm(process, audio, timeout=0.001)
            audio.write_bytes(bytes(44 + 3200))
            runner.wait_for_pcm(process, audio, timeout=0.1)
            process.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, "failed before PCM"):
                runner.wait_for_pcm(process, audio, timeout=0.1)

    def test_receive_only_context_denies_both_devices_before_join_and_fails_closed(self):
        """Apply denials to the exact guest context and stop if enforcement cannot be verified."""
        context, page, cdp, browser_cdp = Mock(), Mock(), Mock(), Mock()
        context.new_cdp_session.return_value = cdp
        context.browser.new_browser_cdp_session.return_value = browser_cdp
        cdp.send.return_value = {"targetInfo": {"browserContextId": "guest-context"}}
        self.assertIs(runner.deny_capture(context, page, "https://meet.google.com"), browser_cdp)
        permissions = [call.args[1] for call in browser_cdp.send.call_args_list if call.args[0] == "Browser.setPermission"]
        self.assertEqual({item["permission"]["name"] for item in permissions}, {"camera", "microphone"})
        self.assertTrue(all(item["setting"] == "denied" and item["browserContextId"] == "guest-context" for item in permissions))
        self.assertTrue(all(item["origin"] == "https://meet.google.com" for item in permissions))
        self.assertTrue(all(item["embeddingOrigin"] == "https://meet.google.com" for item in permissions))
        cdp.detach.assert_called_once()
        browser_cdp.detach.assert_not_called()
        page.evaluate.return_value = True
        runner.verify_receive_only(page)
        for state in (False, None, "denied"):
            page.evaluate.return_value = state
            with self.assertRaisesRegex(RuntimeError, "guest did not join"):
                runner.verify_receive_only(page)
        cdp.reset_mock()
        browser_cdp.reset_mock()
        cdp.send.return_value = {"targetInfo": {}}
        with self.assertRaisesRegex(RuntimeError, "could not be identified"):
            runner.deny_capture(context, page, "https://meet.google.com")
        browser_cdp.send.assert_not_called()
        cdp.detach.assert_called_once()

    def test_linux_auth_uses_native_profile_and_does_not_require_audio_tools(self):
        import native_auth
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "AUTH", None), patch.object(runner, "DATA_ROOT", Path(root)), patch.object(runner.sys, "platform", "linux"), patch.object(runner.importlib.util, "find_spec", return_value=Mock()), patch.object(runner, "chrome_executable", return_value="/fixture/chrome"), patch.object(runner.shutil, "which", return_value=None):
            self.assertTrue(runner.auth_readiness()[0])
            self.assertIsInstance(runner.auth_manager(), native_auth.NativeAuthManager)
            self.assertEqual(runner.auth_manager().status()["mode"], "native_window")
            ready, detail = runner.readiness()
            self.assertFalse(ready)
            self.assertIn("ffmpeg, pactl", detail)

    def test_linux_session_reopens_native_profile_with_owned_sink_and_cleans_up(self):
        """Exercise production session routing while every browser/audio call is mocked."""
        playwright, context, page, lease = Mock(), Mock(), Mock(), Mock()
        context.pages = [page]
        module = SimpleNamespace(sync_playwright=lambda: SimpleNamespace(start=lambda: playwright))
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "DATA", Path(root)), patch.object(runner.sys, "platform", "linux"), patch.dict(sys.modules, {"playwright.sync_api": module}), patch.object(runner, "native_persistent_context", return_value=context) as launch, patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="42\n")) as audio, patch.object(runner, "deny_capture"), patch.object(runner, "verify_receive_only"), patch.object(runner, "require_account"), patch.object(runner, "prepare_guest", return_value=None), patch.object(runner, "close_context") as close:
            session = runner.Session("fixture-native", "https://meet.google.com/abc-defg-hij", "fixture-request", "fixture@example.com", lease)
            session.run()
            sink = launch.call_args.kwargs["sink"]
            self.assertTrue(sink.startswith("echo_"))
            self.assertEqual(launch.call_args.args, (playwright, lease.profile))
            self.assertIn("sink_name=" + sink, audio.call_args_list[0].args[0])
            self.assertEqual(audio.call_args_list[-1].args[0], ["pactl", "unload-module", "42"])
            close.assert_called_once_with(context)
            playwright.stop.assert_called_once()
            lease.close.assert_called_once()
            self.assertEqual(session.status, "completed")
            self.assertFalse(session.audio_available())

    def test_stop_during_account_proof_never_clicks_join_or_republishes_waiting(self):
        """Stop arriving inside a slow identity check fences the later UI action."""
        for stop_phase in ("first-proof", "prejoin-proof", "join-click"):
            with self.subTest(stop_phase=stop_phase):
                playwright, context, page, lease, join = Mock(), Mock(), Mock(), Mock(), Mock()
                context.pages = [page]
                module = SimpleNamespace(sync_playwright=lambda: SimpleNamespace(start=lambda: playwright))
                with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "DATA", Path(root)), patch.object(runner.sys, "platform", "linux"), patch.dict(sys.modules, {"playwright.sync_api": module}), patch.object(runner, "native_persistent_context", return_value=context), patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="42\n")), patch.object(runner, "deny_capture"), patch.object(runner, "verify_receive_only"), patch.object(runner, "require_account") as proof, patch.object(runner, "prepare_guest", return_value=join), patch.object(runner, "close_context"), patch.object(runner, "join_diagnostics"):
                    session = runner.Session("fixture-stop", "https://meet.google.com/abc-defg-hij", "fixture-request", "fixture@example.com", lease)
                    persisted = []
                    checks = []
                    def account(*args):
                        checks.append(True)
                        if (stop_phase == "first-proof" and len(checks) == 1) or (stop_phase == "prejoin-proof" and len(checks) == 2):
                            session.stop()
                    proof.side_effect = account
                    if stop_phase == "join-click":
                        join.click.side_effect = lambda **kwargs: session.stop()
                    with patch.object(session, "persist", side_effect=lambda: persisted.append(session.status)):
                        session.run()
                    if stop_phase == "join-click":
                        join.click.assert_called_once()
                    else:
                        join.click.assert_not_called()
                    self.assertEqual(persisted, ["stopping", "completed"])
                    self.assertIsNone(session.recording_process)
                    lease.close.assert_called_once()

    def test_stop_fences_late_waiting_and_recording_state_updates(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "DATA", Path(root)):
            session = runner.Session("fixture-stop-state", "https://meet.google.com/abc-defg-hij", "fixture-request", "fixture@example.com", Mock())
            session.stop()
            for status in ("joining", "waiting", "recording"):
                session.set_state(status, "late async result")
                self.assertEqual(session.status, "stopping")
                self.assertEqual(json.loads((session.folder / "session.json").read_text())["status"], "stopping")

    def test_linux_readiness_checks_desktop_audio_server_and_ffmpeg_input(self):
        with patch.object(runner.sys, "platform", "linux"), patch.object(runner, "auth_readiness", return_value=(True, "ready")), patch.object(runner.shutil, "which", return_value="/fixture/tool"), patch.object(runner.subprocess, "run") as run:
            run.side_effect = [SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stdout=" DE pulse Pulse audio output\n", stderr="")]
            self.assertTrue(runner.readiness()[0])
            self.assertEqual(run.call_args_list[0].args[0], ["pactl", "info"])
            self.assertEqual(run.call_args_list[1].args[0], ["ffmpeg", "-hide_banner", "-devices"])
            run.side_effect = [SimpleNamespace(returncode=1)]
            self.assertIn("PipeWire-Pulse", runner.readiness()[1])
            for devices in (" E pulse output only\n", " D alsa ALSA input\n", ""):
                run.side_effect = [SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stdout=devices, stderr="")]
                self.assertIn("PulseAudio input support", runner.readiness()[1])
            run.side_effect = runner.subprocess.TimeoutExpired("fixture", 5)
            self.assertIn("could not be checked", runner.readiness()[1])

    def test_readiness_propagates_missing_desktop_or_browser_and_retries(self):
        with patch.object(runner.sys, "platform", "linux"), patch.object(runner.importlib.util, "find_spec", return_value=Mock()), patch.object(runner, "chrome_executable", side_effect=[runner.AuthError("Desktop unavailable"), "/fixture/chrome"]):
            self.assertEqual(runner.readiness(), (False, "Desktop unavailable"))
            self.assertTrue(runner.auth_readiness()[0])
        with patch.object(runner.sys, "platform", "win32"):
            self.assertFalse(runner.auth_readiness()[0])

    def test_native_sign_in_does_not_require_audio_capture_permission(self):
        import native_auth
        helper = Mock()
        with patch.object(runner.sys, "platform", "darwin"), patch.object(runner.importlib.util, "find_spec", return_value=Mock()), patch.object(runner, "chrome_executable", return_value="/fixture/Chrome"), patch.object(runner, "mac_capture_helper", return_value=helper), patch.object(runner.os, "access", return_value=True), patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"ready":false,"state":"permission_required"}')):
            self.assertTrue(runner.auth_readiness()[0])
            self.assertFalse(runner.readiness()[0])
            self.assertIn("Screen & System Audio", runner.readiness()[1])

    def test_native_capture_refuses_a_missing_or_unresponsive_helper(self):
        helper = Mock()
        helper.is_file.return_value = False
        with patch.object(runner.sys, "platform", "darwin"), patch.object(runner, "auth_readiness", return_value=(True, "ready")), patch.object(runner, "mac_capture_helper", return_value=helper):
            self.assertFalse(runner.readiness()[0])
            helper.is_file.return_value = True
            with patch.object(runner.os, "access", return_value=True), patch.object(runner.subprocess, "run", side_effect=runner.subprocess.TimeoutExpired("fixture", 1)):
                self.assertFalse(runner.readiness()[0])

    def test_native_runner_only_binds_loopback_and_rejects_container_flag(self):
        with patch.object(runner.sys, "argv", ["meet_runner.py", "--container-bind"]), patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                runner.main()
            self.assertEqual(error.exception.code, 2)
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(runner.sys, "argv", ["meet_runner.py", "--port", "18765"]), patch.object(runner, "AUTH", None), patch.object(runner, "runner_token", return_value="fixture-token"), patch.object(runner, "recover_sessions"), patch.object(runner, "SESSIONS", {}), patch.object(runner.Path, "mkdir"), patch.object(runner.signal, "signal"), patch.object(runner, "ThreadingHTTPServer", return_value=server) as factory, patch("sys.stdout", io.StringIO()):
            self.assertEqual(runner.main(), 0)
            factory.assert_called_once_with(("127.0.0.1", 18765), runner.Handler)

    def test_doctor_inspects_existing_credentials_without_writing_them(self):
        """Doctor reports real credential validity and keeps a missing library untouched."""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root:
            data = Path(root) / "library"

            def doctor():
                output = io.StringIO()
                with patch.object(runner, "DATA_ROOT", data), patch.object(runner, "DATA", data / "bot"), patch.object(runner, "readiness", return_value=(False, "fixture")), patch.object(runner.sys, "argv", ["meet_runner.py", "--doctor"]), patch("sys.stdout", output):
                    self.assertEqual(runner.main(), 1)
                return json.loads(output.getvalue())["tokenConfigured"]

            self.assertFalse(doctor())
            self.assertFalse(data.exists())
            folder = data / "credentials"
            folder.mkdir(parents=True)
            token = folder / "runner-token"
            for content, expected in ((b"a" * 64, True), (b"short", False), (b"!" * 64, False), (b"\xff" * 64, False)):
                with self.subTest(content=content):
                    token.write_bytes(content)
                    before = token.stat()
                    self.assertEqual(doctor(), expected)
                    self.assertEqual(token.read_bytes(), content)
                    self.assertEqual(token.stat().st_mtime_ns, before.st_mtime_ns)
                    self.assertEqual(token.stat().st_mode, before.st_mode)
            token.write_text("a" * 64)
            with patch.object(Path, "read_text", side_effect=PermissionError("fixture unreadable token")):
                self.assertFalse(doctor())
            token.rename(folder / "valid-token")
            token.symlink_to(folder / "valid-token")
            self.assertFalse(doctor())
            token.unlink()
            token.mkdir()
            self.assertFalse(doctor())
            token.rmdir()
            (folder / "valid-token").rename(token)
            folder.rename(data / "linked-credentials")
            folder.symlink_to(data / "linked-credentials", target_is_directory=True)
            self.assertFalse(doctor())

    def test_only_standard_google_meet_urls(self):
        self.assertEqual(runner.validate_url("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com/abc-defg-hij")
        for url in ("https://meet.google.com.evil.test/abc-defg-hij", "http://meet.google.com/abc-defg-hij", "https://user@meet.google.com/abc-defg-hij", "https://meet.google.com:443/abc-defg-hij", "http://127.0.0.1", "https://zoom.us/j/123"):
            with self.assertRaises(ValueError):
                runner.validate_url(url)

    def test_interrupted_sessions_never_claim_to_be_recording(self):
        with tempfile.TemporaryDirectory(dir=Path("tmp")) as root, patch.object(runner, "DATA", Path(root)):
            directory = Path(root) / "meeting-1"
            directory.mkdir()
            (directory / "session.json").write_text(json.dumps({"meetingId": "meeting-1", "status": "recording"}))
            state = runner.previous_session("meeting-1")
            self.assertEqual(state["status"], "failed")
            self.assertFalse(state["audioAvailable"])
            self.assertIn("restarted", state["detail"])
            runner.recover_sessions()
            persisted = json.loads((directory / "session.json").read_text())
            self.assertEqual(persisted["status"], "failed")

    def test_audio_availability_requires_finalized_and_complete_wav(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "DATA", Path(root)):
            directory = Path(root) / "meeting-1"
            directory.mkdir()
            path = directory / "meeting.wav"
            (directory / "session.json").write_text(json.dumps({"meetingId": "meeting-1", "status": "completed"}))
            session = runner.Session.__new__(runner.Session)
            session.audio, session.status = path, "completed"
            # Reproduce an interrupted native helper: zero data length in its
            # initial header, despite physical sample bytes appended afterward.
            with wave.open(str(path), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            with path.open("ab") as audio:
                audio.write(b"\0" * 6400)
            self.assertFalse(session.audio_available())
            self.assertFalse(runner.previous_session("meeting-1")["audioAvailable"])
            with wave.open(str(path), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\0" * 6400)
            self.assertEqual(runner.finalized_audio_duration(path), 0.2)
            self.assertTrue(session.audio_available())
            self.assertTrue(runner.previous_session("meeting-1")["audioAvailable"])
            session.status = "recording"
            self.assertFalse(session.audio_available())
            session.status = "completed"
            with path.open("r+b") as audio:
                audio.truncate(path.stat().st_size - 2)
            self.assertFalse(session.audio_available())
            self.assertFalse(runner.previous_session("meeting-1")["audioAvailable"])

    def test_native_shutdown_retains_nonzero_or_forced_failure(self):
        for mode in ("graceful", "nonzero", "timeout", "already_exited"):
            with self.subTest(mode=mode), patch.object(runner.sys, "platform", "darwin"):
                session = runner.Session.__new__(runner.Session)
                session.capture_failure = None
                process = Mock()
                process.poll.side_effect = [1, 1] if mode == "already_exited" else [None, 1 if mode == "nonzero" else 0]
                if mode == "timeout":
                    process.communicate.side_effect = runner.subprocess.TimeoutExpired("fixture", 10)
                session.recording_process = process
                session.finish_audio()
                self.assertEqual(session.capture_failure is None, mode == "graceful")
                if mode == "already_exited":
                    process.terminate.assert_not_called()
                else:
                    process.terminate.assert_called()

    def test_linux_shutdown_keeps_ffmpeg_graceful_input(self):
        session = runner.Session.__new__(runner.Session)
        session.capture_failure = None
        session.recording_process = Mock()
        session.recording_process.poll.return_value = None
        with patch.object(runner.sys, "platform", "linux"):
            session.finish_audio()
        session.recording_process.communicate.assert_called_once_with(input=b"q\n", timeout=10)
        session.recording_process.terminate.assert_not_called()
        self.assertIsNone(session.capture_failure)

    def test_http_requires_token_and_rejects_browser_origins_and_missing_consent(self):
        with patch.object(runner, "TOKEN", "test-token"):
            server = runner.ThreadingHTTPServer(("127.0.0.1", 0), runner.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                with self.assertRaises(HTTPError) as error:
                    urlopen(base + "/health")
                self.assertEqual(error.exception.code, 401)
                error.exception.close()
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/health", headers={"Authorization": "Bearer test-token", "Origin": "https://evil.test"}))
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
                data = json.dumps({"meetingId": "meeting-1", "url": "https://meet.google.com/abc-defg-hij", "consent": False, "requestId": "attempt-1"}).encode()
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/sessions", data=data, headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"}))
                self.assertEqual(error.exception.code, 400)
                self.assertIn("consent", error.exception.read().decode())
                error.exception.close()
                self.assertFalse(runner.SESSIONS)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_retry_identity_and_cancellation_fence_survive_runner_restart(self):
        """Retries reuse a guest; cancellation cannot stop another ID or allow a delayed join."""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root, patch.object(runner, "DATA", Path(root)), patch.object(runner, "TOKEN", "test-token"), patch.object(runner, "SESSIONS", {}), patch.object(runner, "readiness", return_value=(True, "fixture")):
            server = runner.ThreadingHTTPServer(("127.0.0.1", 0), runner.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"

            def request(method, endpoint, body=None):
                """Send an authenticated fixture request and close its response stream."""
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(base + endpoint, method=method, data=data, headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"}), timeout=5) as response:
                    return json.loads(response.read())

            payload = {"meetingId": "meeting-1", "requestId": "start-1", "url": "https://meet.google.com/abc-defg-hij", "consent": True, "expectedEmail": "fixture@example.com"}
            try:
                original_init = runner.Session.__init__
                def fixture_init(session, *args):
                    """Keep real state persistence but replace only the guest thread."""
                    original_init(session, *args)
                    session.thread = Mock()
                with patch.object(runner.Session, "__init__", fixture_init), patch.object(runner, "AUTH", SimpleNamespace(recording_lease=lambda _email: Mock())):
                    first = request("POST", "/sessions", payload)
                    second = request("POST", "/sessions", payload)
                    self.assertEqual(first["requestId"], second["requestId"])
                    self.assertEqual(runner.SESSIONS["meeting-1"].thread.start.call_count, 1)
                request("DELETE", "/sessions/meeting-1?requestId=other-start")
                self.assertEqual(runner.SESSIONS["meeting-1"].status, "joining")
                request("DELETE", "/sessions/meeting-1?requestId=start-1")
                self.assertTrue(runner.SESSIONS["meeting-1"].stop_event.is_set())
                runner.SESSIONS.clear()
                runner.recover_sessions()
                with self.assertRaises(HTTPError) as error:
                    request("POST", "/sessions", payload)
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
                # Cancellation may arrive before the runner ever sees the POST.
                request("DELETE", "/sessions/meeting-2?requestId=delayed-start")
                with self.assertRaises(HTTPError) as error:
                    request("POST", "/sessions", {**payload, "meetingId": "meeting-2", "requestId": "delayed-start"})
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
                self.assertFalse(runner.SESSIONS)
                # Persisted retry identity also prevents a restarted runner from rejoining.
                folder = Path(root) / "meeting-3"
                folder.mkdir()
                (folder / "session.json").write_text(json.dumps({"meetingId": "meeting-3", "requestId": "old-start", "status": "joining"}))
                runner.recover_sessions()
                with patch.object(runner, "Session") as factory:
                    state = request("POST", "/sessions", {**payload, "meetingId": "meeting-3", "requestId": "old-start"})
                    self.assertEqual(state["status"], "failed")
                    factory.assert_not_called()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
