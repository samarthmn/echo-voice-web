export const MODEL_CACHE = 'echo-voice-models-v1';
export const MODEL_MANIFEST_CACHE = 'echo-voice-model-manifests-v2';
export const DEFAULT_SPEECH_MODEL = 'onnx-community/whisper-large-v3-turbo';
export const SPEAKER_MODELS = {
  segmentation: 'onnx-community/pyannote-segmentation-3.0',
  embedding: 'Xenova/wavlm-base-plus-sv',
};
export const MODELS = [
  { id: DEFAULT_SPEECH_MODEL, name: 'Whisper Large V3 Turbo', label: 'Whisper Large V3 Turbo', size: '~900 MB', sizeMB: 900, description: 'Faster multilingual transcription. Includes automatic speaker grouping.', language: 'Multilingual', recommended: true },
  { id: 'onnx-community/whisper-large-v3', name: 'Whisper Large V3', label: 'Whisper Large V3', size: '~1.7 GB', sizeMB: 1700, description: 'Full Large V3 model. Requires more memory and processing time.', language: 'Multilingual', recommended: false },
];
/** Keep saved meetings usable after retiring Tiny and Base. */
export function resolveSpeechModel(id) {
  return ['onnx-community/whisper-tiny.en', 'onnx-community/whisper-base', undefined, null, ''].includes(id) ? DEFAULT_SPEECH_MODEL : id;
}
/** Build the same-origin cache key for one complete model download. */
export function modelManifestUrl(id) { return `${globalThis.location.origin}/__echo_models/${encodeURIComponent(id)}`; }
/** Reject model identifiers outside the supported speech catalog. */
export function assertModel(id) {
  if (!MODELS.some(model => model.id === id)) throw new Error('Choose one of the supported speech models.');
}
