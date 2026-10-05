"""Offline container audio qualification: isolated Chromium playback -> PCM WAV.

No Google page, meeting, host microphone, or host audio is accessed.
Run via `docker compose -f compose.runner.yaml exec meeting-runner python3 /app/audio_smoke.py`.
"""
from array import array
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import wave

from playwright.sync_api import sync_playwright
from capture import browser_options, capture_command, deny_capture, verify_receive_only, wait_for_pcm


def main():
    """Record a generated tone from the dedicated sink and validate actual samples."""
    sink = "echo_smoke_" + secrets.token_hex(8)
    module = subprocess.check_output(["pactl", "load-module", "module-null-sink", "sink_name=" + sink], text=True).strip()
    capture = None
    try:
        with tempfile.TemporaryDirectory(prefix="audio-smoke-", dir=Path("/app/tmp")) as directory:
            audio = Path(directory) / "tone.wav"
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(**browser_options(sink, True))
                try:
                    context = browser.new_context()
                    page = context.new_page()
                    _permissions_guard = deny_capture(context, page, "https://echo-audio-check.invalid")
                    # A locally fulfilled secure origin exposes the Permissions API.
                    page.route("https://echo-audio-check.invalid/**", lambda route: route.fulfill(
                        status=200, content_type="text/html", body="<!doctype html><title>Local audio check</title>"))
                    page.goto("https://echo-audio-check.invalid/")
                    verify_receive_only(page)
                    capture = subprocess.Popen(capture_command(sink, audio), stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
                    wait_for_pcm(capture, audio)
                    page.evaluate("""async () => {
                        const context = new AudioContext();
                        await context.resume();
                        const tone = context.createOscillator();
                        const gain = context.createGain();
                        tone.frequency.value = 440;
                        gain.gain.value = 0.2;
                        tone.connect(gain).connect(context.destination);
                        tone.start();
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        tone.stop();
                        await context.close();
                    }""")
                    page.wait_for_timeout(400)
                    capture.communicate(input=b"q\n", timeout=10)
                    if capture.returncode:
                        raise RuntimeError("The capture process failed.")
                    with wave.open(str(audio), "rb") as recorded:
                        assert recorded.getnchannels() == 1 and recorded.getframerate() == 16000 and recorded.getsampwidth() == 2
                        samples = array("h", recorded.readframes(recorded.getnframes()))
                    rms = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))
                    if len(samples) < 16000 or rms < 500:
                        raise RuntimeError(f"Chromium playback was silent or missing from the isolated sink ({len(samples)} samples, RMS {rms:.1f}).")
                    print(json.dumps({"ready": True, "camera": "denied", "microphone": "denied", "sampleRate": 16000, "channels": 1, "rms": round(rms), "seconds": round(len(samples) / 16000, 2)}))
                finally:
                    browser.close()
    finally:
        if capture and capture.poll() is None:
            capture.kill()
            capture.wait()
        subprocess.run(["pactl", "unload-module", module], capture_output=True, timeout=10)


if __name__ == "__main__":
    main()
