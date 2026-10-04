import { env, pipeline, AutoProcessor, AutoModelForAudioFrameClassification, AutoModelForXVector } from '@huggingface/transformers';
import { assertModel, SPEAKER_MODELS, MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl } from './models.js';
import { diarize, speakerPassages } from './diarization.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.backends.onnx.wasm.wasmPaths = '/wasm/';
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let transcriber = null, loadedModel = '', busy = false, usedFiles = new Set();
const keyOf = request => typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (request, init) => {
  const response = await originalFetch(request, init), key = keyOf(request);
  if (response.ok && key.startsWith('https://huggingface.co/')) usedFiles.add(key);
  return response;
};
env.customCache = {
  async match(request) {
    const result = await (await caches.open(MODEL_CACHE)).match(request);
    if (result) usedFiles.add(keyOf(request));
    return result;
  },
  async put(request, response) {
    await (await caches.open(MODEL_CACHE)).put(request, response);
    usedFiles.add(keyOf(request));
  },
};
async function unloadSpeech() {
  if (transcriber) await transcriber.dispose();
  transcriber = null; loadedModel = '';
}
self.addEventListener('message', async event => {
  const { id, type, modelId, audio, options = {} } = event.data;
  if (busy) { self.postMessage({ id, type: 'error', error: 'Wait for the current processing job to finish.' }); return; }
  busy = true;
  const progress = (status, amount, file) => self.postMessage({ id, type: 'progress', progress: { status, progress: amount, file } });
  const download = type === 'download';
  const loadOptions = {
    device: 'wasm', dtype: 'q8', local_files_only: !download,
    progress_callback: value => progress(value.status === 'progress' ? 'Downloading model file' : value.status === 'done' ? 'Model file saved' : 'Loading model', value.progress ?? (value.status === 'done' ? 100 : 0), value.file),
  };
  let segmentation, embedding, reply;
  try {
    assertModel(modelId);
    if (!['download', 'transcribe'].includes(type)) throw new Error('Unsupported speech operation.');
    env.allowLocalModels = !download;
    if (download || loadedModel !== modelId || !transcriber) {
      await unloadSpeech(); usedFiles = new Set();
      progress(download ? 'Preparing download' : 'Loading speech model', 0);
      transcriber = await pipeline('automatic-speech-recognition', modelId, loadOptions);
      loadedModel = modelId;
    }
    let words = [];
    if (!download) {
      if (!audio?.length) throw new Error('No decoded audio was received.');
      progress('Transcribing on this device', 0);
      const output = await transcriber(audio, {
        return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5,
        ...(options.language && options.language !== 'auto' ? { language: options.language, task: 'transcribe' } : {}),
      });
      const result = Array.isArray(output) ? output[0] : output;
      words = result.chunks || [];
      if (result.text?.trim() && !words.length) throw new Error('Word timestamps could not be created. Retry transcription to recognize speaker changes.');
    }
    // Release Large V3 before loading the two smaller speaker models.
    await unloadSpeech();
    progress(download ? 'Preparing speaker recognition' : 'Loading speaker recognition', 0);
    segmentation = await AutoModelForAudioFrameClassification.from_pretrained(SPEAKER_MODELS.segmentation, { ...loadOptions, dtype: 'fp32' });
    const segmentProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.segmentation, loadOptions);
    embedding = await AutoModelForXVector.from_pretrained(SPEAKER_MODELS.embedding, loadOptions);
    const embedProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.embedding, loadOptions);
    if (download) {
      if (!usedFiles.size) throw new Error('Model cache could not be verified. Check browser storage and retry.');
      const cache = await caches.open(MODEL_CACHE);
      if (!(await Promise.all([...usedFiles].map(file => cache.match(file)))).every(Boolean)) throw new Error('The browser could not save every model file. Free storage and retry.');
      await (await caches.open(MODEL_MANIFEST_CACHE)).put(modelManifestUrl(modelId), new Response(JSON.stringify({ files: [...usedFiles], createdAt: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }));
      progress('Ready for offline transcription and speaker recognition', 100);
      reply = { id, type: 'result' }; return;
    }
    const speakers = options.speakers || [];
    const turns = words.length ? await diarize(audio, segmentation, segmentProcessor, embedding, embedProcessor, speakers, progress) : [];
    const duration = audio.length / 16000;
    const passages = speakerPassages(words, turns, duration);
    progress('Transcript ready', 100);
    reply = { id, type: 'result', result: { passages, speakers, model: modelId, duration } };
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Local speech processing failed.';
    if (download && /failed to fetch|networkerror|network request|fetch failed/i.test(message)) message = 'Could not reach Hugging Face. Check your connection and retry. Completed files are kept.';
    if (/quota/i.test(message)) message = 'Browser model storage is full. Free disk space or remove an unused model, then retry.';
    if (/out of memory|memory access|allocation|bad_alloc/i.test(message)) message = 'This device ran out of memory. Close other tabs and try Large V3 Turbo or a computer with more memory.';
    reply = { id, type: 'error', error: message };
  } finally {
    await unloadSpeech().catch(() => {});
    await segmentation?.dispose().catch(() => {});
    await embedding?.dispose().catch(() => {});
    busy = false;
    if (reply) self.postMessage(reply);
  }
});
