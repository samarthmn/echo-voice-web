"""Native authentication lifecycle tests; never open Chrome or contact Google."""
import json
import os
import socket
from pathlib import Path
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
import native_auth as auth

SCRATCH = ROOT / "tmp"
SCRATCH.mkdir(exist_ok=True)
ACCOUNT = "fixture@example.com"


class NativeAuthTests(unittest.TestCase):
    def setUp(self):
        # Tests never connect to this synthetic display or launch a browser.
        display = patch.dict(auth.os.environ, {"DISPLAY": ":99"})
        display.start()
        self.addCleanup(display.stop)

    def fixture(self):
        folder = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(folder.cleanup)
        return Path(folder.name)

    def wait_closed(self, manager):
        manager.thread.join(timeout=3)
        self.assertFalse(manager.thread.is_alive())

    def process(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        return process

    def test_private_native_lease_does_not_touch_calendar_or_docker_profile(self):
        root = self.fixture()
        lease = auth.NativeProfileLease(root)
        self.assertEqual(lease.profile.name, "meet-native-profile")
        self.assertEqual(lease.profile.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(auth.AuthError):
            auth.NativeProfileLease(root)
        (lease.credentials / "google.json").write_text("keep")
        (lease.credentials / "meet-profile").mkdir()
        lease.close()
        auth.NativeAuthManager(root).forget()
        self.assertTrue((root / "credentials/google.json").exists())
        self.assertTrue((root / "credentials/meet-profile").exists())

    def test_preferences_deny_devices_and_remove_past_allow_exceptions(self):
        lease = auth.NativeProfileLease(self.fixture())
        self.addCleanup(lease.close)
        (lease.profile / "Default").mkdir()
        prefs = lease.profile / "Default/Preferences"
        prefs.write_text(json.dumps({"keep": True, "profile": {"content_settings": {"exceptions": {"media_stream_camera": {"https://meet.google.com,*": {"setting": 1}}, "cookies": {"keep": 1}}}}}))
        auth.block_media_preferences(lease.profile)
        data = json.loads(prefs.read_text())
        self.assertTrue(data["keep"])
        self.assertFalse(data["credentials_enable_service"])
        self.assertFalse(data["profile"]["password_manager_enabled"])
        for key in ("media_stream_camera", "media_stream_mic"):
            self.assertEqual(data["profile"]["default_content_setting_values"][key], 2)
            self.assertNotIn(key, data["profile"]["content_settings"]["exceptions"])
        self.assertEqual(data["profile"]["content_settings"]["exceptions"]["cookies"], {"keep": 1})
        self.assertEqual(prefs.stat().st_mode & 0o777, 0o600)

    def test_preferences_reject_symlink(self):
        lease = auth.NativeProfileLease(self.fixture())
        self.addCleanup(lease.close)
        other = self.fixture()
        (lease.profile / "Default").symlink_to(other)
        with self.assertRaises(auth.AuthError):
            auth.block_media_preferences(lease.profile)

    def test_normal_launch_has_no_automation_or_debugging_flags_and_cancel_is_owned(self):
        manager = auth.NativeAuthManager(self.fixture())
        process = self.process()
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=process) as launch:
            status = manager.start(ACCOUNT)
            deadline = time.monotonic() + 2
            while not launch.called and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(status["mode"], "native_window")
            args = launch.call_args.args[0]
            self.assertFalse(any("debug" in item or "automation" in item for item in args))
            self.assertIn("--deny-permission-prompts", args)
            self.assertIn("--disable-sync", args)
            self.assertEqual(args[-1], auth.LOGIN_URL)
            self.assertIn("credentials/meet-native-profile", args[1])
            self.assertEqual(manager.cancel(status["sessionId"])["state"], "signed_out")
            process.terminate.assert_called_once()
            self.assertIsNone(manager.read_marker())

    def test_finish_certifies_only_after_normal_browser_exit_and_verification(self):
        root = self.fixture()
        manager = auth.NativeAuthManager(root)
        process = self.process()
        def verify(lease, executable):
            process.wait.assert_called_once()
            self.assertIsNone(manager.read_marker())
            return ACCOUNT
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=process), patch.object(manager, "_verify", side_effect=verify):
            status = manager.start(ACCOUNT)
            self.assertEqual(manager.command(status["sessionId"], "finish")["state"], "signed_in")
            self.wait_closed(manager)
        resumed = auth.NativeAuthManager(root)
        self.assertEqual(resumed.status()["email"], ACCOUNT)
        lease = resumed.recording_lease(ACCOUNT)
        lease.close()
        with self.assertRaises(auth.AuthError):
            resumed.recording_lease("someoneelse@example.com")

    def test_cancel_during_verification_fences_marker_and_success(self):
        manager = auth.NativeAuthManager(self.fixture())
        reached, release = threading.Event(), threading.Event()
        process = self.process()
        def verify(*args):
            reached.set()
            self.assertTrue(release.wait(timeout=3))
            return ACCOUNT
        failure = []
        def finish(identifier):
            try:
                manager.command(identifier, "finish")
            except auth.AuthError as error:
                failure.append(error)
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=process), patch.object(manager, "_verify", side_effect=verify):
            status = manager.start(ACCOUNT)
            caller = threading.Thread(target=finish, args=(status["sessionId"],))
            caller.start()
            self.assertTrue(reached.wait(timeout=3))
            manager.cancel(status["sessionId"], wait=False)
            release.set()
            caller.join(timeout=3)
            self.wait_closed(manager)
        self.assertEqual(len(failure), 1)
        self.assertIsNone(manager.read_marker())
        self.assertEqual(manager.status()["state"], "signed_out")

    def test_precancelled_id_cannot_start_and_remote_transport_is_rejected(self):
        manager = auth.NativeAuthManager(self.fixture())
        identifier = str(uuid.uuid4())
        manager.cancel(identifier)
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen") as launch:
            with self.assertRaises(auth.AuthError): manager.start(ACCOUNT, identifier)
            launch.assert_not_called()
        for kind in ("screen", "input", "navigate"):
            with self.assertRaises(auth.AuthError): manager.command(identifier, kind)

    def test_wrong_account_error_never_certifies(self):
        manager = auth.NativeAuthManager(self.fixture())
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=self.process()), patch.object(manager, "_verify", side_effect=auth.AuthError("Wrong Google account.")):
            status = manager.start(ACCOUNT)
            with self.assertRaisesRegex(auth.AuthError, "Wrong Google account"):
                manager.command(status["sessionId"], "finish")
            self.wait_closed(manager)
        self.assertEqual(manager.status()["state"], "error")
        self.assertIsNone(manager.read_marker())

    def test_existing_chrome_profile_lock_fails_before_launch(self):
        root = self.fixture()
        lease = auth.NativeProfileLease(root)
        (lease.profile / "SingletonLock").symlink_to("host-123")
        lease.close()
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(auth.AuthError, "Close the dedicated"):
                auth.NativeAuthManager(root).start(ACCOUNT)
            launch.assert_not_called()

    def test_dead_local_browser_lock_is_recovered_and_forget_remains_available(self):
        root = self.fixture()
        lease = auth.NativeProfileLease(root)
        profile = lease.profile
        lock = profile / "SingletonLock"
        lock.symlink_to(auth.socket.gethostname() + "-54321")
        (lease.credentials / "google.json").write_text("keep calendar")
        lease.close()
        with patch.object(auth.os, "kill", side_effect=ProcessLookupError) as probe:
            restored = auth.NativeProfileLease(root)
            self.assertFalse(lock.is_symlink())
            probe.assert_called_once_with(54321, 0)
            restored.close()
            lock.symlink_to(auth.socket.gethostname() + "-54321")
            self.assertEqual(auth.NativeAuthManager(root).forget()["state"], "signed_out")
        self.assertFalse(profile.exists())
        self.assertTrue((root / "credentials/google.json").exists())

    def test_live_ambiguous_remote_or_changed_browser_locks_are_never_removed(self):
        for target, failure in ((auth.socket.gethostname() + "-54321", None),
                                (auth.socket.gethostname() + "-54321", PermissionError()),
                                ("remote-fixture-host-54321", ProcessLookupError()),
                                ("malformed-lock", ProcessLookupError())):
            with self.subTest(target=target, failure=failure):
                root = self.fixture()
                lease = auth.NativeProfileLease(root)
                lock = lease.profile / "SingletonLock"
                lock.symlink_to(target)
                lease.close()
                with patch.object(auth.os, "kill", side_effect=failure):
                    with self.assertRaises(auth.AuthError): auth.NativeProfileLease(root)
                self.assertEqual(os.readlink(lock), target)
        root = self.fixture()
        lease = auth.NativeProfileLease(root)
        lock = lease.profile / "SingletonLock"
        lock.symlink_to(auth.socket.gethostname() + "-54321")
        lease.close()
        def replace_then_fail(*args):
            lock.unlink()
            lock.symlink_to(auth.socket.gethostname() + "-54322")
            raise ProcessLookupError()
        with patch.object(auth.os, "kill", side_effect=replace_then_fail):
            with self.assertRaises(auth.AuthError): auth.NativeProfileLease(root)
        self.assertEqual(os.readlink(lock), auth.socket.gethostname() + "-54322")

    def test_automated_reopen_preserves_normal_chrome_secure_storage_backend(self):
        playwright = Mock()
        profile = self.fixture() / "dedicated-profile"
        auth.native_persistent_context(playwright, profile, "/fixture/Chrome")
        options = playwright.chromium.launch_persistent_context.call_args.kwargs
        self.assertEqual(options["executable_path"], "/fixture/Chrome")
        self.assertEqual(set(options["ignore_default_args"]), {"--mute-audio", "--password-store=basic", "--use-mock-keychain"})
        self.assertNotIn("--enable-automation", options["ignore_default_args"])
        self.assertFalse(any("AutomationControlled" in argument for argument in options["args"]))

    def test_linux_browser_discovery_prefers_installed_chrome_and_rechecks_executable(self):
        root = self.fixture()
        executable = root / "chrome"
        executable.write_text("fixture")
        executable.chmod(0o700)
        def installed(name):
            return str(executable) if name == "google-chrome-stable" else None
        with patch.object(auth.sys, "platform", "linux"), patch.object(auth.shutil, "which", side_effect=installed):
            self.assertEqual(auth.chrome_executable(), str(executable))
            executable.chmod(0o600)
            with self.assertRaisesRegex(auth.AuthError, "Install Google Chrome or Chromium"):
                auth.chrome_executable()
            executable.chmod(0o700)
            self.assertEqual(auth.chrome_executable(), str(executable))
        with patch.object(auth.sys, "platform", "linux"), patch.object(auth.shutil, "which", side_effect=lambda name: str(executable) if name == "chromium" else None):
            self.assertEqual(auth.chrome_executable(), str(executable))

    def test_linux_desktop_requires_x11_or_a_live_wayland_socket(self):
        root = self.fixture()
        with patch.object(auth.sys, "platform", "linux"), patch.dict(auth.os.environ, {}, clear=True):
            with self.assertRaisesRegex(auth.AuthError, "Headless servers are not supported"):
                auth.desktop_arguments()
            with patch.dict(auth.os.environ, {"DISPLAY": ":1"}):
                self.assertEqual(auth.desktop_arguments(), ["--ozone-platform=x11"])
            with patch.dict(auth.os.environ, {"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": str(root)}):
                with self.assertRaises(auth.AuthError): auth.desktop_arguments()
                stream = socket.socket(socket.AF_UNIX)
                self.addCleanup(stream.close)
                stream.bind(str(root / "wayland-0"))
                self.assertEqual(auth.desktop_arguments(), ["--ozone-platform=wayland"])
        with patch.object(auth.sys, "platform", "win32"):
            with self.assertRaisesRegex(auth.AuthError, "macOS and Linux"):
                auth.chrome_executable()

    def test_linux_recording_browser_routes_only_its_audio_to_the_owned_sink(self):
        playwright = Mock()
        profile = self.fixture() / "profile"
        with patch.object(auth.sys, "platform", "linux"), patch.dict(auth.os.environ, {"PULSE_SINK": "user-default", "DISPLAY": ":2"}):
            auth.native_persistent_context(playwright, profile, "/fixture/chrome", sink="echo_fixture")
            options = playwright.chromium.launch_persistent_context.call_args.kwargs
            self.assertEqual(options["env"]["PULSE_SINK"], "echo_fixture")
            self.assertEqual(auth.os.environ["PULSE_SINK"], "user-default")
            self.assertFalse(options["headless"])
            self.assertEqual(options["executable_path"], "/fixture/chrome")
            self.assertIn("--mute-audio", options["ignore_default_args"])
            self.assertIn("--password-store=basic", options["ignore_default_args"])
            self.assertIn("--ozone-platform=x11", options["args"])
            self.assertIn("--deny-permission-prompts", options["args"])
            self.assertNotIn("--no-sandbox", options["args"])

    def test_verification_error_classifies_known_hosts_without_exposing_login_urls(self):
        original = auth.AuthError("The recording browser could not verify the connected Google account. Finish signing in, then try again.")
        for host, expected in (("accounts.google.com", "incomplete or was blocked"), ("workspace.google.com", "redirected"), ("meet.google.com", "verifiable account control"), ("untrusted.example", "could not verify")):
            page = SimpleNamespace(url="https://" + host + "/private?token=synthetic-secret")
            error = auth.verification_error(page, original)
            self.assertIn(expected, str(error))
            self.assertNotIn("synthetic-secret", str(error))
            self.assertNotIn("/private", str(error))
        wrong_account = auth.AuthError("The dedicated recording browser is signed in to a different Google account.")
        self.assertIs(auth.verification_error(SimpleNamespace(url="https://meet.google.com"), wrong_account), wrong_account)

    def test_nonzero_chrome_exit_reports_failure_and_releases_profile(self):
        root = self.fixture()
        manager = auth.NativeAuthManager(root)
        process = self.process()
        process.poll.return_value = 1
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=process):
            manager.start(ACCOUNT)
            self.wait_closed(manager)
        status = manager.status()
        self.assertEqual(status["state"], "error")
        self.assertIn("Chrome could not start", status["detail"])
        self.assertNotIn("sessionId", status)
        self.assertIsNone(manager.read_marker())
        process.terminate.assert_not_called()
        auth.NativeProfileLease(root).close()

    def test_close_timeout_keeps_profile_lease_until_owned_process_exits(self):
        root = self.fixture()
        manager = auth.NativeAuthManager(root)
        process = self.process()
        closing = threading.Event()
        release = threading.Event()
        def wait(timeout=None):
            if timeout is not None:
                raise auth.subprocess.TimeoutExpired("owned Chrome", timeout)
            closing.set()
            self.assertTrue(release.wait(timeout=3))
            return 0
        process.wait.side_effect = wait
        with patch.object(auth, "chrome_executable", return_value="/fixture/Chrome"), patch.object(auth.subprocess, "Popen", return_value=process), patch.object(manager, "_verify") as verify:
            status = manager.start(ACCOUNT)
            with self.assertRaises(auth.AuthError):
                manager.command(status["sessionId"], "finish")
            self.assertTrue(closing.wait(timeout=3))
            with self.assertRaises(auth.AuthError): auth.NativeProfileLease(root)
            with self.assertRaises(auth.AuthError): manager.forget()
            verify.assert_not_called()
            self.assertIsNone(manager.read_marker())
            release.set()
            self.wait_closed(manager)
        auth.NativeProfileLease(root).close()

    def test_verification_denies_devices_before_navigation_and_closes_before_return(self):
        manager = auth.NativeAuthManager(self.fixture())
        manager.expected = ACCOUNT
        lease = auth.NativeProfileLease(manager.root)
        self.addCleanup(lease.close)
        calls = []
        page = Mock()
        page.goto.side_effect = lambda *args, **kwargs: calls.append("navigate")
        context = SimpleNamespace(pages=[page])
        playwright = Mock()
        playwright.stop.side_effect = lambda: calls.append("driver closed")
        module = SimpleNamespace(sync_playwright=lambda: SimpleNamespace(start=lambda: playwright))
        with patch.dict(sys.modules, {"playwright.sync_api": module}), patch.object(auth, "native_persistent_context", return_value=context), patch.object(auth, "deny_capture", side_effect=lambda *args, **kwargs: calls.append("devices denied")), patch.object(auth, "verify_receive_only", side_effect=lambda *args: calls.append("denial verified")), patch.object(auth, "require_account", return_value=ACCOUNT) as account, patch.object(auth, "close_context", side_effect=lambda *args: calls.append("context closed")):
            self.assertEqual(manager._verify(lease, "/fixture/Chrome"), ACCOUNT)
        self.assertEqual(calls, ["devices denied", "navigate", "denial verified", "context closed", "driver closed"])
        account.assert_called_once_with(page, ACCOUNT, timeout=8)

    def test_pid_from_owned_browser_cdp_rejects_ambiguous_or_invalid_processes(self):
        session = Mock()
        context = SimpleNamespace(browser=SimpleNamespace(new_browser_cdp_session=lambda: session))
        session.send.return_value = {"processInfo": [{"type": "renderer", "id": 22}, {"type": "browser", "id": 42}]}
        self.assertEqual(auth.native_browser_pid(context), 42)
        session.detach.assert_called_once()
        for entries in ([], [{"type": "browser", "id": -1}], [{"type": "browser", "id": True}], [{"type": "browser", "id": 42}, {"type": "browser", "id": 43}]):
            session.send.return_value = {"processInfo": entries}
            with self.assertRaises(auth.AuthError): auth.native_browser_pid(context)


if __name__ == "__main__":
    unittest.main()
