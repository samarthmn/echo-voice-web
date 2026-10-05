"""Dedicated native browser sign-in; never reuse a user's everyday profile."""
from collections import deque
from concurrent.futures import Future, TimeoutError
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

from capture import deny_capture, verify_receive_only
from meet_auth import (AuthError, LOGIN_URL, START_URL, close_context, email_address,
                       fcntl, require_account, session_id)


def desktop_arguments():
    """Require a real desktop session; never silently substitute headless capture."""
    if sys.platform == "darwin":
        return []
    if sys.platform != "linux":
        raise AuthError("The native meeting runner supports macOS and Linux desktop sessions.")
    if os.environ.get("DISPLAY", "").strip():
        return ["--ozone-platform=x11"]
    display = os.environ.get("WAYLAND_DISPLAY", "")
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if display and (Path(display).is_absolute() or (runtime and Path(runtime).is_absolute())):
        socket = Path(display) if Path(display).is_absolute() else Path(runtime) / display
        try:
            if socket.is_socket():
                return ["--ozone-platform=wayland"]
        except OSError:
            pass
    raise AuthError("Start the Linux runner from your logged-in desktop with DISPLAY or a working Wayland socket. Headless servers are not supported by native browser sign-in.")


def chrome_executable():
    """Use an installed browser, with no shell or everyday-profile delegation."""
    desktop_arguments()
    if sys.platform == "darwin":
        for app in (Path("/Applications/Google Chrome.app"), Path.home() / "Applications/Google Chrome.app"):
            binary = app / "Contents/MacOS/Google Chrome"
            if binary.is_file() and os.access(binary, os.X_OK):
                return str(binary)
        raise AuthError("Install Google Chrome on this Mac to connect the meeting browser.")
    for name in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        binary = shutil.which(name)
        if binary and Path(binary).is_file() and os.access(binary, os.X_OK):
            return binary
    raise AuthError("Install Google Chrome or Chromium on this Linux desktop to connect the meeting browser.")


class NativeProfileLease:
    """Coordinate native authentication and recordings across runner processes."""
    def __init__(self, data_root):
        if fcntl is None:
            raise AuthError("Native browser sign-in requires operating-system file locking.")
        self.credentials = Path(data_root) / "credentials"
        self.credentials.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.credentials.is_symlink() or not self.credentials.is_dir():
            raise AuthError("Browser credentials must be a private regular directory.")
        self.credentials.chmod(0o700)
        self.profile = self.credentials / "meet-native-profile"
        self.marker = self.credentials / "meet-native-profile.json"
        lock = self.credentials / "meet-native-profile.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self.file = os.fdopen(fd, "a+")
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.profile.is_symlink() or (self.profile.exists() and not self.profile.is_dir()):
                raise AuthError("The meeting browser profile must be a private regular directory.")
            if self.marker.is_symlink():
                raise AuthError("The meeting browser account marker cannot be a symbolic link.")
            self.profile.mkdir(mode=0o700, exist_ok=True)
            self.profile.chmod(0o700)
            recover_stale_browser_lock(self.profile)
        except BaseException as error:
            self.file.close()
            if isinstance(error, BlockingIOError):
                raise AuthError("The meeting browser is already in use. Close its sign-in or recording first.") from None
            raise

    def close(self):
        if not self.file.closed:
            fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()


def recover_stale_browser_lock(profile):
    """Remove only a conclusively dead local Chrome lock while holding our lease.

    Chrome's POSIX lock is a hostname-PID symlink. Unknown lock formats, remote
    hosts, permission failures, and even a reused live PID all fail closed.
    """
    lock = profile / "SingletonLock"
    try:
        original = lock.lstat()
    except FileNotFoundError:
        return
    message = ("Close the dedicated meeting Chrome browser before connecting it again. "
               "If it has crashed, restart this computer and retry. Locks from another "
               "computer or an unknown owner require manual recovery of only Echo's "
               "credentials/meet-native-profile; do not remove an active browser's lock.")
    if (not stat.S_ISLNK(original.st_mode) or original.st_uid != os.getuid()
            or profile.stat().st_uid != os.getuid()):
        raise AuthError(message)
    target = os.readlink(lock)
    host, separator, identifier = target.rpartition("-")
    if (not separator or host != socket.gethostname() or len(identifier) > 10 or not identifier.isascii()
            or not identifier.isdigit() or not 0 < int(identifier) <= 2_147_483_647):
        raise AuthError(message)
    try:
        os.kill(int(identifier), 0)
    except ProcessLookupError:
        pass
    except (PermissionError, OSError):
        raise AuthError(message) from None
    else:
        raise AuthError(message)
    # Another process changing the lock invalidates our evidence; never follow
    # symlinks or remove a lock whose identity differs from what we inspected.
    current = lock.lstat()
    if ((current.st_dev, current.st_ino, current.st_uid, current.st_mode)
            != (original.st_dev, original.st_ino, original.st_uid, original.st_mode)
            or os.readlink(lock) != target):
        raise AuthError(message)
    lock.unlink()


