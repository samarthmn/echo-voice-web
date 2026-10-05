# AMI transcription accuracy — 2026-10-05

Three different 150-second excerpts were uploaded and transcribed through the actual product in Brave. Each covers 01:00–03:30 of an AMI headset mix. Reference transcripts were used only after inference. No vocabulary hints, manual transcript edits, or notes were supplied to the speech model. Accuracy improvement is deferred; these are the observed results.

| Clip | Words in reference | Substitutions | Deletions | Insertions | WER | Word accuracy |
|---|---:|---:|---:|---:|---:|---:|
| ES2002a | 310 | 13 | 67 | 4 | 27.1% | **72.9%** |
| ES2003a | 220 | 21 | 10 | 23 | 24.5% | **75.5%** |
| ES2004a | 262 | 11 | 31 | 3 | 17.2% | **82.8%** |

Pooled across 792 reference words: **76.9% word accuracy**, 23.1% WER (183 word errors). This pools error counts, rather than averaging the three percentages.

## Method

- Model ID: `onnx-community/whisper-large-v3-turbo`; actual checkpoint `onnx-community/whisper-large-v3-turbo_timestamped`, revision `b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a`.
- Local Transformers.js 3.8.1 and ONNX Runtime Web, WASM with four isolated CPU threads in Brave on the test Mac. Automatic speaker grouping was enabled; language was English and vocabulary was empty.
- Audio is 16 kHz mono PCM16, unmodified except for clipping. SHA-256 values, source URLs and references are preserved in [the fixture manifest](../tests/fixtures/ami/manifest.json).
- Normalization: Unicode NFKC, lowercase and removal of punctuation; apostrophes, spoken fillers and repetitions are retained. No number/spelling substitutions or case-specific cleaning.
- WER = (substitutions + deletions + insertions) / reference words. Word accuracy = 100 × (1 − WER). The exact Levenshtein scorer uses linear memory.
- Overlapping speakers are ordered by annotated word time; a single-stream transcript can incur ordering errors. Boundary words may be partly clipped. Three short clips do not establish general meeting accuracy.

## Speaker differentiation and limits

PyAnnote segmentation detects turns; WavLM speaker-verification embeddings match anonymous voices within one inference. Voice vectors are transient and are not persisted or reused across meetings. These word scores do **not** measure speaker-label accuracy, diarization error rate or notes quality.

ES2002a produced six numbered labels plus Unknown speaker, despite four annotated participants. It also merged some short introductions. A previous run produced eleven numbered labels plus Unknown; the continuity fix reduced fragmentation without changing the word score. ES2003a produced three numbered labels plus Unknown. ES2004a produced one label in this excerpt. Label counts alone do not establish correct voice attribution. Short and overlapping passages still require review.

## Evidence and reproduction

All three outputs reached “Ready to review” in the product. The active saved versions, output text, word counts and individual scores are in [the evidence directory](../artifacts/brave-e2e-2026-10-05/). The combined machine-readable result is [ami-accuracy.json](../artifacts/brave-e2e-2026-10-05/ami-accuracy.json).
- ES2002a: version `70a6aa1e-6fe3-45d5-be86-0a2535905f6e`, saved `2026-10-05T03:36:28.829Z`; [actual output](../artifacts/brave-e2e-2026-10-05/ami-ES2002a.transcript.json), [score](../artifacts/brave-e2e-2026-10-05/ami-ES2002a.score.json).
- ES2003a: version `6bdca978-32e9-4ccb-98c4-fb366269a7b2`, saved `2026-10-05T03:39:36.060Z`; [actual output](../artifacts/brave-e2e-2026-10-05/ami-ES2003a.transcript.json), [score](../artifacts/brave-e2e-2026-10-05/ami-ES2003a.score.json).
- ES2004a: version `764e3eaa-90e5-4aba-b805-2c3b4d9e4708`, saved `2026-10-05T03:43:38.046Z`; [actual output](../artifacts/brave-e2e-2026-10-05/ami-ES2004a.transcript.json), [score](../artifacts/brave-e2e-2026-10-05/ami-ES2004a.score.json).

Run from the repository root:

```sh
for case in ES2002a ES2003a ES2004a; do
  python3 scripts/score-ami.py --case "$case" \
    --meeting-json "artifacts/brave-e2e-2026-10-05/ami-$case.transcript.json" \
    --output "tmp/ami-$case.score.json"
done
```

Create project `tmp/` first if absent. For a fresh inference, upload only the WAV files through the app, select Turbo and English, leave vocabulary empty, and score the resulting active saved versions. Fixture provenance, CC BY 4.0 attribution and preparation instructions are in [the fixture README](../tests/fixtures/ami/README.md).

Full Large V3 failed its actual local execution readiness check on this Mac and remains unavailable. It was not used for these scores. Google Meet guest admission was refused; the container audio smoke passed, but live Google Meet capture is not qualified by this report.
