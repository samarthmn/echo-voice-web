"""Runner tests require only Python's standard library; no meeting is joined."""
import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("meet_runner", Path(__file__).resolve().parents[1] / "runner" / "meet_runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def test_only_standard_google_meet_urls(self):
        self.assertEqual(runner.validate_url("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com/abc-defg-hij")
        for url in ("https://meet.google.com.evil.test/abc-defg-hij", "http://meet.google.com/abc-defg-hij", "https://user@meet.google.com/abc-defg-hij", "https://meet.google.com:443/abc-defg-hij", "http://127.0.0.1", "https://zoom.us/j/123"):
            with self.assertRaises(ValueError):
                runner.validate_url(url)

    def test_interrupted_sessions_never_claim_to_be_recording(self):
        with tempfile.TemporaryDirectory() as root, patch.object(runner, "DATA", Path(root)):
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
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/health", headers={"Authorization": "Bearer test-token", "Origin": "https://evil.test"}))
                self.assertEqual(error.exception.code, 403)
                data = json.dumps({"meetingId": "meeting-1", "url": "https://meet.google.com/abc-defg-hij", "consent": False}).encode()
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/sessions", data=data, headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"}))
                self.assertEqual(error.exception.code, 400)
                self.assertIn("consent", error.exception.read().decode())
                self.assertFalse(runner.SESSIONS)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
