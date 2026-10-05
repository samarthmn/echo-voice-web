"""Shared receive-only browser controls, Linux audio capture, and PCM readiness."""
import os
from pathlib import Path
import time


def browser_options(sink: str, headless: bool) -> dict:
    """Keep playback enabled and route only this launched browser to its sink."""
    return {
        "headless": headless,
        # Use the full Chromium binary checked by readiness, including its
        # current headless WebRTC implementation, rather than headless shell.
        "channel": "chromium",
        "env": dict(os.environ, PULSE_SINK=sink),
        "ignore_default_args": ["--mute-audio"],
        # Chromium rejects permission requests without opening a device.
        # No real or fake camera/microphone capture is enabled in this browser.
        "args": ["--autoplay-policy=no-user-gesture-required", "--deny-permission-prompts"],
    }


def deny_capture(context, page, origin: str, persistent: bool = False):
    """Set camera/microphone denied for this isolated context before external navigation."""
    session = context.new_cdp_session(page)
    try:
        info = session.send("Target.getTargetInfo")["targetInfo"]
        context_id = info.get("browserContextId")
        if not context_id and not persistent:
            raise RuntimeError("The receive-only browser context could not be identified. The guest did not join.")
    finally:
        session.detach()
    # A persistent Chromium profile uses the default context, whose target has
    # no browserContextId. Browser commands on this owned page session apply to
    # that default context; omit the ID rather than inventing another context.
    session = context.new_cdp_session(page) if persistent else context.browser.new_browser_cdp_session()
    try:
        for name in ("camera", "microphone"):
            session.send("Browser.setPermission", {"permission": {"name": name}, "setting": "denied",
                                                   **({"browserContextId": context_id} if context_id else {}),
                                                   "origin": origin, "embeddingOrigin": origin})
    except BaseException:
        session.detach()
        raise
    # Chromium removes this override when its CDP session detaches. Keep the
    # guard connected for the whole browser lifetime; browser.close cleans it up.
    return session


def verify_receive_only(page):
    """Use browser permission enforcement, which remains safe with blocked Meet controls."""
    denied = page.evaluate("""async () => {
        if (!navigator.permissions) return false;
        const states = await Promise.all(['camera', 'microphone'].map(async name =>
            (await navigator.permissions.query({name})).state));
        return states.every(state => state === 'denied');
    }""")
    if denied is not True:
        raise RuntimeError("The runner could not verify that camera and microphone access are denied. The guest did not join.")


def capture_command(sink: str, audio: Path) -> list[str]:
    """Capture 100ms mono PCM fragments and flush immediately instead of startup buffering."""
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "pulse",
            "-sample_rate", "16000", "-channels", "1", "-fragment_size", "3200",
            "-probesize", "32", "-analyzeduration", "0", "-i", sink + ".monitor",
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-flush_packets", "1", str(audio)]


def wait_for_pcm(process, audio: Path, timeout: float = 10):
    """A live process is insufficient: require written sample data before recording status."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Audio capture failed before PCM samples arrived. Check capture.log and the native audio capture permissions or service.")
        if audio.is_file() and audio.stat().st_size >= 44 + 3200:
            return
        time.sleep(0.05)
    raise RuntimeError("Audio capture produced no PCM samples. Check capture.log and the native audio capture permissions or service, then retry.")
