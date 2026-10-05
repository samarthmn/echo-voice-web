"""No-device macOS audio helper tests. Never start ScreenCaptureKit capture."""
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import unittest
import wave


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(platform.system() == "Darwin", "macOS SDK required")
class MacOSCaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / "tmp").mkdir(exist_ok=True)
        cls.scratch = Path(tempfile.mkdtemp(prefix="macos-capture-tests-", dir=ROOT / "tmp"))
        source = (ROOT / "runner/macos/AudioCapture.swift").read_text().split("@main\n", 1)[0]
        # Exercise the actual WAV writer and stop gate with in-memory samples;
        # the production entry point (and all capture startup) is omitted.
        source += r'''
@main private enum TestMain {
    static func main() async throws {
        let path = CommandLine.arguments[1]
        let mode = CommandLine.arguments[2]
        if mode == "gate" {
            let gate = StopGate()
            gate.stop("first")
            gate.stop("second")
            guard await gate.wait() == "first" else { exit(1) }
            let empty = StopGate()
            empty.stop()
            guard await empty.wait() == nil else { exit(1) }
            return
        }
        do {
            let file = try PCMFile(path: path)
            let samples: [Float] = [-2, -1, -0.5, 0, 0.5, 1, 2, .nan, .infinity]
            try samples.withUnsafeBufferPointer { try file.appendSamples($0) }
            try file.finish()
        } catch { exit(4) }
    }
}
'''
        harness = cls.scratch / "AudioCaptureTests.swift"
        harness.write_text(source)
        cls.binary = cls.scratch / "test-audio"
        env = dict(os.environ, TMPDIR=str(cls.scratch))
        subprocess.run([
            "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5",
            "-module-cache-path", str(cls.scratch / "module-cache"),
            "-framework", "ScreenCaptureKit", "-framework", "AVFoundation",
            "-framework", "AppKit", str(harness), "-o", str(cls.binary),
        ], cwd=ROOT, env=env, check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.scratch)

    def run_harness(self, path, mode="write"):
        return subprocess.run([str(self.binary), str(path), mode], capture_output=True, timeout=10)

    def test_pcm_format_clipping_and_private_mode(self):
        path = self.scratch / "synthetic.wav"
        self.assertEqual(self.run_harness(path).returncode, 0)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with wave.open(str(path)) as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 16000))
            self.assertEqual(audio.getnframes(), 9)
            self.assertEqual(struct.unpack("<9h", audio.readframes(9)),
                             (-32767, -32767, -16384, 0, 16384, 32767, 32767, 0, 0))

    def test_existing_file_and_symlink_are_never_overwritten(self):
        original = self.scratch / "keep.wav"
        original.write_bytes(b"existing recording")
        link = self.scratch / "link.wav"
        link.symlink_to(original)
        self.assertEqual(self.run_harness(original).returncode, 4)
        self.assertEqual(self.run_harness(link).returncode, 4)
        self.assertEqual(original.read_bytes(), b"existing recording")

    def test_stop_before_wait_and_duplicate_signal(self):
        self.assertEqual(self.run_harness(self.scratch / "unused.wav", "gate").returncode, 0)


if __name__ == "__main__":
    unittest.main()
