#!/usr/bin/env python3
"""Score saved app transcripts after inference, without supplying references to it."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]


def tokens(text):
    text = unicodedata.normalize("NFKC", text).lower().replace("’", "'").replace("‘", "'")
    return re.findall(r"[^\W_]+(?:'[^\W_]+)*", text, re.UNICODE)


def word_errors(reference, hypothesis):
    # Exact Levenshtein with linear memory. Ties prefer substitution, deletion,
    # insertion in that order. No filler removal or case-specific substitutions.
    previous = [(j, 0, 0, j) for j in range(len(hypothesis) + 1)]
    for i, expected in enumerate(reference, 1):
        current = [(i, 0, i, 0)]
        for j, actual in enumerate(hypothesis, 1):
            if expected == actual:
                current.append(previous[j - 1])
                continue
            cost, substitutions, deletions, insertions = previous[j - 1]
            substitute = (cost + 1, substitutions + 1, deletions, insertions)
            cost, substitutions, deletions, insertions = previous[j]
            delete = (cost + 1, substitutions, deletions + 1, insertions)
            cost, substitutions, deletions, insertions = current[j - 1]
            insert = (cost + 1, substitutions, deletions, insertions + 1)
            current.append(min((substitute, delete, insert), key=lambda item: item[0]))
        previous = current
    _, substitutions, deletions, insertions = previous[-1]
    return {"substitutions": substitutions, "deletions": deletions, "insertions": insertions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["ES2002a", "ES2003a", "ES2004a"], required=True)
    parser.add_argument("--meeting-json", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fixtures = ROOT / "tests/fixtures/ami"
    manifest = json.loads((fixtures / "manifest.json").read_text())
    case = next(item for item in manifest["cases"] if item["id"] == args.case)
    for name, checksum in (("audio", "audioSha256"), ("reference", "referenceSha256")):
        assert hashlib.sha256((fixtures / case[name]).read_bytes()).hexdigest() == case[checksum]
    meeting = json.loads(args.meeting_json.read_text())
    version = next(item for item in meeting["transcripts"] if item["id"] == meeting["activeTranscriptId"])
    hypothesis = " ".join(item["text"] for item in version["passages"])
    reference = tokens((fixtures / case["reference"]).read_text())
    actual = tokens(hypothesis)
    assert reference and version["passages"], "A failed inference is not an accuracy result"
    counts = word_errors(reference, actual)
    wer = sum(counts.values()) / len(reference)
    result = {"case": args.case, "durationSeconds": case["endSeconds"] - case["startSeconds"],
              "sourceAudioSha256": case["audioSha256"], "referenceSha256": case["referenceSha256"],
              "meetingId": meeting["id"], "transcriptVersionId": version["id"], "model": version["model"],
              "createdAt": version["createdAt"], "referenceWords": len(reference),
              "hypothesisWords": len(actual), **counts, "wordErrorRate": wer,
              "wordAccuracyPercent": 100 * (1 - wer), "passages": len(version["passages"]),
              "detectedSpeakerLabels": sorted({item["speaker"] for item in version["passages"]}),
              "normalization": "NFKC, lowercase, punctuation removed, apostrophes preserved; fillers retained",
              "hypothesis": hypothesis}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "hypothesis"}, indent=2))


if __name__ == "__main__":
    main()
