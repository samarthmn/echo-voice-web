"""Private persistent Meet sign-in with a thread-owned, bounded remote viewer."""
from concurrent.futures import Future, TimeoutError
import asyncio
from contextlib import contextmanager
from collections import deque
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import threading
import time
from urllib.parse import urlparse
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

from capture import browser_options, deny_capture, verify_receive_only

START_URL = "https://meet.google.com/?hl=en"
# Fixed sign-in destination published by Google Meet's own marketing page.
# Direct unsigned Meet home navigation can redirect to Workspace marketing.
LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%3Fhs%3D193&ec=wgc-meet-%5Bmodule%5D-signin&ltmpl=meet"
AUTH_HOSTS = {"meet.google.com", "accounts.google.com"}
WIDTH, HEIGHT = 1280, 900
KEYS = {"Enter", "Tab", "Shift+Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Control+A", "Meta+A"}
EMAIL = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class AuthError(RuntimeError):
    """A safe, actionable auth failure suitable for the private runner API."""


def email_address(value):
    """Keep the server-verified account an exact normalized mailbox identity."""
    if not isinstance(value, str) or len(value) > 254 or not EMAIL.fullmatch(value):
        raise ValueError("A connected Google Calendar account is required.")
    return value.lower()


def session_id(value):
    """Accept canonical random IDs only, never paths or destinations."""
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise ValueError("A valid recording-browser sign-in ID is required.") from None
    if str(parsed) != value or parsed.version != 4:
        raise ValueError("A valid recording-browser sign-in ID is required.")
    return value


def input_command(value):
    """Allow page interactions only; no JavaScript, URLs or browser shortcuts."""
    if not isinstance(value, dict):
        raise ValueError("Provide a recording-browser input command.")
    kind = value.get("type")
    fields = {"click": {"x", "y"}, "key": {"key"}, "text": {"text"}, "scroll": {"deltaY"}}
    if kind not in fields or set(value) != fields[kind] | {"type", "sessionId"}:
        raise ValueError("Unsupported recording-browser input command.")
    session_id(value["sessionId"])
    if kind == "click":
        if any(type(value[key]) not in (int, float) or not math.isfinite(value[key]) for key in ("x", "y")) or not (0 <= value["x"] < WIDTH and 0 <= value["y"] < HEIGHT):
            raise ValueError("The click must remain inside the recording browser.")
    elif kind == "key":
        if value["key"] not in KEYS:
            raise ValueError("That browser shortcut is not allowed.")
    elif kind == "text":
        if not isinstance(value["text"], str) or not 0 < len(value["text"]) <= 4096 or "\x00" in value["text"]:
            raise ValueError("Enter at most 4096 characters.")
    elif type(value["deltaY"]) not in (int, float) or not math.isfinite(value["deltaY"]) or not -2000 <= value["deltaY"] <= 2000:
        raise ValueError("Scroll by at most 2000 pixels.")
    return value


class ProfileLease:
    """One OS lock protects this account profile across auth, recordings and processes."""
    def __init__(self, data_root):
        if fcntl is None:
            raise AuthError("The recording browser requires a Linux runner with file locking.")
        self.credentials = Path(data_root) / "credentials"
        self.credentials.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.credentials.is_symlink() or not self.credentials.is_dir():
            raise AuthError("Recording-browser credentials must be a private regular directory.")
        self.credentials.chmod(0o700)
        self.profile = self.credentials / "meet-profile"
        self.marker = self.credentials / "meet-profile.json"
        lock_path = self.credentials / "meet-profile.lock"
        if lock_path.is_symlink():
            raise AuthError("The recording-browser lock cannot be a symbolic link.")
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self.file = os.fdopen(descriptor, "a+")
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.profile.is_symlink() or (self.profile.exists() and not self.profile.is_dir()):
                raise AuthError("The recording-browser profile must be a private regular directory.")
            self.profile.mkdir(mode=0o700, exist_ok=True)
            self.profile.chmod(0o700)
        except BaseException as error:
            self.file.close()
            if isinstance(error, BlockingIOError):
                raise AuthError("The recording browser is already used by a sign-in or recording. Stop it before continuing.") from None
            raise

    def close(self):
        """Release only this lease, retaining the reusable private profile."""
        if not self.file.closed:
            fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()


