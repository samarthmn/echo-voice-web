"""Runner tests require only Python's standard library; no meeting is joined."""
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("meet_runner", Path(__file__).resolve().parents[1] / "runner" / "meet_runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
SCRATCH = Path(__file__).resolve().parents[1] / "tmp"
SCRATCH.mkdir(exist_ok=True)


class RunnerTests(unittest.TestCase):
    """Exercise runner trust and retry boundaries without Google or browser access."""
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
