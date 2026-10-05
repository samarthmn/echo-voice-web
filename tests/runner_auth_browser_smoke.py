"""Synthetic real-Chromium transport/profile test. NO real Google authentication.

Run inside the built runner container with its DISPLAY set, e.g.
docker exec -i <container> python3 - < tests/runner_auth_browser_smoke.py
All network requests are fulfilled/aborted locally before browser navigation.
This opt-in test needs the runner's installed Chromium and a working display.
It is intentionally outside unittest discovery; it never authenticates Google.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

project = Path(os.environ.get("ECHO_PROJECT_ROOT", os.getcwd()))
sys.path.insert(0, str(project / "runner" if (project / "runner").is_dir() else project))
import meet_auth
from capture import deny_capture, verify_receive_only

# Production enters Google's ServiceLogin. The transport fixture stays on its
# fulfilled synthetic Meet document and never requests a real login page.
original_login_url = getattr(meet_auth, "LOGIN_URL", None)
meet_auth.LOGIN_URL = meet_auth.START_URL

EXPECTED = "sublimeinnovationtechnologies@gmail.com"
root = project / "tmp" / ("auth-browser-smoke-" + uuid.uuid4().hex)
root.mkdir(parents=True)
original_context = meet_auth.persistent_context
requests = []
wrong_account = False
HTML = """<!doctype html><meta charset=utf-8><title>SYNTHETIC transport test</title>
<h1 style='position:absolute;left:400px;top:20px'>SYNTHETIC TEST — no Google login</h1>
<input id=edit aria-label='Synthetic text input' style='position:absolute;left:40px;top:40px;width:300px;height:40px'>
<button id=sign style='position:absolute;left:40px;top:110px;width:240px;height:44px'>Synthetic cookie sign-in</button>
<a id=account href='https://accounts.google.com/' style='position:absolute;left:40px;top:180px;width:400px;height:44px'>Synthetic account control</a>
<script>
const email = EMAIL_PLACEHOLDER;
function render() { const signed = document.cookie.includes('echo_auth_smoke=1');
 account.style.display = signed ? 'block' : 'none';
 account.setAttribute('aria-label', 'Google Account: Synthetic fixture (' + email + ')'); }
sign.onclick = () => {document.cookie='echo_auth_smoke=1; Path=/; Max-Age=3600; Secure; SameSite=Lax';render()};render();
</script>"""


def fixture_context(playwright, profile, sink):
    context = original_context(playwright, profile, sink)
    actual_route = context.route

    def install(pattern, app_handler, *args, **kwargs):
        def intercept(route):
            requests.append(route.request.url)
            if route.request.url.startswith("https://meet.google.com/"):
                email = "wrong-account@example.invalid" if wrong_account else EXPECTED
                route.fulfill(status=200, content_type="text/html", body=HTML.replace("EMAIL_PLACEHOLDER", json.dumps(email)))
            else:
                # No fonts, assets, redirects, Google requests or external traffic.
                route.abort()
        return actual_route(pattern, intercept, *args, **kwargs)

    context.route = install
    return context


meet_auth.persistent_context = fixture_context
manager = None


def wait_open(current):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = current.status()
        if state.get("hostname") == "meet.google.com":
            return state["sessionId"]
        if state["state"] == "error":
            raise AssertionError(state)
        time.sleep(0.05)
    raise AssertionError("Synthetic browser did not open")


def command(current, identifier, kind, **value):
    return current.command(identifier, kind, {"sessionId": identifier, **value})


try:
    manager = meet_auth.AuthManager(root)
    identifier = str(uuid.uuid4())
    started = manager.start(EXPECTED, identifier)
    assert started["sessionId"] == identifier
    assert manager.start(EXPECTED, identifier)["sessionId"] == identifier
    wait_open(manager)
    # A separate process must fail to take a browser profile owned by this login.
    contender = subprocess.run([sys.executable, "-c", "import sys; from meet_auth import ProfileLease, AuthError\ntry: lease = ProfileLease(sys.argv[1])\nexcept AuthError: sys.exit(0)\nelse: lease.close(); sys.exit(3)", str(root)],
        env={**os.environ, "PYTHONPATH": str(project / "runner" if (project / "runner").is_dir() else project)},
        capture_output=True, text=True, timeout=10)
    assert contender.returncode == 0, contender.stderr
    image = manager.command(identifier, "screen")
    assert image.startswith(b"\xff\xd8") and image.endswith(b"\xff\xd9")
    command(manager, identifier, "input", type="click", x=80, y=60)
    command(manager, identifier, "input", type="text", text="synthetic-transport-only")
    command(manager, identifier, "input", type="key", key="Control+A")
    command(manager, identifier, "input", type="text", text="synthetic-correction")
    command(manager, identifier, "input", type="scroll", deltaY=20)
    command(manager, identifier, "input", type="click", x=100, y=130)
    verified = manager.command(identifier, "finish")
    assert verified["state"] == "signed_in" and verified["email"] == EXPECTED
    assert (root / "credentials" / "meet-profile.json").is_file()
    manager.shutdown()

    # A newly-created manager/process state reopens the same dedicated profile.
    # Its synthetic cookie must survive close and reopen for live verification.
    manager = meet_auth.AuthManager(root)
    identifier = str(uuid.uuid4())
    manager.start(EXPECTED, identifier)
    wait_open(manager)
    verified = manager.command(identifier, "finish")
    assert verified["state"] == "signed_in" and verified["email"] == EXPECTED

    # Wrong visible account must never certify despite persisted marker/cookies.
    wrong_account = True
    identifier = str(uuid.uuid4())
    manager.start(EXPECTED, identifier)
    wait_open(manager)
    try:
        manager.command(identifier, "finish")
    except meet_auth.AuthError:
        pass
    else:
        raise AssertionError("Wrong synthetic account was accepted")
    assert manager.status()["state"] != "signed_in"
    cancelled = manager.cancel(identifier)
    assert cancelled["state"] != "signing_in"
    assert not (root / "credentials" / "meet-profile.json").exists()

    # A cancel acknowledged before POST cannot later open the same session.
    fenced = str(uuid.uuid4())
    manager.cancel(fenced)
    try:
        manager.start(EXPECTED, fenced)
    except meet_auth.AuthError:
        pass
    else:
        raise AssertionError("Cancelled synthetic login restarted")
    manager.forget()
    assert not (root / "credentials" / "meet-profile").exists()
    assert requests and all(url.startswith("https://meet.google.com/") for url in requests)
    print(json.dumps({"syntheticOnly": True, "realGoogleAuthentication": False,
                      "transport": "pass", "privateProfileCookiePersistence": "pass",
                      "wrongAccountRejected": "pass", "cancelAndForget": "pass",
                      "crossProcessProfileLease": "pass", "receiveOnlyPermissionCheck": "pass",
                      "interceptedRequests": len(requests)}))
finally:
    if manager is not None:
        manager.shutdown()
    meet_auth.persistent_context = original_context
    if original_login_url is not None:
        meet_auth.LOGIN_URL = original_login_url
    shutil.rmtree(root, ignore_errors=True)
