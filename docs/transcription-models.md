---
title: Transcription models
description: Choose between Whisper Large V3 Turbo in the browser and Whisper Large V3 running natively, and manage their downloads.
---

Echo transcribes with OpenAI's Whisper, running on your Mac. Pick and download models under **Models → Speech models**.

| Model | Runs | Download | Best for |
| --- | --- | --- | --- |
| Whisper Large V3 Turbo (default) | In the browser, in a web worker, via transformers.js | about 1.2 GB with the speaker models | Everyday use; fast |
| Whisper Large V3 | Natively, in a Node.js process the server supervises (`onnxruntime-node`) | about 1.7 GB | The most accurate results on difficult audio |

Downloads come from Hugging Face and need the internet once. After that, transcription is fully offline.

## Choosing a model

- **Default for new meetings:** **Settings → General → Default speech model**.
- **For one meeting:** open the meeting, then **Details → Processing choices → Speech recognition**, and **Save choices**.

Download a model before selecting it.

## Turbo

Turbo is cached in the browser's Cache Storage for Echo's origin. Changing Echo's port or host name means downloading it again. It runs in the Echo tab, so keep that tab open while it transcribes.

## Large V3

Large V3 needs Node.js 22.18 or newer on the server's `PATH` and the packages from `pnpm install` (`setup.sh` installs them). **Check engine** on its model card confirms the setup. The download is the pinned q8 export `Xenova/whisper-large-v3`, stored under `<dataDir>/models/native-large-v3/`. Models are not included in library backups. Removing the model in **Models** deletes that folder.

Only one native job runs at a time. The browser decodes the audio to 16 kHz mono and sends it to the server, which keeps it in an encrypted spool under the checkout's `tmp/` for the length of the job. Abandoned jobs are cleaned up the next time Echo starts.

## Language and vocabulary

Set the recording language in **Settings → General → Recording language**. Under **Settings → Vocabulary**, add the names and terms Whisper tends to get wrong, each with the misspellings you have seen ("aliases"). When a transcript is created, Echo replaces whole-word matches of an alias with your spelling. Each transcript version keeps a snapshot of the vocabulary it used.

## Reviewing transcripts

Whisper makes mistakes, especially with names, crosstalk and poor audio. Passages Echo is unsure about are marked **Needs review**. You can edit text, rename speakers and return to earlier versions; every edit is saved as a new version.
