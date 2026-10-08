#!/usr/bin/env python3
"""Create the fixed AMI evaluation clips from official local source downloads."""
import hashlib
import json
from pathlib import Path
import wave
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CASES = ("ES2002a", "ES2003a", "ES2004a")
START, END = 60.0, 210.0


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_utf8(path, text):
    # Explicit UTF-8 and LF bytes keep reference checksums stable on Windows.
    path.write_bytes(text.encode("utf-8"))


def main():
    scratch = ROOT / "tmp"
    target = ROOT / "tests/fixtures/ami"
    target.mkdir(parents=True, exist_ok=True)
    archive = scratch / "ami-manual-1.6.2.zip"
    manifest = {"schema": 1, "source": "AMI Meeting Corpus", "license": "CC BY 4.0",
                "annotationsSha256": digest(archive), "cases": []}
    with zipfile.ZipFile(archive) as annotations:
        for case in CASES:
            source = scratch / f"{case}-full.wav"
            clip = target / f"{case}-60-210.wav"
            with wave.open(str(source)) as original:
                assert original.getnchannels() == 1 and original.getsampwidth() == 2
                assert original.getframerate() == 16000
                assert original.getnframes() >= END * 16000
                original.setpos(round(START * 16000))
                frames = original.readframes(round((END - START) * 16000))
            with wave.open(str(clip), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(frames)
            words = []
            for speaker in "ABCD":
                name = f"words/{case}.{speaker}.words.xml"
                for word in ET.fromstring(annotations.read(name)).iter("w"):
                    if word.get("punc") == "true" or not word.text or not word.text.strip():
                        continue
                    begin, finish = float(word.get("starttime")), float(word.get("endtime"))
                    # Use word midpoints at boundaries, consistently for every case.
                    if START <= (begin + finish) / 2 < END:
                        words.append({"start": round(begin - START, 4), "end": round(finish - START, 4),
                                      "speaker": speaker, "text": word.text.strip()})
            words.sort(key=lambda word: (word["start"], word["end"], word["speaker"]))
            assert words, f"Missing reference for {case}"
            reference = target / f"{case}-60-210.reference.txt"
            write_utf8(reference, " ".join(word["text"] for word in words) + "\n")
            timing = target / f"{case}-60-210.reference.json"
            write_utf8(timing, json.dumps(words, indent=2, ensure_ascii=False) + "\n")
            manifest["cases"].append({"id": case, "sourceAudioUrl":
                f"https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{case}/audio/{case}.Mix-Headset.wav",
                "sourceAudioSha256": digest(source), "startSeconds": START, "endSeconds": END,
                "audio": clip.name, "audioSha256": digest(clip), "reference": reference.name,
                "referenceSha256": digest(reference), "timedReference": timing.name,
                "timedReferenceSha256": digest(timing), "referenceAnnotations": len(words),
                "speakers": sorted({word["speaker"] for word in words})})
    write_utf8(target / "manifest.json", json.dumps(manifest, indent=2) + "\n")
    license_text = (scratch / "ami-CCBY4.0.txt").read_text(encoding="utf-8")
    write_utf8(target / "LICENSE.txt", "\n".join(line.rstrip() for line in license_text.splitlines()).rstrip() + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
