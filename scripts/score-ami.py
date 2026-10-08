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


def validate_provenance(case, meeting, audio, fixtures):
    """Check clip identity and the downloaded imported audio before scoring."""
    identity = meeting.get("amiCase")
    if identity is not None:
        if not isinstance(identity, dict) or any(
            identity.get(key) != case[key] for key in ("id", "startSeconds", "endSeconds")
        ):
            raise ValueError("Meeting AMI case or recording interval does not match --case")
    elif meeting.get("title") != Path(case["audio"]).stem:
        # Historical app exports have no AMI metadata. Require the complete clip
        # title, including its interval; UUIDs never establish corpus identity.
        raise ValueError("Meeting title must identify the selected AMI case and recording interval")
    if meeting.get("duration") != case["endSeconds"] - case["startSeconds"]:
        raise ValueError("Meeting duration does not match the selected recording interval")
    tracks = meeting.get("tracks", [])
    if len(tracks) != 1:
        raise ValueError("AMI scoring requires exactly one imported audio track")
    imported = audio.read_bytes()
    if tracks[0].get("bytes") != len(imported):
        raise ValueError("Downloaded audio size does not match the meeting track")
    audio_digest = hashlib.sha256(imported).hexdigest()
    if audio_digest != case["audioSha256"]:
        raise ValueError("Imported audio does not match the selected AMI clip")
    for name, checksum in (("audio", "audioSha256"), ("reference", "referenceSha256")):
        if hashlib.sha256((fixtures / case[name]).read_bytes()).hexdigest() != case[checksum]:
            raise ValueError(f"Fixture {name} checksum does not match its manifest")
    return audio_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["ES2002a", "ES2003a", "ES2004a"], required=True)
    parser.add_argument("--meeting-json", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True,
                        help="Unmodified audio bytes downloaded from the meeting's sole track URL")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fixtures = ROOT / "tests/fixtures/ami"
    manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
    case = next(item for item in manifest["cases"] if item["id"] == args.case)
    meeting = json.loads(args.meeting_json.read_text(encoding="utf-8"))
    try:
        audio_digest = validate_provenance(case, meeting, args.audio, fixtures)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    version = next(item for item in meeting["transcripts"] if item["id"] == meeting["activeTranscriptId"])
    hypothesis = " ".join(item["text"] for item in version["passages"])
    reference = tokens((fixtures / case["reference"]).read_text(encoding="utf-8"))
    actual = tokens(hypothesis)
    if not reference or not version["passages"]:
        parser.error("A failed inference is not an accuracy result")
    counts = word_errors(reference, actual)
    wer = sum(counts.values()) / len(reference)
    result = {"case": args.case, "durationSeconds": case["endSeconds"] - case["startSeconds"],
              "sourceAudioSha256": case["sourceAudioSha256"], "audioSha256": audio_digest,
              "referenceSha256": case["referenceSha256"],
              "meetingId": meeting["id"], "transcriptVersionId": version["id"], "model": version["model"],
              "createdAt": version["createdAt"], "referenceWords": len(reference),
              "hypothesisWords": len(actual), **counts, "wordErrorRate": wer,
              "wordAccuracyPercent": 100 * (1 - wer), "passages": len(version["passages"]),
              "detectedSpeakerLabels": sorted({item["speaker"] for item in version["passages"]}),
              "normalization": "NFKC, lowercase, punctuation removed, apostrophes preserved; fillers retained",
              "hypothesis": hypothesis}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Write UTF-8 bytes so Windows newline translation cannot change the artifact.
    args.output.write_bytes((json.dumps(result, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps({key: value for key, value in result.items() if key != "hypothesis"}, indent=2))


if __name__ == "__main__":
    main()
