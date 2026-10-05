"""Runner tests require only Python's standard library; no meeting is joined."""
import importlib.util
import io
import json
import tempfile
import threading
import unittest
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

    def test_container_browser_never_uses_muted_playback_or_disk_shared_memory(self):
        """Playwright's default audio mute is explicitly excluded on both capture paths."""
        for container in (False, True):
            with self.subTest(container=container), patch.dict(runner.os.environ, {"ECHO_RUNNER_CONTAINER": "1" if container else ""}):
                options = runner.browser_options("private-fixture", False)
                self.assertEqual(options["channel"], "chromium")
                self.assertIn("--mute-audio", options["ignore_default_args"])
                self.assertEqual(options["env"]["PULSE_SINK"], "private-fixture")
                self.assertEqual(options["headless"], container)
                self.assertNotIn("--use-fake-device-for-media-stream", options["args"])
                self.assertNotIn("--use-fake-ui-for-media-stream", options["args"])
                self.assertIn("--deny-permission-prompts", options["args"])
                if container:
                    self.assertIn("--disable-dev-shm-usage", options["ignore_default_args"])
                    self.assertNotIn("--disable-dev-shm-usage", options["args"])

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

    def test_readiness_requires_an_installed_chromium_not_only_python(self):
        """A live PulseAudio server and installed Python package cannot imply browser readiness."""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root:
            executable = Path(root) / "chromium"
            context = Mock()
            context.__enter__ = Mock(return_value=SimpleNamespace(chromium=SimpleNamespace(executable_path=str(executable))))
            context.__exit__ = Mock(return_value=False)
            factory = Mock(return_value=context)
            module = SimpleNamespace(sync_playwright=factory)
            with patch.dict(sys.modules, {"playwright.sync_api": module}), patch.object(runner, "CHROMIUM_EXECUTABLE", None), patch.object(runner.importlib.util, "find_spec", return_value=Mock()), patch.object(runner.shutil, "which", return_value="fixture"), patch.object(runner.Path, "exists", return_value=True), patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                ready, detail = runner.readiness()
                self.assertFalse(ready)
                self.assertIn("install chromium", detail)
                executable.write_text("fixture")
                executable.chmod(0o600)
                self.assertFalse(runner.readiness()[0])
                executable.chmod(0o700)
                self.assertTrue(runner.readiness()[0])
                self.assertEqual(factory.call_count, 3, "Missing or non-executable paths must not be cached")
                self.assertTrue(runner.readiness()[0])
                self.assertEqual(factory.call_count, 3, "Health/start checks should reuse the verified browser path")
                executable.chmod(0o600)
                self.assertFalse(runner.readiness()[0])
                self.assertIsNone(runner.CHROMIUM_EXECUTABLE)
                executable.chmod(0o700)
                self.assertTrue(runner.readiness()[0])
                self.assertEqual(factory.call_count, 4, "A restored installation can be verified again")
                executable.unlink()
                self.assertFalse(runner.readiness()[0], "Removing a cached browser must invalidate readiness")
                self.assertIsNone(runner.CHROMIUM_EXECUTABLE)

    def test_failed_browser_discovery_is_retried(self):
        """A temporary Playwright inspection failure cannot poison future health checks."""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root:
            executable = Path(root) / "chromium"
            executable.write_text("fixture")
            executable.chmod(0o700)
            context = Mock()
            context.__enter__ = Mock(side_effect=[RuntimeError("fixture failure"), SimpleNamespace(chromium=SimpleNamespace(executable_path=str(executable)))])
            context.__exit__ = Mock(return_value=False)
            factory = Mock(return_value=context)
            with patch.dict(sys.modules, {"playwright.sync_api": SimpleNamespace(sync_playwright=factory)}), patch.object(runner, "CHROMIUM_EXECUTABLE", None), patch.object(runner.importlib.util, "find_spec", return_value=Mock()), patch.object(runner.shutil, "which", return_value="fixture"), patch.object(runner.Path, "exists", return_value=True), patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                ready, detail = runner.readiness()
                self.assertFalse(ready)
                self.assertIn("could not be checked", detail)
                self.assertIsNone(runner.CHROMIUM_EXECUTABLE)
                self.assertTrue(runner.readiness()[0])
                self.assertEqual(factory.call_count, 2)

    def test_container_bind_is_explicit_and_keeps_native_loopback(self):
        """The broader container listener cannot be selected by ordinary native CLI invocation."""
        with patch.object(runner.sys, "argv", ["meet_runner.py", "--container-bind"]), patch.dict(runner.os.environ, {"ECHO_RUNNER_CONTAINER": ""}), patch("sys.stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                runner.main()
            self.assertEqual(error.exception.code, 2)
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        for container in (False, True):
            with self.subTest(container=container), patch.object(runner.sys, "argv", ["meet_runner.py", "--port", "18765"] + (["--container-bind"] if container else [])), patch.object(runner.sys, "platform", "linux"), patch.dict(runner.os.environ, {"ECHO_RUNNER_CONTAINER": "1"}), patch.object(runner, "runner_token", return_value="fixture-token"), patch.object(runner, "recover_sessions"), patch.object(runner, "SESSIONS", {}), patch.object(runner.Path, "mkdir"), patch.object(runner.signal, "signal"), patch.object(runner, "ThreadingHTTPServer", return_value=server) as factory, patch("sys.stdout", io.StringIO()):
                self.assertEqual(runner.main(), 0)
                factory.assert_called_once_with(("0.0.0.0" if container else "127.0.0.1", 18765), runner.Handler)

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

            payload = {"meetingId": "meeting-1", "requestId": "start-1", "url": "https://meet.google.com/abc-defg-hij", "consent": True}
            try:
                original_init = runner.Session.__init__
                def fixture_init(session, *args):
                    """Keep real state persistence but replace only the guest thread."""
                    original_init(session, *args)
                    session.thread = Mock()
                with patch.object(runner.Session, "__init__", fixture_init):
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
