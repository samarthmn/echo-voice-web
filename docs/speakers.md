---
title: Speakers
description: How Echo groups a transcript by speaker on your Mac, and how to rename and correct speakers.
---

Echo labels who spoke when, on your Mac, as part of transcription.

## How it works

Speaker grouping uses two models that run in the browser alongside Whisper:

- **PyAnnote segmentation 3.0** (`onnx-community/pyannote-segmentation-3.0`) finds where speech starts, stops and changes speaker.
- **WavLM** speaker embeddings (`Xenova/wavlm-base-plus-sv`) describe each voice so similar segments can be grouped.

They download with Turbo (part of its 1.2 GB) and are cached with the browser profile. Removing Large V3 does not remove them.

## Renaming speakers

Echo starts with labels such as "Speaker 1". Select a speaker label in the transcript to rename it; the name applies to every passage from that speaker in the current version.

## Limits

Grouping is approximate. It struggles with:

- very short turns ("yes", "mm-hm");
- people talking over each other;
- several people on one microphone, or one person on several;
- voices that sound alike.

Fix mistakes by editing the passage's speaker. Your corrections are saved as a new transcript version.
