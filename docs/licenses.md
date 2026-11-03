---
title: Licences
description: The licences of Echo, its Rust and JavaScript dependencies, its fonts and icons, and the speech models it downloads.
---

Echo itself is released under the [MIT licence](../LICENSE).

## Dependencies

Rust dependencies are checked by `cargo deny check` (see `deny.toml`) on every CI run. Only permissive licences are allowed: MIT, Apache-2.0 (with or without the LLVM exception), BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0, CC0-1.0, BSL-1.0, MPL-2.0 and CDLA-Permissive-2.0. A crate offered under several licences passes if one of them is on that list. One exception: `sqlcipher-src`, the SQLCipher source behind the encrypted library, also carries SQLite's public-domain "blessing" and libtomcrypt's WTFPL, both more permissive than MIT, so `deny.toml` allows those two for that crate only.

The runtime JavaScript dependencies:

| Package | Licence | Used for |
| --- | --- | --- |
| `@huggingface/transformers` | Apache-2.0 | Running Whisper and the speaker models |
| `onnxruntime-web` | MIT | The in-browser model runtime |
| `onnxruntime-node` | MIT | The native runtime for Whisper Large V3 |
| `@scure/bip39` | MIT | The recovery phrase word list |

`web/whisper-alignment.ts` contains code ported from Transformers.js 3.8.1 (Copyright Hugging Face, Apache-2.0), and `patches/` holds a patch to Transformers.js 4.3.2 under the same licence.

Development-only packages (build tools, linters, test runners) are not shipped with Echo. CI runs `pnpm audit --prod` on every push.

## Fonts and icons

| Asset | Licence |
| --- | --- |
| Mulish typeface | [SIL Open Font License 1.1](../public/fonts/OFL-Mulish.txt) |
| Lucide icons | ISC |

## Speech models

Echo does not include any model files. You download them from Hugging Face when you choose to, and they are covered by their own licences:

| Model | Source | Licence |
| --- | --- | --- |
| Whisper Large V3 Turbo | OpenAI, ONNX export by onnx-community | MIT |
| Whisper Large V3 | OpenAI, q8 ONNX export `Xenova/whisper-large-v3` | Apache-2.0 |
| PyAnnote segmentation 3.0 | pyannote, ONNX export `onnx-community/pyannote-segmentation-3.0` | MIT |
| WavLM Base Plus SV | Microsoft, ONNX export `Xenova/wavlm-base-plus-sv` | From Microsoft's `unilm` project, which is MIT; the model card itself states no licence |

Ollama models you pull are covered by their publishers' licences; check each model's page on [ollama.com](https://ollama.com/library).
