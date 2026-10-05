"""Opt-in native installed-browser smoke; NO Google login or audio capture.

Run from the project root in a desktop session:
    runner/.venv/bin/python -B tests/native_auth_browser_smoke.py --run

Only an owned disposable profile is opened. The synthetic HTTPS Meet document is
fulfilled locally; all other page requests are aborted. This exercises production
native launch, secure storage, PID identification, and receive-only controls; it
cannot certify Google acceptance, actual account login, or audio isolation.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runner"))

EXPECTED = "native-smoke@example.invalid"
URL = "https://meet.google.com/"
HTML = """<!doctype html><meta charset=utf-8><title>Echo synthetic native browser check</title>
<h1>Synthetic test — no Google login</h1>
<a href="https://accounts.google.com/" aria-label="Google Account: Native fixture (native-smoke@example.invalid)">Synthetic account</a>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Open and close only a disposable native browser profile")
    if not parser.parse_args().run:
        parser.error("Pass --run to explicitly open the synthetic desktop browser.")
    from playwright.sync_api import sync_playwright
    from native_auth import block_media_preferences, native_browser_pid, native_persistent_context
    from meet_auth import AuthError, close_context, require_account
    from capture import deny_capture, verify_receive_only

    (ROOT / "tmp").mkdir(exist_ok=True)
    requests = []
    with tempfile.TemporaryDirectory(prefix="native-auth-browser-smoke-", dir=ROOT / "tmp") as directory:
        scratch = Path(directory)
        profile = scratch / "profile"
        profile.mkdir(mode=0o700)
        block_media_preferences(profile)
        # Keep driver/browser scratch in this owned directory too.
        prior_temp = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(scratch)
        playwright = context = None
        try:
            playwright = sync_playwright().start()
            for iteration in range(2):
                context = native_persistent_context(playwright, profile)
                context.set_default_timeout(5_000)

                def intercept(route):
                    requests.append(route.request.url)
                    if route.request.url == URL:
                        route.fulfill(status=200, content_type="text/html", body=HTML)
                    else:
                        route.abort()

                context.route("**/*", intercept)
                page = context.pages[0] if context.pages else context.new_page()
                guard = deny_capture(context, page, URL.rstrip("/"), persistent=True)
                page.goto(URL, wait_until="domcontentloaded", timeout=10_000)
                verify_receive_only(page)
                assert require_account(page, EXPECTED, timeout=1) == EXPECTED
                pid = native_browser_pid(context)
                assert pid > 1 and pid != os.getpid()
                # Match the CDP-selected process against the exact owned profile;
                # never enumerate or touch everyday browser profiles/processes.
                process = subprocess.run(["ps", "-p", str(pid), "-o", "args="],
                                         capture_output=True, text=True, timeout=5, check=True)
                assert "--user-data-dir=" + str(profile) in process.stdout, "PID does not own the test profile"
                if iteration == 0:
                    page.evaluate("document.cookie='echo_native_smoke=1; Max-Age=3600; Path=/; Secure; SameSite=Lax'")
                assert page.evaluate("document.cookie.includes('echo_native_smoke=1')"), "Synthetic persistent cookie was lost"
                cookies = context.cookies(URL)
                assert any(cookie["name"] == "echo_native_smoke" and cookie["secure"] and cookie["expires"] > 0 for cookie in cookies)
                page.locator("a[aria-label]").evaluate("node => node.setAttribute('aria-label', 'Google Account: Wrong fixture (wrong@example.invalid)')")
                try:
                    require_account(page, EXPECTED, timeout=1)
                except AuthError:
                    pass
                else:
                    raise AssertionError("Wrong visible account was accepted")
                close_context(context)
                context = None
                guard = None
            print(json.dumps({"syntheticOnly": True, "realGoogleAuthentication": False,
                              "platform": sys.platform, "installedBrowserLaunch": "pass",
                              "privateProfileCookiePersistence": "pass", "ownedBrowserPid": "pass",
                              "wrongAccountRejected": "pass", "receiveOnlyPermissionCheck": "pass",
                              "interceptedRequests": len(requests), "audioCapture": "not_tested"}))
        finally:
            try:
                if context:
                    close_context(context)
            finally:
                try:
                    if playwright:
                        playwright.stop()
                finally:
                    if prior_temp is None:
                        os.environ.pop("TMPDIR", None)
                    else:
                        os.environ["TMPDIR"] = prior_temp


if __name__ == "__main__":
    main()