def account_email(page):
    """Trust only the visible Google account control on the actual HTTPS Meet site."""
    location = urlparse(page.url)
    if location.scheme != "https" or location.netloc != "meet.google.com":
        return None
    # The Google top-bar account link includes its active account in an aria label.
    # Ordinary text, participant names, hidden account lists and page body content
    # cannot certify an identity. Never read cookies, tokens or password inputs.
    labels = page.evaluate(r"""() => Array.from(document.querySelectorAll('a[aria-label],button[aria-label],[role=button][aria-label]'))
        .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
        .filter(node => /^Google Account:/i.test(node.getAttribute('aria-label') || ''))
        .filter(node => node.tagName !== 'A' || /^https:\/\/accounts\.google\.com\//.test(node.href))
        .map(node => node.getAttribute('aria-label')).slice(0, 4)""")
    addresses = set()
    for label in labels:
        found = re.findall(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", str(label))
        if len(found) != 1:
            return None
        addresses.add(email_address(found[0]))
    return next(iter(addresses)) if len(addresses) == 1 else None


def require_account(page, expected, timeout=10):
    """Verify live identity on Meet before certification or entry; fail closed."""
    deadline = time.monotonic() + timeout
    while True:
        actual = account_email(page)
        if actual:
            if not secrets.compare_digest(actual, expected):
                raise AuthError("The dedicated recording browser is signed in to a different Google account. Sign out there and use the connected Calendar account.")
            return actual
        if time.monotonic() >= deadline:
            raise AuthError("The recording browser could not verify the connected Google account. Finish signing in, then try again.")
        page.wait_for_timeout(250)


def trusted_auth_page(page):
    """Login transport cannot control or expose another web origin."""
    location = urlparse(page.url)
    return location.scheme == "https" and location.netloc in AUTH_HOSTS


def persistent_context(playwright, profile, sink):
    """Launch only our dedicated headed browser, retaining account cookies locally."""
    return playwright.chromium.launch_persistent_context(str(profile), **browser_options(sink, False),
        locale="en-US", viewport={"width": WIDTH, "height": HEIGHT}, accept_downloads=False)


def close_context(context):
    """Bound persistent profile flushing on the same Playwright owner thread.

    Playwright 1.63's public close has no timeout argument. Its pinned sync
    dispatcher can await the same close coroutine with an explicit deadline.
    Failure never certifies the profile or enables meeting entry.
    """
    context._sync(asyncio.wait_for(context._impl_obj.close(), timeout=5))


class AuthManager:
    """Expose screenshots/input through a queue on the sole Playwright owner thread."""
    def __init__(self, data_root):
        self.root = Path(data_root)
        self.lock = threading.RLock()
        self.state, self.email, self.expected, self.detail = "signed_out", None, None, "Sign in to the dedicated recording browser."
        self.id, self.hostname, self.thread = None, None, None
        self.cancelled_id = None
        self.commands = queue.Queue(maxsize=16)
        self.closed_ids = deque(maxlen=128)
        marker = self.read_marker()
        if marker:
            self.state, self.email = "signed_in", marker
            self.detail = "Google session saved. Its account is verified live before each recording."

    def read_marker(self):
        """A saved marker supplies an identity hint, never proof of a live login."""
        folder = self.root / "credentials"
        marker = folder / "meet-profile.json"
        try:
            if folder.is_symlink() or marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 4096:
                return None
            value = json.loads(marker.read_text(encoding="utf8"))
            return email_address(value["email"]) if value.get("version") == 1 else None
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def status(self):
        """Return no login secrets or URL query parameters."""
        with self.lock:
            return {"state": self.state, "detail": self.detail,
                    **({"email": self.email} if self.email else {}),
                    **({"expectedEmail": self.expected} if self.expected else {}),
                    **({"sessionId": self.id} if self.id else {}),
                    **({"hostname": self.hostname} if self.hostname else {})}

    def start(self, email, identifier=None):
        """Reserve the profile before returning an idempotent active auth identity."""
        email = email_address(email)
        identifier = session_id(identifier) if identifier is not None else str(uuid.uuid4())
        with self.lock:
            if identifier in self.closed_ids:
                raise AuthError("This recording-browser sign-in was cancelled or finished. Start a new sign-in.")
            if self.id:
                if self.id == identifier and self.expected == email:
                    return self.status()
                raise AuthError("A recording-browser sign-in is already active.")
            lease = ProfileLease(self.root)
            try:
                if lease.marker.is_symlink():
                    raise AuthError("The recording-browser account marker cannot be a symbolic link.")
                lease.marker.unlink(missing_ok=True)
                self.state, self.email, self.expected, self.id = "signing_in", None, email, identifier
                self.cancelled_id = None
                self.hostname, self.detail = None, "Opening the dedicated recording browser."
                self.commands = queue.Queue(maxsize=16)
                self.thread = threading.Thread(target=self._run, args=(lease, identifier), daemon=True)
                self.thread.start()
            except BaseException:
                lease.close()
                self.state, self.id, self.expected = "error", None, None
                self.detail = "The recording browser could not start. Try sign-in again."
                raise
            return self.status()

    def command(self, identifier, kind, value=None):
        """Validate ownership twice and bound both queue depth and HTTP waiting."""
        identifier = session_id(identifier)
        with self.lock:
            if self.id != identifier or self.state != "signing_in" or (kind != "cancel" and self.cancelled_id == identifier):
                raise AuthError("This recording-browser sign-in is no longer active.")
            future = Future()
            try:
                self.commands.put_nowait((identifier, kind, value, future))
            except queue.Full:
                raise AuthError("The recording browser is busy. Try the action again.") from None
        try:
            return future.result(timeout=45 if kind == "finish" else 30 if kind == "cancel" else 15)
        except TimeoutError:
            future.cancel()
            if kind == "finish":
                with self.lock:
                    self.cancelled_id = identifier
                    if identifier not in self.closed_ids:
                        self.closed_ids.append(identifier)
            raise AuthError("The recording browser did not respond in time. Retry or cancel sign-in.") from None

    def cancel(self, identifier):
        """Fence a lost/prestart request without cancelling another active session."""
        identifier = session_id(identifier)
        with self.lock:
            if identifier not in self.closed_ids:
                self.closed_ids.append(identifier)
            active = self.id == identifier
            if active:
                self.cancelled_id = identifier
        return self.command(identifier, "cancel") if active else self.status()

    def forget(self):
        """Remove only our private idle profile; never touch Calendar credentials."""
        with self.lock:
            if self.id:
                raise AuthError("Cancel the recording-browser sign-in before signing out.")
            lease = ProfileLease(self.root)
            try:
                if lease.marker.is_symlink():
                    raise AuthError("The recording-browser account marker cannot be a symbolic link.")
                lease.marker.unlink(missing_ok=True)
                shutil.rmtree(lease.profile)
                self.state, self.email, self.expected = "signed_out", None, None
                self.detail = "The dedicated recording browser is signed out."
            finally:
                lease.close()
            return self.status()

    def recording_lease(self, expected):
        """Require a certified matching account plus exclusive access before launch."""
        expected = email_address(expected)
        with self.lock:
            if self.id or self.state != "signed_in" or self.email != expected:
                raise AuthError("Sign in to the dedicated recording browser with the connected Calendar account before recording.")
            lease = ProfileLease(self.root)
            if self.read_marker() != expected:
                lease.close()
                raise AuthError("Verify the recording-browser Google account again before recording.")
            return lease

    def expired(self):
        """Invalidate certification after a failed live prejoin account check."""
        with self.lock:
            self.state, self.detail = "expired", "The saved recording-browser account could not be verified. Open it and sign in again."

    def shutdown(self):
        """Close auth through its owner thread before shutting down the runner."""
        with self.lock:
            identifier, thread = self.id, self.thread
        if identifier:
            try:
                self.cancel(identifier)
            except AuthError:
                pass
        if thread:
            thread.join(timeout=15)

    def _run(self, lease, identifier):
        """Never execute a Playwright operation from HTTP handler threads."""
        context, terminal, successful, playwright, verified = None, None, False, None, None
        commands = self.commands
        idle_deadline = time.monotonic() + 600
        try:
            from playwright.sync_api import sync_playwright
            playwright = sync_playwright().start()
            context = persistent_context(playwright, lease.profile, "")
            # Only fixed Google sign-in/Meet top-level destinations are
            # allowed. Resource requests still load normal Google assets.
            def navigation(route):
                request = route.request
                target = urlparse(request.url)
                if request.is_navigation_request() and request.frame.parent_frame is None and (target.scheme != "https" or target.netloc not in AUTH_HOSTS):
                    route.abort()
                else:
                    route.continue_()
            context.route("**/*", navigation)
            page = context.pages[0] if context.pages else context.new_page()
            _guard = deny_capture(context, page, "https://meet.google.com", persistent=True)
            with self.lock:
                if self.cancelled_id == identifier:
                    self.state, self.detail = "signed_out", "Recording-browser sign-in was cancelled."
                    return
            page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=20_000)
            with self.lock:
                self.detail = "Sign in using the connected Calendar account, then select Finish sign-in."
            while True:
                with self.lock:
                    if self.cancelled_id == identifier:
                        self.state, self.email, self.detail = "signed_out", None, "Recording-browser sign-in was cancelled."
                        break
                pages = [candidate for candidate in context.pages if not candidate.is_closed()]
                if not pages:
                    raise AuthError("The recording browser closed. Start a new sign-in.")
                page = pages[-1]
                if not trusted_auth_page(page):
                    raise AuthError("The recording-browser login must remain on Google Meet or Google Accounts. Start a new sign-in.")
                with self.lock:
                    self.hostname = urlparse(page.url).hostname
                if time.monotonic() >= idle_deadline:
                    raise AuthError("Recording-browser sign-in expired after ten minutes without input. Start a new sign-in.")
                try:
                    requested_id, kind, value, future = commands.get(timeout=0.05)
                except queue.Empty:
                    page.wait_for_timeout(50)
                    continue
                if not future.set_running_or_notify_cancel():
                    continue
                if requested_id != identifier:
                    future.set_exception(AuthError("The recording-browser sign-in changed."))
                    continue
                try:
                    if kind == "screen":
                        future.set_result(page.screenshot(type="jpeg", quality=65, full_page=False, timeout=10_000))
                    elif kind == "input":
                        value = input_command(value)
                        idle_deadline = time.monotonic() + 600
                        if value["type"] == "click": page.mouse.click(value["x"], value["y"])
                        elif value["type"] == "key": page.keyboard.press(value["key"])
                        elif value["type"] == "text": page.keyboard.insert_text(value["text"])
                        else: page.mouse.wheel(0, value["deltaY"])
                        future.set_result(self.status())
                    elif kind == "finish":
                        page.goto(START_URL, wait_until="domcontentloaded", timeout=20_000)
                        verify_receive_only(page)
                        actual = require_account(page, self.expected)
                        close_context(context)
                        context = None
                        terminal, verified = future, actual
                        break
                    elif kind == "cancel":
                        terminal = future
                        with self.lock:
                            self.state, self.email, self.detail = "signed_out", None, "Recording-browser sign-in was cancelled."
                        break
                    else:
                        raise ValueError("Unsupported recording-browser command.")
                except (AuthError, ValueError) as error:
                    future.set_exception(error)
                except Exception:
                    future.set_exception(AuthError("The recording browser could not complete that action. Retry or cancel sign-in."))
        except Exception as error:
            with self.lock:
                if self.cancelled_id == identifier:
                    self.state, self.email, self.detail = "signed_out", None, "Recording-browser sign-in was cancelled."
                else:
                    self.state, self.email, self.detail = "error", None, str(error) if isinstance(error, AuthError) else "The recording browser stopped or sign-in expired. Start a new sign-in."
        finally:
            cleanup_ok = True
            if context:
                try: close_context(context)
                except Exception: cleanup_ok = False
            if playwright:
                try: playwright.stop()
                except Exception: cleanup_ok = False
            with self.lock:
                # Publish certification only after ALL browser cleanup. Cancel
                # and timed-out Finish remain fenceable until this atomic commit.
                if verified and cleanup_ok and self.cancelled_id != identifier and identifier not in self.closed_ids:
                    marker = lease.credentials / ("meet-profile." + uuid.uuid4().hex + ".pending")
                    try:
                        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(descriptor, "w") as output:
                            output.write(json.dumps({"version": 1, "email": verified}))
                            output.flush()
                            os.fsync(output.fileno())
                        marker.replace(lease.marker)
                        self.state, self.email, self.detail = "signed_in", verified, "The dedicated recording browser is signed in."
                        successful = True
                    except OSError:
                        self.state, self.email, self.detail = "error", None, "The private recording-browser session could not be saved. Try sign-in again."
                    finally:
                        marker.unlink(missing_ok=True)
                elif verified:
                    self.state, self.email, self.detail = "signed_out", None, "Sign-in was cancelled or browser cleanup did not finish. Start a new sign-in."
                if not successful:
                    lease.marker.unlink(missing_ok=True)
                lease.close()
                if identifier not in self.closed_ids:
                    self.closed_ids.append(identifier)
                self.id, self.expected, self.hostname = None, None, None
                terminal_status = self.status()
            while not commands.empty():
                try:
                    _id, _kind, _value, waiting = commands.get_nowait()
                    if not waiting.done():
                        if _kind == "cancel" and _id == identifier: waiting.set_result(terminal_status)
                        else: waiting.set_exception(AuthError("The recording-browser sign-in ended."))
                except queue.Empty: break
            if terminal and not terminal.done():
                if verified and not successful: terminal.set_exception(AuthError("The recording-browser sign-in was not saved. Try again."))
                else: terminal.set_result(terminal_status)
