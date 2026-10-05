"""Bounded receive-only Meet prejoin handling and private, sanitized diagnostics."""
import json
from contextlib import contextmanager
from pathlib import Path
import re
import time

from capture import verify_receive_only

JOIN = re.compile(r"^(Ask to join|Join now|Join meeting)$", re.I)
WITHOUT_DEVICES = re.compile(r"^(Continue|Use|Join) without (?:a |the )?(?:microphone|camera)(?: and (?:a |the )?(?:camera|microphone))?[.!]?$", re.I)
STATUSES = ("Ready to join?", "What's your name?", "Waiting to be let in", "Sign in to join",
            "Continue without microphone and camera", "Use without microphone and camera",
            "The meeting has ended", "No one responded")


def sanitized_label(value: str, limit: int = 100) -> str:
    """Keep control labels useful without exporting meeting links or account addresses."""
    value = re.sub(r"https?://\S+|www\.\S+|meet\.google\.com/\S+", "[link]", value, flags=re.I)
    value = re.sub(r"\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b", "[meeting code]", value, flags=re.I)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", value)
    return " ".join(value.split())[:limit]


def error_messages(page) -> list[str]:
    """Read visible headings and error-like text without account/session internals."""
    return page.evaluate("""() => {
        const nodes = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading],[role=alert],p,div,span'));
        const error = /can['’]?t join|cannot join|unable to join|not allowed|don['’]?t have access|unsupported|not supported|supported browser|something went wrong|problem|doesn['’]?t exist|not found|invalid|expired|sign in|only people.*organization|meeting code/i;
        return Array.from(new Set(nodes.filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
            .filter(node => node.matches('h1,h2,h3,[role=heading],[role=alert],p') || !node.children.length)
            .map(node => (node.innerText || '').trim())
            .filter(text => text && text.length <= 500 && error.test(text)))).slice(0, 12);
    }""")


def refusal(messages: list[str]) -> str | None:
    """Classify only an explicit visible refusal; do not infer account or host policy."""
    for raw in messages:
        message = sanitized_label(raw, 250)
        if re.search(r"unsupported|not supported|supported browser", raw, re.I):
            return "Google Meet does not support this recording browser: " + message
        if re.search(r"sign in to join|only people.*organization", raw, re.I):
            return "Google Meet requires a signed-in participant: " + message.rstrip(".") + ". Echo joins without a Google account."
        if re.search(r"can['’]?t join|cannot join|unable to join|not allowed|don['’]?t have access|doesn['’]?t exist|not found|invalid|expired", raw, re.I):
            return "Google Meet declined Echo: " + message
        if re.search(r"something went wrong|problem", raw, re.I):
            return "Google Meet returned an error: " + message
    return None


def diagnostics(page, folder: Path, phase: str):
    """Read visible controls/status/error text only; never URLs, cookies or storage."""
    try:
        labels = page.evaluate("""() => Array.from(document.querySelectorAll('button,[role=button]'))
            .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
            .map(node => node.getAttribute('aria-label') || node.innerText || '')
            .filter(Boolean).slice(0, 24)""")
        statuses = [phrase for phrase in STATUSES if visible(page.get_by_text(phrase, exact=True))]
        messages = [sanitized_label(str(message), 300) for message in error_messages(page)]
        snapshot = {"phase": phase, "buttons": [sanitized_label(str(label)) for label in labels], "statuses": statuses, "messages": messages}
        temporary = folder / "join-diagnostics.json.tmp"
        temporary.write_text(json.dumps(snapshot), encoding="utf8")
        temporary.replace(folder / "join-diagnostics.json")
    except Exception:
        # Diagnostic failure must not bypass denial or obscure the real join error.
        pass


def visible(locator):
    """Return one visible control, including when a stale hidden instance precedes it."""
    for candidate in locator.all():
        if candidate.is_visible():
            return candidate
    return None


@contextmanager
def capture_join_failure(page, folder: Path):
    """Snapshot failures while the browser remains live, before Playwright cleanup."""
    try:
        yield
    except Exception:
        diagnostics(page, folder, "join-failed")
        raise


def prepare_guest(page, stop_event, folder: Path, timeout: float = 30, expected_email=None):
    """Dismiss only receive-only device prompts, fill the guest name, and locate Join."""
    deadline = time.monotonic() + timeout
    phase = "prejoin"
    diagnostics(page, folder, phase)
    while not stop_event.is_set() and time.monotonic() < deadline:
        verify_receive_only(page)
        without_devices = visible(page.get_by_role("button", name=WITHOUT_DEVICES))
        if without_devices:
            without_devices.click(timeout=5000)
            phase = "continued-without-devices"
            page.wait_for_timeout(250)
            diagnostics(page, folder, phase)
            continue
        name = visible(page.get_by_role("textbox", name=re.compile("your name", re.I)))
        if name and expected_email:
            raise RuntimeError("The recording browser lost its Google sign-in. Verify the connected Calendar account again before joining.")
        if name and name.input_value() != "Echo Voice - Recording":
            name.fill("Echo Voice - Recording")
            phase = "guest-name-entered"
        # Browser-enforced denial is authoritative. Do not interact with any
        # camera/microphone toggle, including controls behind blocked-device UI.
        join = visible(page.get_by_role("button", name=JOIN))
        if join and join.is_enabled():
            verify_receive_only(page)
            diagnostics(page, folder, "ready-to-request-entry")
            return join
        failure = refusal(error_messages(page))
        if failure:
            diagnostics(page, folder, "entry-refused")
            raise RuntimeError(failure.rstrip(".") + ". No meeting audio was recorded.")
        page.wait_for_timeout(250)
    if stop_event.is_set():
        return None
    diagnostics(page, folder, phase + "-timed-out")
    raise RuntimeError("Echo could not join this Google Meet. Confirm the meeting is active and allows the connected account. No meeting audio was recorded.")
