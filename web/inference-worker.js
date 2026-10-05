import { env, pipeline, AutoProcessor, AutoModelForAudioFrameClassification, AutoModelForXVector } from '@huggingface/transformers';
import { assertModel, speechModelConfig, assertWordTimestampSupport, SPEAKER_MODELS, MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl } from './models.js';
import { diarize, speakerPassages } from './diarization.js';
import { speechFailureMessage, traceSpeechChunks } from './speech-errors.js';
import { wasmThreadCount } from './runtime-options.js';
import { alternateSpeechSessions, verifySpeechForward } from './speech-sessions.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.backends.onnx.wasm.wasmPaths = '/wasm/';
env.backends.onnx.wasm.numThreads = wasmThreadCount(globalThis.crossOriginIsolated, globalThis.navigator?.hardwareConcurrency);
env.backends.onnx.wasm.proxy = false;
const runtime = { threads: env.backends.onnx.wasm.numThreads, isolated: globalThis.crossOriginIsolated === true };

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
/** Release the speech session before loading companion models or another job. */
async function unloadSpeech() {
  if (transcriber) await transcriber.dispose();
  transcriber = null; loadedModel = '';
}
self.addEventListener('message', async event => {
  const { id, type, modelId, audio, options = {} } = event.data;
  if (busy) { self.postMessage({ id, type: 'error', error: 'Wait for the current processing job to finish.' }); return; }
  busy = true;
  let runtimeReported = false;
  const progress = (status, amount, file) => {
    self.postMessage({ id, type: 'progress', progress: { status, progress: amount, file, ...(!runtimeReported ? { runtime } : {}) } });
    runtimeReported = true;
  };
  const download = type === 'download';
  const loadOptions = {
    device: 'wasm', dtype: 'q8', local_files_only: !download,
    progress_callback: value => progress(value.status === 'progress' ? 'Downloading model file' : value.status === 'done' ? 'Model file saved' : 'Loading model', value.progress ?? (value.status === 'done' ? 100 : 0), value.file),
  };
  let segmentation, embedding, reply, lifecycle, forwardVerified = false;
  let phase = 'loading the speech model';
  try {
    assertModel(modelId);
    if (!['download', 'transcribe'].includes(type)) throw new Error('Unsupported speech operation.');
    env.allowLocalModels = !download;
    if (download || loadedModel !== modelId || !transcriber) {
      await unloadSpeech(); usedFiles = new Set();
      progress(download ? 'Preparing download' : 'Loading speech model', 0);
      const config = speechModelConfig(modelId);
      transcriber = await pipeline('automatic-speech-recognition', config.checkpoint, { ...loadOptions, dtype: config.dtype ?? 'q8', session_options: config.session_options, revision: config.revision });
      assertWordTimestampSupport(transcriber.model.sessions.decoder_model_merged.outputNames);
      if (config.requireForwardVerification) lifecycle = alternateSpeechSessions(transcriber.model, config, await caches.open(MODEL_CACHE));
      loadedModel = modelId;
    }
    let words = [];
    if (download && lifecycle) {
      phase = 'checking local speech execution';
      progress('Checking local transcription', 0);
      forwardVerified = await verifySpeechForward(transcriber, lifecycle);
    } else if (!download) {
      if (!audio?.length) throw new Error('No decoded audio was received.');
      progress('Transcribing on this device', 0);
      phase = 'transcribing audio and aligning word timestamps';
      traceSpeechChunks(transcriber.model, audio.length,
        value => self.postMessage({ id, type: 'progress', progress: value }),
        next => { phase = next; });
      const output = await transcriber(audio, {
        return_timestamps: 'word', chunk_length_s: 29, stride_length_s: 5,
        ...(options.language && options.language !== 'auto' ? { language: options.language, task: 'transcribe' } : {}),
      });
      const result = Array.isArray(output) ? output[0] : output;
      words = result.chunks || [];
      if (result.text?.trim() && !words.length) throw new Error('Word timestamps could not be created. Retry transcription to recognize speaker changes.');
    }
    // Release Large V3 before loading the two smaller speaker models.
    await unloadSpeech();
    phase = 'loading speaker recognition';
    progress(download ? 'Preparing speaker recognition' : 'Loading speaker recognition', 0);
    segmentation = await AutoModelForAudioFrameClassification.from_pretrained(SPEAKER_MODELS.segmentation, { ...loadOptions, dtype: 'fp32' });
    const segmentProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.segmentation, loadOptions);
    embedding = await AutoModelForXVector.from_pretrained(SPEAKER_MODELS.embedding, loadOptions);
    const embedProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.embedding, loadOptions);
    if (download) {
      phase = 'verifying the downloaded model cache';
      if (!usedFiles.size) throw new Error('Model cache could not be verified. Check browser storage and retry.');
      const cache = await caches.open(MODEL_CACHE);
      if (!(await Promise.all([...usedFiles].map(file => cache.match(file)))).every(Boolean)) throw new Error('The browser could not save every model file. Free storage and retry.');
      const config = speechModelConfig(modelId);
      await (await caches.open(MODEL_MANIFEST_CACHE)).put(modelManifestUrl(modelId), new Response(JSON.stringify({ files: [...usedFiles], checkpoint: config.checkpoint, revision: config.revision, precision: config.precision ?? 'q8', wordTimestamps: true, ...(config.requireForwardVerification ? { forwardVerified } : {}), createdAt: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }));
      progress('Ready for offline transcription and speaker recognition', 100);
      reply = { id, type: 'result' }; return;
    }
    const speakers = options.speakers || [];
    phase = 'recognizing speakers';
    const turns = words.length ? await diarize(audio, segmentation, segmentProcessor, embedding, embedProcessor, speakers, progress) : [];
    const duration = audio.length / 16000;
    const passages = speakerPassages(words, turns, duration);
    progress('Transcript ready', 100);
    reply = { id, type: 'result', result: { passages, speakers, model: modelId, duration } };
  } catch (error) {
    const modelName = (() => { try { return speechModelConfig(modelId).name; } catch { return 'Speech model'; } })();
    const message = speechFailureMessage(error, { download, phase, modelName });
    reply = { id, type: 'error', error: message };
  } finally {
    await unloadSpeech().catch(() => {});
    await segmentation?.dispose().catch(() => {});
    await embedding?.dispose().catch(() => {});
    busy = false;
    if (reply) self.postMessage(reply);
  }
});
