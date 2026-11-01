---
title: Your first recording
description: Download a speech model, record a meeting, and get a transcript and notes in Echo.
---

## 1. Download a speech model

Open **Models → Speech models** and download **Whisper Large V3 Turbo**. It runs in the browser and is the default for new meetings. The download is about 1.2 GB and happens once. See [transcription models](transcription-models.md) to compare it with Large V3.

## 2. Record

Pick whichever fits:

- **An online meeting.** Join it in Brave or Chrome as usual, open the Echo extension popup while the meeting tab is selected, tick **Participants have consented to recording**, and choose **Start recording**.
- **An in-person meeting.** In Echo choose **New meeting → In person**, allow the microphone, and record.
- **An existing file.** Choose **Upload a recording** on the overview and pick an audio file.

[Recording](recording.md) covers each option in detail.

## 3. Transcribe

Open the meeting and choose **Create transcript**. With **Settings → General → Transcribe after recording** on, Echo starts on its own. Keep an Echo tab open while Turbo transcribes; it runs in that tab.

When it finishes you can play the audio, jump to any passage, rename speakers, edit text and save moments. Every edit creates a new version, so you can go back.

## 4. Notes (optional)

With [Ollama](notes-ollama.md) installed and a model downloaded, open the meeting's **Notes** tab and generate notes. Each note links back to the passages it came from, so you can check it against what was said.

## 5. Export or back up

Export a single meeting from its **Export** menu (Markdown, text, SRT, JSON or audio), or the whole library from **Settings → Storage → Export library**.
