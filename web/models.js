export const MODEL_CACHE = 'echo-voice-models-v1';
export const MODEL_MANIFEST_CACHE = 'echo-voice-model-manifests-v1';

export const MODELS = [
  { id: 'onnx-community/whisper-tiny.en', name: 'Whisper Tiny', label: 'Whisper Tiny', size: '~75 MB', sizeMB: 75, description: 'Fast English transcription. A good starting point for most laptops.', language: 'English', recommended: true },
  { id: 'onnx-community/whisper-base', name: 'Whisper Base', label: 'Whisper Base', size: '~145 MB', sizeMB: 145, description: 'Multilingual transcription with greater accuracy. Uses more memory.', language: 'Multilingual', recommended: false },
];

export function modelManifestUrl(id) { return `${globalThis.location.origin}/__echo_models/${encodeURIComponent(id)}`; }
export function assertModel(id) {
  if (!MODELS.some(model => model.id === id)) throw new Error('Choose one of the supported speech models.');
}