def block_media_preferences(profile):
    """Block devices before the normal, non-automated browser starts."""
    default = profile / "Default"
    if default.is_symlink():
        raise AuthError("The meeting browser preferences must remain in its private profile.")
    default.mkdir(mode=0o700, exist_ok=True)
    prefs = default / "Preferences"
    if prefs.is_symlink():
        raise AuthError("The meeting browser preferences cannot be a symbolic link.")
    try:
        data = json.loads(prefs.read_text()) if prefs.exists() else {}
        if not isinstance(data, dict):
            raise ValueError()
        data["credentials_enable_service"] = False
        settings = data.setdefault("profile", {})
        settings["password_manager_enabled"] = False
        defaults = settings.setdefault("default_content_setting_values", {})
        exceptions = settings.setdefault("content_settings", {}).setdefault("exceptions", {})
        for name in ("media_stream_camera", "media_stream_mic"):
            defaults[name] = 2
            exceptions.pop(name, None)
    except (OSError, ValueError, TypeError, AttributeError):
        raise AuthError("The private browser preferences could not be read safely.") from None
    pending = default / ("Preferences." + uuid.uuid4().hex + ".pending")
    try:
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(data, output)
        pending.replace(prefs)
    finally:
        pending.unlink(missing_ok=True)


def native_persistent_context(playwright, profile, executable=None, sink=None):
    """Verification/recording uses ordinary Playwright, without hiding automation."""
    return playwright.chromium.launch_persistent_context(
        str(profile), executable_path=executable or chrome_executable(), headless=False,
        accept_downloads=False, locale="en-US", viewport=None,
        # Keep normal Chrome's OS secure-storage backend on both platforms.
        # Playwright's mock/basic stores cannot decrypt the saved real cookies.
        ignore_default_args=["--mute-audio", "--password-store=basic", "--use-mock-keychain"],
        env=dict(os.environ, **({"PULSE_SINK": sink} if sink and sys.platform == "linux" else {})),
        args=["--deny-permission-prompts", "--disable-sync", "--autoplay-policy=no-user-gesture-required"] + desktop_arguments())


def native_browser_pid(context):
    """Identify only the top-level process attached to this owned context."""
    if not context.browser:
        raise AuthError("The dedicated meeting browser process could not be identified.")
    session = context.browser.new_browser_cdp_session()
    try:
        processes = session.send("SystemInfo.getProcessInfo")["processInfo"]
        identifiers = [entry.get("id") for entry in processes if entry.get("type") == "browser"]
        if len(identifiers) != 1 or type(identifiers[0]) is not int or identifiers[0] <= 0:
            raise AuthError("The dedicated meeting browser process could not be identified.")
        return identifiers[0]
    finally:
        session.detach()


def verification_error(page, error):
    """Explain failed proof using only a known hostname; never expose login URLs."""
    if not str(error).startswith("The recording browser could not verify the connected Google account."):
        return error
    location = urlparse(page.url)
    host = location.hostname if location.scheme == "https" else None
    if host == "accounts.google.com":
        return AuthError("Google sign-in is incomplete or was blocked. Reopen the meeting browser, complete Google sign-in, then return to save the session.")
    if host == "workspace.google.com":
        return AuthError("Google redirected the browser away from Meet. Reopen the meeting browser and complete sign-in before saving the session.")
    if host == "meet.google.com":
        return AuthError("Google Meet did not show a verifiable account control. Reopen the meeting browser, confirm the connected Calendar account is active in Meet, then save again.")
    return AuthError("The meeting browser could not verify a signed-in Google Meet account. Reopen it and complete sign-in before saving the session.")


