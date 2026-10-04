import { env, pipeline } from '@huggingface/transformers';
import { assertModel, MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl } from './models.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.backends.onnx.wasm.wasmPaths = '/wasm/';
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let transcriber = null;
let loadedModel = '';
let busy = false;
let usedFiles = new Set();
const keyOf = (request) => typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (request, init) => {
  const response = await originalFetch(request, init);
  const key = keyOf(request);
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

self.addEventListener('message', async (event) => {
  const { id, type, modelId, audio } = event.data;
  const progress = (status, amount, file) => self.postMessage({ id, type: 'progress', progress: { status, progress: amount, file } });
  try {
    if (busy) throw new Error('Another local inference job is running. Wait for it to finish.');
    busy = true; assertModel(modelId);
    if (type === 'download' || loadedModel !== modelId || !transcriber) {
      if (transcriber) { await transcriber.dispose(); transcriber = null; loadedModel = ''; }
      usedFiles = new Set();
      // Transformers.js requires allowLocalModels when local_files_only is set.
      // Successful cache hits are checked before any local URL request.
      env.allowLocalModels = type !== 'download';
      progress(type === 'download' ? 'Preparing download' : 'Loading local model', 0);
      transcriber = await pipeline('automatic-speech-recognition', modelId, {
        device: 'wasm', dtype: 'q8', local_files_only: type !== 'download',
        progress_callback: (value) => {
          const info = value;
          progress(info.status === 'progress' ? 'Downloading model file' : info.status === 'done' ? 'Model file saved' : 'Loading model', info.progress ?? (info.status === 'done' ? 100 : 0), info.file);
        },
      });
      loadedModel = modelId;
      if (type === 'download') {
        if (!usedFiles.size) throw new Error('Model cache could not be verified. Check available browser storage and try again.');
        const cache = await caches.open(MODEL_CACHE);
        if (!(await Promise.all([...usedFiles].map(file => cache.match(file)))).every(Boolean)) throw new Error('The browser could not save every model file. Free some browser storage, then download again.');
        await (await caches.open(MODEL_MANIFEST_CACHE)).put(modelManifestUrl(modelId), new Response(JSON.stringify({ files: [...usedFiles], createdAt: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }));
      }
    }
    if (type === 'download') {
      progress('Ready for offline transcription', 100);
      self.postMessage({ id, type: 'result' }); return;
    }
    if (!audio?.length) throw new Error('No decoded audio was received.');
    progress('Transcribing on this device', 0);
    const output = await transcriber(audio, {
      return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
    });
    const result = Array.isArray(output) ? output[0] : output;
    const duration = audio.length / 16000;
    const passages = (result.chunks || [{ text: result.text, timestamp: [0, duration] }]).filter(chunk => chunk.text.trim()).map(chunk => ({ id: crypto.randomUUID(), text: chunk.text.trim(), start: Math.max(0, chunk.timestamp[0] ?? 0), end: Math.min(duration, chunk.timestamp[1] ?? duration), speaker: 'Speaker' }));
    progress('Transcript ready', 100);
    self.postMessage({ id, type: 'result', result: { passages, model: modelId, duration } });
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Local speech processing failed.';
    if (type === 'download' && /failed to fetch|networkerror|network request|fetch failed/i.test(message)) message = 'The model download could not reach Hugging Face. Check your internet connection or network restrictions, then retry. Completed files are kept for the retry.';
    if (/quota/i.test(message)) message = 'The browser has run out of model storage. Remove an unused model or free disk space, then retry.';
    self.postMessage({ id, type: 'error', error: message });
  } finally { busy = false; }
});
