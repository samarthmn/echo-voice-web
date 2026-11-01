---
title: FAQ
description: Common questions about Echo, the open-source local meeting recorder, and how it compares with cloud notetakers.
---

## Is Echo free?

Yes. Echo is open source under the MIT licence. There is no paid tier, account or subscription.

## Is Echo a service?

No. Echo is software you run on your own Mac. Nobody operates it for you, and the project never receives your audio, transcripts or notes.

## How is Echo different from Fireflies, Otter.ai or Fathom?

Those are cloud services: a bot joins your call or an app uploads your audio, and transcription happens on their servers under your account. Echo records the meeting tab in your own browser, transcribes on your Mac, and keeps everything in an encrypted library on your disk. The trade-off is that you install and run it yourself, it works on one Mac for one person, and there is no team sharing. See the [comparison](https://echo-web.samarthmn.com/#compare).

## Does a bot join my meetings?

No. The extension captures the audio of the meeting tab you already have open. Other participants don't see a notetaker, so tell them you are recording and get their consent.

## Which meeting apps work?

Google Meet, Zoom (web client) and Microsoft Teams (web), in Brave or Chrome. For anything else, record in person with your microphone, or upload a recording.

## Does it work offline?

After you have downloaded the models, yes. Recording, transcription, speaker grouping and notes all run on your Mac. The extension even keeps recording while Echo is stopped and uploads later.

## Which languages does it support?

Whisper recognises many languages. Choose yours in **Settings → General → Recording language**. Accuracy is best for widely spoken languages.

## Does it run on Windows, Linux or Intel Macs?

Not today. Echo targets Apple Silicon Macs, uses the macOS Keychain for its library key, and the setup script checks for both.

## How accurate is it?

Whisper Large V3 Turbo and Large V3 are among the most accurate open speech models, but they still make mistakes with names, crosstalk and poor audio. Echo marks uncertain passages, links every note to its source, and keeps all versions so you can correct things.

## What happens if I lose my Mac?

Your library is encrypted with a key in the Mac's Keychain. Keep the 24-word recovery phrase and export backups regularly; with both, you can restore on another Mac. See [backups and recovery](backups-and-recovery.md).

## Can I use a cloud LLM for notes?

No. Echo only talks to Ollama on your Mac, so notes never leave it.

## How do I get help or contribute?

[Open an issue](https://github.com/samarthmn/echo-voice-web/issues) for bugs and questions. To contribute, start with the [development guide](development.md).