class NativeAuthManager:
    """Own one browser process; credentials are entered only in its native window."""
    def __init__(self, data_root):
        self.root = Path(data_root)
        self.lock = threading.RLock()
        self.closed_ids = deque(maxlen=128)
        self.id = self.expected = self.thread = None
        self.commands = queue.Queue(maxsize=4)
        self.cancelled = threading.Event()
        self.email = self.read_marker()
        self.state = "signed_in" if self.email else "signed_out"
        self.detail = "Meeting browser session saved." if self.email else "Connect a dedicated browser on this computer."

    def read_marker(self):
        folder = self.root / "credentials"
        marker = folder / "meet-native-profile.json"
        try:
            if folder.is_symlink() or marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 4096:
                return None
            data = json.loads(marker.read_text())
            return email_address(data["email"]) if data.get("version") == 1 else None
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def status(self):
        with self.lock:
            return {"mode": "native_window", "state": self.state, "detail": self.detail,
                    **({"sessionId": self.id} if self.id else {}),
                    **({"expectedEmail": self.expected} if self.expected else {}),
                    **({"email": self.email} if self.email else {})}

    def start(self, email, identifier=None):
        email = email_address(email)
        identifier = session_id(identifier) if identifier is not None else str(uuid.uuid4())
        executable = chrome_executable()
        with self.lock:
            if identifier in self.closed_ids:
                raise AuthError("This browser sign-in has ended. Start a new sign-in.")
            if self.id:
                if self.id == identifier and self.expected == email:
                    return self.status()
                raise AuthError("A meeting browser sign-in is already active.")
            lease = NativeProfileLease(self.root)
            try:
                block_media_preferences(lease.profile)
                lease.marker.unlink(missing_ok=True)
                self.id, self.expected, self.email = identifier, email, None
                self.state, self.detail = "signing_in", "Complete Google sign-in in the separate Chrome window, then return and finish connecting."
                self.cancelled = threading.Event()
                self.commands = queue.Queue(maxsize=4)
                self.thread = threading.Thread(target=self._run, args=(lease, executable, identifier), daemon=True)
                self.thread.start()
            except BaseException:
                lease.close()
                self.id = self.expected = None
                self.state, self.detail = "error", "The dedicated browser could not open. Try connecting again."
                raise
            return self.status()

    def command(self, identifier, kind, value=None):
        identifier = session_id(identifier)
        if kind != "finish":
            raise AuthError("Use the separate Chrome window to complete sign-in.")
        with self.lock:
            if self.id != identifier or self.cancelled.is_set():
                raise AuthError("This browser sign-in is no longer active.")
            future = Future()
            try:
                self.commands.put_nowait(future)
            except queue.Full:
                raise AuthError("The browser is busy finishing sign-in.") from None
        try:
            return future.result(timeout=45)
        except TimeoutError:
            self.cancel(identifier, wait=False)
            raise AuthError("Browser verification timed out. Start a new connection.") from None

    def cancel(self, identifier, wait=True):
        identifier = session_id(identifier)
        with self.lock:
            if identifier not in self.closed_ids:
                self.closed_ids.append(identifier)
            thread = self.thread if self.id == identifier else None
            if thread:
                self.cancelled.set()
        if thread and wait:
            thread.join(timeout=30)
            if thread.is_alive():
                raise AuthError("The meeting browser is still closing. Wait before starting another connection.")
        return self.status()

    def forget(self):
        with self.lock:
            if self.id:
                raise AuthError("Cancel browser sign-in before disconnecting its session.")
            lease = NativeProfileLease(self.root)
            try:
                lease.marker.unlink(missing_ok=True)
                shutil.rmtree(lease.profile)
                self.state, self.email, self.expected = "signed_out", None, None
                self.detail = "The dedicated browser session was removed."
            finally:
                lease.close()
            return self.status()

    def recording_lease(self, expected):
        expected = email_address(expected)
        with self.lock:
            if self.id or self.state != "signed_in" or self.email != expected:
                raise AuthError("Connect the meeting browser with the connected Calendar account before recording.")
            lease = NativeProfileLease(self.root)
            if self.read_marker() != expected:
                lease.close()
                raise AuthError("Connect the meeting browser again before recording.")
            return lease

    def expired(self):
        with self.lock:
            self.state, self.detail = "expired", "The saved Google session could not be verified. Connect the meeting browser again."

    def shutdown(self):
        with self.lock:
            identifier = self.id
        if identifier:
            try:
                self.cancel(identifier)
            except AuthError:
                pass

    @staticmethod
    def _close_owned(process):
        """Signal only the Popen child we own; never killall or a user's browser."""
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            raise AuthError("The dedicated Chrome window did not close. Close that window and try again.") from None

    def _verify(self, lease, executable):
        from playwright.sync_api import sync_playwright
        context = playwright = None
        actual = None
        try:
            playwright = sync_playwright().start()
            context = native_persistent_context(playwright, lease.profile, executable)
            page = context.pages[0] if context.pages else context.new_page()
            _guard = deny_capture(context, page, "https://meet.google.com", persistent=True)
            if self.cancelled.is_set():
                raise AuthError("Browser sign-in was cancelled.")
            page.goto(START_URL, wait_until="domcontentloaded", timeout=15_000)
            verify_receive_only(page)
            try:
                actual = require_account(page, self.expected, timeout=8)
            except AuthError as error:
                raise verification_error(page, error) from None
        finally:
            try:
                if context:
                    close_context(context)
            finally:
                if playwright:
                    playwright.stop()
        return actual

    def _run(self, lease, executable, identifier):
        process = terminal = verified = None
        commands = self.commands
        try:
            if self.cancelled.is_set():
                raise AuthError("Browser sign-in was cancelled.")
            process = subprocess.Popen(
                [executable, "--user-data-dir=" + str(lease.profile), "--no-first-run",
                 "--no-default-browser-check", "--deny-permission-prompts", "--disable-sync", "--new-window", *desktop_arguments(), LOGIN_URL],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            deadline = time.monotonic() + 600
            while not self.cancelled.is_set():
                if process.poll() not in (None, 0):
                    raise AuthError("Chrome could not start. Run the local meeting runner from your logged-in desktop session, then reconnect the browser.")
                if time.monotonic() >= deadline:
                    raise AuthError("Browser connection expired after ten minutes. Connect again.")
                try:
                    terminal = commands.get(timeout=0.1)
                except queue.Empty:
                    continue
                if not terminal.set_running_or_notify_cancel():
                    terminal = None
                    continue
                self._close_owned(process)
                process = None
                if not self.cancelled.is_set():
                    verified = self._verify(lease, executable)
                break
        except Exception as error:
            with self.lock:
                self.state, self.email = "error", None
                self.detail = str(error) if isinstance(error, AuthError) else "The dedicated browser could not complete sign-in. Try connecting again."
        finally:
            # A still-running child retains the lease. Do not delete/reopen a live
            # profile after a timeout; only its eventual exit makes that safe.
            if process:
                try:
                    self._close_owned(process)
                except AuthError:
                    with self.lock:
                        self.state, self.detail = "error", "Close the dedicated Chrome window to finish cancelling sign-in."
                    if terminal and not terminal.done():
                        terminal.set_exception(AuthError(self.detail))
                    process.wait()
            with self.lock:
                successful = False
                if verified and not self.cancelled.is_set() and identifier not in self.closed_ids:
                    pending = lease.credentials / ("meet-native-profile." + uuid.uuid4().hex + ".pending")
                    try:
                        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, "w") as output:
                            json.dump({"version": 1, "email": verified}, output)
                            output.flush()
                            os.fsync(output.fileno())
                        pending.replace(lease.marker)
                        self.state, self.email, self.detail = "signed_in", verified, "Meeting browser connected. Its account is checked before every recording."
                        successful = True
                    except OSError:
                        self.state, self.detail = "error", "The private browser session could not be saved. Connect again."
                    finally:
                        pending.unlink(missing_ok=True)
                if not successful:
                    lease.marker.unlink(missing_ok=True)
                    self.email = None
                    if self.cancelled.is_set():
                        self.state, self.detail = "signed_out", "Browser connection cancelled."
                if identifier not in self.closed_ids:
                    self.closed_ids.append(identifier)
                self.id = self.expected = None
                lease.close()
                status = self.status()
            if terminal and not terminal.done():
                if successful:
                    terminal.set_result(status)
                else:
                    terminal.set_exception(AuthError(status["detail"]))
            while not commands.empty():
                try:
                    future = commands.get_nowait()
                    if not future.done():
                        future.set_exception(AuthError("The browser connection has ended."))
                except queue.Empty:
                    break
