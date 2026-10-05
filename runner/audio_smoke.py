"""Offline native audio qualification using an owned, disposable browser profile.

Run ``python runner/audio_smoke.py`` from a macOS or Linux desktop session.
No Google page, network content, camera, or microphone is accessed. On macOS,
ScreenCaptureKit must already have explicit permission; this never prompts.
"""
from array import array
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import wave

from capture import capture_command, deny_capture, verify_receive_only, wait_for_pcm

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://echo-audio-check.invalid/"



@contextmanager
def child_scratch(directory):
    """Keep browser/driver temporary files inside this disposable project folder."""
    previous = os.environ.get("TMPDIR")
    os.environ["TMPDIR"] = str(directory)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = previous


def mac_helper():
    helper = ROOT / "target/native-runner/echo-audio-capture"
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise RuntimeError("Build the Mac audio helper with sh runner/macos/build.sh before checking audio.")
    result = subprocess.run([str(helper), "--check"], capture_output=True, text=True, timeout=5)
    try:
        status = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("The Mac audio helper did not return a valid permission check.") from None
    if result.returncode or not isinstance(status, dict) or status.get("ready") is not True:
        raise RuntimeError("Allow Screen & System Audio Recording for the native helper in System Settings before checking audio. No permission prompt was opened.")
    return helper


def stop_capture(process, platform):
    """Finalize the owned WAV before inspecting it; signal only this child."""
    if process.poll() is None:
        if platform == "darwin":
            process.terminate()  # ScreenCaptureKit handles SIGTERM and finalizes WAV.
            process.communicate(timeout=10)
        else:
            process.communicate(input=b"q\n", timeout=10)
    if process.returncode:
        raise RuntimeError("The native audio capture process did not finish cleanly.")


def audio_result(audio):
    with wave.open(str(audio), "rb") as recorded:
        if (recorded.getnchannels(), recorded.getframerate(), recorded.getsampwidth()) != (1, 16000, 2):
            raise RuntimeError("Native capture returned an unexpected PCM format.")
        samples = array("h", recorded.readframes(recorded.getnframes()))
        if len(samples) != recorded.getnframes():
            raise RuntimeError("Native capture returned an incomplete WAV file.")
    if sys.byteorder != "little":
        samples.byteswap()
    rms = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))
    if len(samples) < 16000 or rms < 500:
        raise RuntimeError(f"Dedicated browser playback was silent or missing ({len(samples)} samples, RMS {rms:.1f}).")
    return {"ready": True, "platform": sys.platform, "camera": "denied", "microphone": "denied",
            "sampleRate": 16000, "channels": 1, "rms": round(rms), "seconds": round(len(samples) / 16000, 2),
            "networkContent": False, "crossApplicationIsolation": "not_qualified"}


def main():
    """Record only a synthetic tone from the dedicated native browser."""
    if sys.platform not in ("darwin", "linux"):
        raise RuntimeError("Native audio qualification requires a macOS or Linux desktop session.")
    # Check consent before launching a browser or querying shareable content.
    helper = mac_helper() if sys.platform == "darwin" else None
    from playwright.sync_api import sync_playwright
    from native_auth import block_media_preferences, native_browser_pid, native_persistent_context
    from meet_auth import close_context

    (ROOT / "tmp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-audio-smoke-", dir=ROOT / "tmp") as directory, child_scratch(directory):
        scratch = Path(directory)
        profile = scratch / "browser-profile"
        profile.mkdir(mode=0o700)
        block_media_preferences(profile)
        audio = scratch / "tone.wav"
        sink = "echo_smoke_" + secrets.token_hex(8) if sys.platform == "linux" else None
        module = capture = context = playwright = None
        try:
            if sink:
                result = subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=" + sink],
                                        capture_output=True, text=True, timeout=10)
                module = result.stdout.strip() if result.returncode == 0 else None
                if not module or not module.isdecimal():
                    raise RuntimeError("A private audio sink could not be created. Check the desktop PulseAudio service.")
            playwright = sync_playwright().start()
            context = native_persistent_context(playwright, profile, sink=sink)
            # Fulfill the sole allowed URL locally and reject every other request.
            context.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html",
                          body="<!doctype html><title>Echo offline audio check</title>")
                          if route.request.url == ORIGIN else route.abort())
            page = context.pages[0] if context.pages else context.new_page()
            _guard = deny_capture(context, page, ORIGIN.rstrip("/"), persistent=True)
            page.goto(ORIGIN, wait_until="domcontentloaded", timeout=10_000)
            verify_receive_only(page)
            command = ([str(helper), "--pid", str(native_browser_pid(context)), "--output", str(audio)]
                       if helper else capture_command(sink, audio))
            with (scratch / "capture.log").open("wb") as log:
                capture = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log)
                # Continuous tone avoids depending on silent-app samples before
                # ScreenCaptureKit has started delivering buffers.
                page.evaluate("""async () => {
                    const audio = new AudioContext();
                    await audio.resume();
                    const tone = audio.createOscillator();
                    const gain = audio.createGain();
                    tone.frequency.value = 440;
                    gain.gain.value = 0.2;
                    tone.connect(gain).connect(audio.destination);
                    tone.start();
                    window.echoTone = {audio, tone};
                }""")
                wait_for_pcm(capture, audio)
                page.wait_for_timeout(3000)
                stop_capture(capture, sys.platform)
                page.evaluate("async () => { window.echoTone.tone.stop(); await window.echoTone.audio.close(); }")
                print(json.dumps(audio_result(audio)))
        finally:
            # Failed qualification still owns its process/sink and must not leave
            # capture running after the temporary profile disappears.
            try:
                if capture and capture.poll() is None:
                    try:
                        stop_capture(capture, sys.platform)
                    except (RuntimeError, subprocess.TimeoutExpired, OSError):
                        capture.kill()
                        capture.wait(timeout=5)
            finally:
                try:
                    if context:
                        close_context(context)
                finally:
                    try:
                        if playwright:
                            playwright.stop()
                    finally:
                        if module:
                            subprocess.run(["pactl", "unload-module", module], capture_output=True, timeout=10, check=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ready": False, "detail": str(error)}))
        raise SystemExit(1)
