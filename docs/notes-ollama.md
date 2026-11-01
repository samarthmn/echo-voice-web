---
title: Notes with Ollama
description: Generate meeting summaries, decisions and action items locally with Ollama, and choose a model that fits your Mac.
---

Echo writes notes (a summary, key decisions and action items) from a finished transcript, using [Ollama](https://ollama.com) on your Mac. Every note links back to the passages it came from, so you can check it.

## Set up Ollama

1. Install Ollama from [ollama.com/download](https://ollama.com/download) and start it.
2. In Echo, open **Models → Local notes** and choose **Check connection**.
3. Download a recommended model from the same page.
4. Select an installed model as the default there, or in **Settings → General → Default local notes model**.

Then open a meeting with a transcript, go to the **Notes** tab and generate notes. You can also pick a different installed model in the meeting's **Details**.

## Choosing a model

Echo recommends three small models that run well on an Apple Silicon laptop:

| Model | Download | Notes |
| --- | --- | --- |
| `qwen2.5:3b` (default) | about 1.9 GB | A good balance of speed and quality |
| `llama3.2:3b` | about 2.0 GB | Similar size; try it if you prefer its style |
| `gemma3:4b` | about 3.3 GB | Slower, sometimes more thorough |

Any model you have pulled in Ollama shows up in the list. Larger models give better notes but need more memory and time; as a rough guide, a model needs free memory of about its download size plus a couple of gigabytes.

## Connection

Echo talks to Ollama at `http://127.0.0.1:11434` by default. Change it under **Settings → General → Local notes connection**. Only loopback addresses are accepted, so notes never go to another machine.

## Review the output

Language models make things up. Notes are marked as an AI draft; check them against the linked passages before relying on them. You can edit notes, and every edit creates a new version.
