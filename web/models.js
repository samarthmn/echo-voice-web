export const MODEL_CACHE = 'echo-voice-models-v1';
export const MODEL_MANIFEST_CACHE = 'echo-voice-model-manifests-v2';
export const NATIVE_SPEECH_MODEL = 'onnx-community/whisper-large-v3';
export const DEFAULT_SPEECH_MODEL = 'onnx-community/whisper-large-v3-turbo';
export const SPEAKER_MODELS = {
  segmentation: 'onnx-community/pyannote-segmentation-3.0',
  embedding: 'Xenova/wavlm-base-plus-sv',
};
export const MODELS = [
  { id: DEFAULT_SPEECH_MODEL, checkpoint: 'onnx-community/whisper-large-v3-turbo_timestamped', revision: 'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a', name: 'Whisper Large V3 Turbo', label: 'Whisper Large V3 Turbo', size: '~1.2 GB', sizeMB: 1200, description: 'Faster multilingual transcription. Includes automatic speaker grouping.', language: 'Multilingual', recommended: true },
  { id: 'onnx-community/whisper-large-v3', checkpoint: 'Xenova/whisper-large-v3', revision: '67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, engine: 'native', precision: 'q8', name: 'Whisper Large V3', label: 'Whisper Large V3', size: '~1.7 GB', sizeMB: 1700, description: 'Full multilingual model. Uses the local Node.js speech engine.', language: 'Multilingual', recommended: false },
];
/** Stable saved IDs resolve to pinned exports with word-timestamp attention outputs. */
export function speechModelConfig(id) {
  assertModel(id);
  return MODELS.find(model => model.id === id);
}
/** A precision update must not advertise older, larger cached weights as ready. */
export function speechManifestMatches(data, model) {
  if (model.engine === 'native') return data.engine === 'native-companions-v1' && JSON.stringify(data.speakerModels) === JSON.stringify(SPEAKER_MODELS);
  return data.checkpoint === model.checkpoint && data.revision === model.revision
    && data.wordTimestamps === true && (data.precision ?? 'q8') === (model.precision ?? 'q8');
}
/** Refuse incompatible exports during download, before marking offline readiness. */
export function assertWordTimestampSupport(outputNames) {
  if (!outputNames?.some(name => name.startsWith('cross_attentions.'))) throw new Error('This speech model cannot create word timestamps. Download the updated model in Models and retry.');
}
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
