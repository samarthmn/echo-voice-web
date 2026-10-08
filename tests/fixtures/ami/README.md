# AMI meeting transcription fixtures

Three independent 150-second audio clips from the **AMI Meeting Corpus**, meetings ES2002a, ES2003a and ES2004a. Each clip covers **01:00–03:30** of its original headset mix. The WAV files remain the original 16 kHz mono PCM16 samples; clipping is the only audio modification.

Source: [AMI Corpus download](https://groups.inf.ed.ac.uk/ami/download/), University of Edinburgh and the AMI Consortium. Audio and annotations are licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The provider's license is included in LICENSE.txt. Source URLs and SHA-256 checksums are in manifest.json.

In the manifest and score artifacts, `sourceAudioSha256` identifies the full original source WAV; `audioSha256` identifies the 150-second clip evaluated by the app. Preparation and scoring use explicit UTF-8 text and LF output bytes, keeping checksums independent of the operating system's locale and newline convention.

New scoring runs require `--audio` containing the bytes downloaded from the exported meeting's sole track URL. The scorer checks those bytes against the clip checksum and checks the meeting's case and interval before calculating WER. Historical scores made before this check have fixture provenance only; their original served audio is unavailable. See the [accuracy report](../../../docs/ami-accuracy-2026-10-05.md) for the validated workflow and the separate numerical reproduction command.

References derive from [AMI manual annotations v1.6.2](https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip), the four participants' word XML files for each meeting. Punctuation-only and non-word sound annotations are excluded. Spoken fillers and repetitions remain. Words whose midpoint falls in the clip are included and sorted by start, end, then speaker. The JSON preserves word times relative to the clip and original A/B/C/D speaker labels; text files contain the same chronological words for scoring. Overlapping speech can penalize a single-stream transcript's word ordering. Boundary words may be partially clipped.

The app receives only audio during inference; reference transcripts are used afterward for evaluation. Scores apply to these three clips, not to the complete AMI corpus or all meeting conditions. Word error rate (WER) is `(substitutions + deletions + insertions) / reference words`; word accuracy is `100 × (1 − WER)` and can be negative if insertions are extreme. Neither score measures speaker-label accuracy or notes quality.

To reproduce the clips, download the three source WAV URLs and annotation ZIP into project tmp/ using the names expected by scripts/prepare-ami-fixtures.py, download the provider's CCBY4.0.txt as tmp/ami-CCBY4.0.txt, then run that script. Full source recordings are deliberately not committed.
