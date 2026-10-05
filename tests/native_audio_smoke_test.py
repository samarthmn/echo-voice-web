"""Offline tests for native audio qualification; no devices or browsers opened."""
from array import array
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runner"))
import audio_smoke


class NativeAudioSmokeTests(unittest.TestCase):
    def test_mac_missing_permission_fails_before_browser_import_or_launch(self):
        helper = Mock()
        helper.is_file.return_value = True
        root = Mock()
        root.__truediv__ = Mock(return_value=helper)
        with patch.object(audio_smoke, "ROOT", root), patch.object(audio_smoke.os, "access", return_value=True), \
             patch.object(audio_smoke.subprocess, "run", return_value=Mock(returncode=0, stdout='{"ready":false}')) as run:
            with self.assertRaisesRegex(RuntimeError, "No permission prompt"):
                audio_smoke.mac_helper()
            self.assertEqual(run.call_args.args[0][-1], "--check")

    def test_mac_failed_check_is_not_ready_even_when_json_says_ready(self):
        helper = Mock()
        root = Mock()
        root.__truediv__ = Mock(return_value=helper)
        with patch.object(audio_smoke, "ROOT", root), patch.object(audio_smoke.os, "access", return_value=True), \
             patch.object(audio_smoke.subprocess, "run", return_value=Mock(returncode=3, stdout='{"ready":true}')):
            with self.assertRaises(RuntimeError):
                audio_smoke.mac_helper()

    def test_stop_uses_owned_mac_signal_or_linux_ffmpeg_quit(self):
        for platform in ("darwin", "linux"):
            process = Mock(returncode=0)
            process.poll.return_value = None
            audio_smoke.stop_capture(process, platform)
            if platform == "darwin":
                process.terminate.assert_called_once_with()
                process.communicate.assert_called_once_with(timeout=10)
            else:
                process.terminate.assert_not_called()
                process.communicate.assert_called_once_with(input=b"q\n", timeout=10)

    def test_failed_capture_cannot_pass_on_existing_samples(self):
        process = Mock(returncode=1)
        process.poll.return_value = 1
        with self.assertRaisesRegex(RuntimeError, "finish cleanly"):
            audio_smoke.stop_capture(process, "darwin")

    def test_finalized_pcm_required_and_silence_rejected(self):
        (ROOT / "tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="native-audio-unit-", dir=ROOT / "tmp") as directory:
            audio = Path(directory) / "tone.wav"
            for amplitude in (0, 2000):
                with wave.open(str(audio), "wb") as output:
                    output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    samples = array("h", [amplitude, -amplitude] * 16000)
                    if sys.byteorder != "little":
                        samples.byteswap()
                    output.writeframes(samples.tobytes())
                if amplitude:
                    result = audio_smoke.audio_result(audio)
                    self.assertTrue(result["ready"])
                    self.assertEqual(result["rms"], 2000)
                    self.assertEqual(result["crossApplicationIsolation"], "not_qualified")
                else:
                    with self.assertRaisesRegex(RuntimeError, "silent or missing"):
                        audio_smoke.audio_result(audio)


if __name__ == "__main__":
    unittest.main()
