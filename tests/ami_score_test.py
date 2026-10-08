"""AMI provenance rejection and saved-score reproduction, without inference."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests/fixtures/ami"
EVIDENCE = ROOT / "artifacts/brave-e2e-2026-10-05"
spec = importlib.util.spec_from_file_location("ami_score", ROOT / "scripts/score-ami.py")
scorer = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(scorer)


class AMIScoreTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "tmp").mkdir(exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(prefix="ami-score-test-", dir=ROOT / "tmp")
        self.addCleanup(self.scratch.cleanup)
        self.tmp = Path(self.scratch.name)
        self.case = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))["cases"][0]
        self.meeting = json.loads((EVIDENCE / "ami-ES2002a.transcript.json").read_text(encoding="utf-8"))
        self.audio = FIXTURES / self.case["audio"]

    def validate(self, meeting=None, audio=None):
        return scorer.validate_provenance(self.case, meeting or self.meeting, audio or self.audio, FIXTURES)

    def test_rejects_other_case_before_scoring(self):
        other = json.loads((EVIDENCE / "ami-ES2003a.transcript.json").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(ValueError, "case and recording interval"):
            self.validate(other)

    def test_rejects_other_interval_with_same_case(self):
        self.meeting["title"] = "ES2002a-30-180"
        with self.assertRaisesRegex(ValueError, "recording interval"):
            self.validate()

    def test_explicit_case_is_preferred_to_display_title(self):
        self.meeting["title"] = "Renamed meeting"
        self.meeting["amiCase"] = {key: self.case[key] for key in ("id", "startSeconds", "endSeconds")}
        self.assertEqual(self.validate(), self.case["audioSha256"])
        self.meeting["amiCase"]["id"] = "ES2003a"
        self.meeting["title"] = Path(self.case["audio"]).stem
        with self.assertRaisesRegex(ValueError, "AMI case"):
            self.validate()

    def test_explicit_interval_mismatch_is_rejected(self):
        self.meeting["amiCase"] = {key: self.case[key] for key in ("id", "startSeconds", "endSeconds")}
        self.meeting["amiCase"]["startSeconds"] = 30
        with self.assertRaisesRegex(ValueError, "recording interval"):
            self.validate()

    def test_rejects_duration_and_multiple_tracks(self):
        other = copy.deepcopy(self.meeting)
        other["duration"] = 149
        with self.assertRaisesRegex(ValueError, "duration"):
            self.validate(other)
        other = copy.deepcopy(self.meeting)
        other["tracks"].append(copy.deepcopy(other["tracks"][0]))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.validate(other)

    def test_matching_title_does_not_authorize_different_audio(self):
        with self.assertRaisesRegex(ValueError, "Imported audio"):
            self.validate(audio=FIXTURES / "ES2003a-60-210.wav")
        corrupted = self.tmp / "modified.wav"
        content = bytearray(self.audio.read_bytes())
        content[-1] ^= 1
        corrupted.write_bytes(content)
        with self.assertRaisesRegex(ValueError, "Imported audio"):
            self.validate(audio=corrupted)

    def test_cli_requires_downloaded_audio_and_rejects_under_optimization(self):
        base = [sys.executable, "-O", str(ROOT / "scripts/score-ami.py"), "--case", "ES2002a",
                "--meeting-json", str(EVIDENCE / "ami-ES2002a.transcript.json"),
                "--output", str(self.tmp / "rejected.json")]
        missing = subprocess.run(base, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--audio", missing.stderr)
        wrong = subprocess.run(base + ["--audio", str(FIXTURES / "ES2003a-60-210.wav")],
                               capture_output=True, text=True)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn("Imported audio", wrong.stderr)
        self.assertFalse((self.tmp / "rejected.json").exists())

    def test_three_historical_scores_numerically_reproduce(self):
        # Fixture bytes establish numerical reproducibility only. They are not
        # claimed to be the unavailable historical server's downloaded audio.
        for case_id in ("ES2002a", "ES2003a", "ES2004a"):
            with self.subTest(case=case_id):
                output = self.tmp / f"{case_id}.json"
                result = subprocess.run([
                    sys.executable, str(ROOT / "scripts/score-ami.py"), "--case", case_id,
                    "--meeting-json", str(EVIDENCE / f"ami-{case_id}.transcript.json"),
                    "--audio", str(FIXTURES / f"{case_id}-60-210.wav"), "--output", str(output),
                ], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(output.read_text(encoding="utf-8")),
                                 json.loads((EVIDENCE / f"ami-{case_id}.score.json").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
