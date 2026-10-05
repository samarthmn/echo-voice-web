"""Private recording-browser tests; no Google login or external request occurs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runner"))
import meet_auth as auth
from capture import deny_capture

SCRATCH = ROOT / "tmp"
SCRATCH.mkdir(exist_ok=True)
ACCOUNT = "fixture@example.com"


class AuthTests(unittest.TestCase):
    """Test account proof, OS ownership and auth cancellation without a browser."""
    def fixture(self):
        context = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(context.cleanup)
        return Path(context.name)

    def marker(self, root):
        folder = root / "credentials"
        folder.mkdir(mode=0o700, exist_ok=True)
        (folder / "meet-profile.json").write_text(json.dumps({"version": 1, "email": ACCOUNT}))
        return folder

    def test_profile_lock_is_exclusive_across_processes_and_reusable_after_close(self):
        root = self.fixture()
        lease = auth.ProfileLease(root)
        try:
            probe = "from meet_auth import ProfileLease,AuthError;import sys\ntry:\n ProfileLease(sys.argv[1])\nexcept AuthError:\n sys.exit(7)\nsys.exit(0)"
            result = subprocess.run([sys.executable, "-c", probe, str(root)], env={**os.environ, "PYTHONPATH": str(ROOT / "runner"), "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": str(SCRATCH)}, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 7)
            with self.assertRaises(auth.AuthError): auth.ProfileLease(root)
            self.assertEqual(lease.profile.stat().st_mode & 0o777, 0o700)
        finally:
            lease.close()
        auth.ProfileLease(root).close()

    def test_forget_removes_only_owned_profile_and_never_follows_profile_symlinks(self):
        root, other = self.fixture(), self.fixture()
        folder = self.marker(root)
        profile = folder / "meet-profile"
        profile.mkdir()
        external = other / "keep"
        external.write_text("private fixture")
        (profile / "inside-link").symlink_to(external)
        (folder / "google-calendar.json").write_text("keep calendar fixture")
        manager = auth.AuthManager(root)
        manager.forget()
        self.assertFalse(profile.exists())
        self.assertTrue(external.exists())
        self.assertTrue((folder / "google-calendar.json").exists())
        profile.symlink_to(other, target_is_directory=True)
        with self.assertRaises(auth.AuthError): manager.forget()
        self.assertTrue(external.exists())

    def test_saved_session_reopens_after_restart_but_only_matching_account_can_reserve(self):
        root = self.fixture()
        self.marker(root)
        manager = auth.AuthManager(root)
        self.assertEqual(manager.status()["state"], "signed_in")
        self.assertIn("verified live", manager.status()["detail"])
        with self.assertRaises(auth.AuthError): manager.recording_lease("other@example.com")
        lease = manager.recording_lease(ACCOUNT)
        try:
            with self.assertRaises(auth.AuthError): manager.start(ACCOUNT)
        finally:
            lease.close()
        manager.expired()
        with self.assertRaises(auth.AuthError): manager.recording_lease(ACCOUNT)

    def test_prestart_cancel_fences_old_uuid_without_touching_another_session(self):
        manager = auth.AuthManager(self.fixture())
        cancelled = str(uuid.uuid4())
        manager.cancel(cancelled)
        with self.assertRaisesRegex(auth.AuthError, "cancelled or finished"): manager.start(ACCOUNT, cancelled)
        for _ in range(150): manager.cancel(str(uuid.uuid4()))
        self.assertEqual(len(manager.closed_ids), 128)

    def test_input_is_bounded_and_cannot_navigate_or_execute_browser_shortcuts(self):
        identity = str(uuid.uuid4())
        for value in ({"type": "key", "key": "Shift+Tab"}, {"type": "key", "key": "Control+A"}, {"type": "text", "text": "synthetic value"}, {"type": "click", "x": 1279, "y": 899}, {"type": "scroll", "deltaY": -2000}):
            self.assertEqual(auth.input_command({**value, "sessionId": identity})["sessionId"], identity)
        for value in ({"type": "key", "key": "Control+L"}, {"type": "text", "text": "x" * 4097}, {"type": "click", "x": True, "y": 1}, {"type": "click", "x": 1280, "y": 0}, {"type": "scroll", "deltaY": float("nan")}, {"type": "navigate", "url": "https://evil.test"}):
            with self.assertRaises(ValueError): auth.input_command({**value, "sessionId": identity})

    def test_live_account_requires_actual_https_meet_control_and_exact_identity(self):
        page = Mock(url="https://meet.google.com/")
        page.evaluate.return_value = [f"Google Account: Fixture ({ACCOUNT})"]
        self.assertEqual(auth.require_account(page, ACCOUNT, timeout=0), ACCOUNT)
        with self.assertRaisesRegex(auth.AuthError, "different Google account"): auth.require_account(page, "other@example.com", timeout=0)
        for url in ("https://meet.google.com.evil.test/", "http://meet.google.com/", "https://accounts.google.com/"):
            page.url = url
            self.assertIsNone(auth.account_email(page))
        page.url = "https://meet.google.com/"
        page.evaluate.return_value = [f"Google Account: Fixture ({ACCOUNT})", "Google Account: Other (other@example.com)"]
        with self.assertRaisesRegex(auth.AuthError, "could not verify"): auth.require_account(page, ACCOUNT, timeout=0)

    def test_default_persistent_context_denies_devices_without_inventing_a_context_id(self):
        context, page, target, guard = Mock(), Mock(), Mock(), Mock()
        target.send.return_value = {"targetInfo": {}}
        context.new_cdp_session.side_effect = [target, guard]
        self.assertIs(deny_capture(context, page, "https://meet.google.com", persistent=True), guard)
        calls = [call.args[1] for call in guard.send.call_args_list]
        self.assertEqual({value["permission"]["name"] for value in calls}, {"camera", "microphone"})
        self.assertTrue(all(value["setting"] == "denied" and "browserContextId" not in value for value in calls))
        target.detach.assert_called_once()
        guard.detach.assert_not_called()

    def run_transport(self, stop_blocked=None, navigation_blocked=None):
        """Use thread-owned synthetic page methods, with no Playwright process."""
        root = self.fixture()
        manager = auth.AuthManager(root)
        calls, owner = [], []
        opened = threading.Event()
        page = Mock(url=auth.LOGIN_URL)
        page.is_closed.return_value = False
        def operation(name, *args):
            identifier = threading.get_ident()
            if not owner: owner.append(identifier)
            self.assertEqual(identifier, owner[0])
            calls.append(name)
        def goto(url, **_kwargs):
            operation("goto")
            page.url = url
            opened.set()
            if navigation_blocked and url == auth.LOGIN_URL:
                navigation_blocked.wait(timeout=3)
        page.goto.side_effect = goto
        page.wait_for_timeout.side_effect = lambda _: time.sleep(0.001)
        page.screenshot.side_effect = lambda **_: (operation("screen"), b"fixture-jpeg")[1]
        page.keyboard.insert_text.side_effect = lambda _text: operation("text")
        context = Mock(pages=[page])
        playwright = Mock()
        def stop():
            operation("stop")
            if stop_blocked: stop_blocked.wait(timeout=3)
        playwright.stop.side_effect = stop
        factory = SimpleNamespace(start=lambda: playwright)
        patches = [patch.dict(sys.modules, {"playwright.sync_api": SimpleNamespace(sync_playwright=lambda: factory)}), patch.object(auth, "persistent_context", return_value=context), patch.object(auth, "deny_capture"), patch.object(auth, "verify_receive_only"), patch.object(auth, "require_account", return_value=ACCOUNT), patch.object(auth, "close_context", side_effect=lambda _context: operation("close"))]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(manager.shutdown)
        identifier = str(uuid.uuid4())
        manager.start(ACCOUNT, identifier)
        self.assertTrue(opened.wait(2))
        return manager, identifier, root, calls

    def test_transport_keeps_input_on_owner_thread_and_publishes_after_cleanup(self):
        manager, identifier, root, calls = self.run_transport()
        self.assertEqual(manager.command(identifier, "screen"), b"fixture-jpeg")
        manager.command(identifier, "input", {"type": "text", "text": "synthetic", "sessionId": identifier})
        with self.assertRaises(auth.AuthError): manager.command(str(uuid.uuid4()), "screen")
        result = manager.command(identifier, "finish")
        self.assertEqual(result["state"], "signed_in")
        self.assertEqual(calls[-2:], ["close", "stop"])
        self.assertEqual(auth.AuthManager(root).read_marker(), ACCOUNT)
        lease = manager.recording_lease(ACCOUNT)
        lease.close()

    def test_cancel_during_driver_cleanup_never_publishes_certificate(self):
        release = threading.Event()
        manager, identifier, root, calls = self.run_transport(stop_blocked=release)
        errors = []
        finish = threading.Thread(target=lambda: self.finish_error(manager, identifier, errors))
        finish.start()
        deadline = time.monotonic() + 2
        while "stop" not in calls and time.monotonic() < deadline: time.sleep(0.005)
        self.assertIn("stop", calls)
        self.assertFalse((root / "credentials" / "meet-profile.json").exists())
        cancelled = threading.Thread(target=lambda: manager.cancel(identifier))
        cancelled.start()
        deadline = time.monotonic() + 2
        while manager.cancelled_id != identifier and time.monotonic() < deadline: time.sleep(0.005)
        release.set()
        finish.join(2)
        cancelled.join(2)
        self.assertFalse(finish.is_alive() or cancelled.is_alive())
        self.assertTrue(errors)
        self.assertFalse((root / "credentials" / "meet-profile.json").exists())
        self.assertEqual(manager.status()["state"], "signed_out")

    @staticmethod
    def finish_error(manager, identifier, errors):
        try: manager.command(identifier, "finish")
        except auth.AuthError as error: errors.append(str(error))

    def test_cancelled_future_during_initial_navigation_still_closes_browser(self):
        release = threading.Event()
        manager, identifier, root, calls = self.run_transport(navigation_blocked=release)
        # Simulate a timed-out/cancelled queued acknowledgement. The owner must
        # observe the cancellation fence independently of that Future.
        with manager.lock:
            manager.cancelled_id = identifier
        release.set()
        manager.thread.join(2)
        self.assertFalse(manager.thread.is_alive())
        self.assertEqual(calls[-2:], ["close", "stop"])
        self.assertEqual(manager.status()["state"], "signed_out")
        self.assertFalse((root / "credentials" / "meet-profile.json").exists())


if __name__ == "__main__":
    unittest.main()
