# Full Large V3 local engine

Whisper Large V3 runs in a native CPU process supervised by Echo's local server. Turbo and speaker grouping still run in the browser. This keeps the full model out of the browser's WebAssembly heap while preserving local processing and word timestamps.

## Setup

Install Node.js 22 or newer. In the Echo folder, run:

```bash
npm ci --ignore-scripts
```

Start Echo, open **Models**, and download **Whisper Large V3**. Echo downloads the pinned q8 model, executes its encoder and decoder, then checks the browser's speaker models before showing it as ready. Select it in **Settings → General**. A source build already installs these dependencies; a prebuilt archive needs this optional setup for full Large V3. Turbo remains available without a Node runtime.

The first download needs internet access. Later transcription uses only the local cache. The fixed checkpoint is `Xenova/whisper-large-v3` at revision `67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0`. The saved model selection remains `onnx-community/whisper-large-v3` for compatibility. The helper corrects this export's alignment metadata using the [official pinned Large V3 configuration](https://huggingface.co/openai/whisper-large-v3/blob/06f233fe06e710322aca913c1bc4249a0d71fce1/generation_config.json) and crops attention frames for Whisper's stride-two encoder; speech weights and text generation remain unchanged.

## Storage and lifecycle

Speech weights and the verified readiness marker live under `<data folder>/models/native-large-v3/`. Speaker models remain in the browser profile. Model files are excluded from library backup exports. Removing Large V3 through Models removes its native cache while retaining shared speaker files.

Only one native job can run at a time. The browser assigns a unique job ID before uploading decoded 16 kHz mono Float32 audio. Cancellation targets that exact job, including an interrupted upload. The server owns private request/audio files under the project's `tmp/` directory, removes them after completion, and stops its helper on cancellation or shutdown. A stdin lease also ends the helper if its parent disappears. On restart, after acquiring the library lock, the server removes abandoned job files from that library’s private temporary namespace; other libraries are left alone. Saved source audio and earlier transcripts remain intact after failures.

Audio decoding still happens in the browser and retains the existing 512 MB container and two-hour duration limits. Full Large V3 needs substantial memory and CPU time; the native engine does not make those costs disappear.

## Local API

All endpoints share the server's loopback and same-origin protections.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/speech` | Runtime availability, verified model readiness, active job |
| `POST /api/speech/jobs?operation=download&modelId=…&jobId=…` | Download and qualify the fixed model |
| `POST /api/speech/jobs?operation=transcribe&modelId=…&jobId=…&language=auto` | Submit raw little-endian Float32 audio with `application/octet-stream` |
| `GET /api/speech/jobs/{id}` | Progress, terminal error, or timestamped word result |
| `DELETE /api/speech/jobs/{id}` | Cancel exactly one job |
| `DELETE /api/speech/model` | Remove the native model while idle |

The API accepts model identifiers, operations, and supported languages only. Clients cannot supply executables, filesystem paths, or arbitrary model checkpoints.
