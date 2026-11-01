import {
  audioProcessor,
  segmentationProcessor,
  speechModel,
  tensorModel,
  workerRequest,
  record,
} from './guards.ts';
import type { Word } from './types/domain.ts';
import type { WorkerReply } from './types/worker.ts';
import {
  env,
  type AutomaticSpeechRecognitionPipeline,
  type PretrainedModelOptions,
  type PreTrainedModel,
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  AutoModelForXVector,
} from '@huggingface/transformers';
import {
  assertModel,
  speechModelConfig,
  assertWordTimestampSupport,
  DEFAULT_SPEECH_MODEL,
  SPEAKER_MODELS,
  MODEL_CACHE,
  MODEL_MANIFEST_CACHE,
  modelManifestUrl,
} from './models.ts';
import { diarize, speakerPassages } from './diarization.ts';
import { speechFailureMessage, traceSpeechChunks } from './speech-errors.ts';
import { wasmThreadCount } from './runtime-options.ts';
import { correctWhisperAlignment, validatedWhisperWords } from './whisper-alignment.ts';

const onnxWasm = env.backends.onnx.wasm;
if (!onnxWasm) throw new Error('The speech runtime returned an unknown error');
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
onnxWasm.wasmPaths = '/wasm/';
onnxWasm.numThreads = wasmThreadCount(
  globalThis.crossOriginIsolated,
  globalThis.navigator?.hardwareConcurrency,
);
onnxWasm.proxy = false;
const createTranscriber = pipeline as (
  task: 'automatic-speech-recognition',
  model: string,
  options: PretrainedModelOptions,
) => Promise<AutomaticSpeechRecognitionPipeline>;
const runtime = {
  threads: onnxWasm.numThreads,
  isolated: globalThis.crossOriginIsolated === true,
};

let transcriber: AutomaticSpeechRecognitionPipeline | null = null,
  loadedModel = '',
  busy = false,
  usedFiles = new Set<string>();
const keyOf = (request: RequestInfo | URL) =>
  typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (request, init) => {
  const response = await originalFetch(request, init),
    key = keyOf(request);
  if (response.ok && key.startsWith('https://huggingface.co/')) usedFiles.add(key);
  return response;
};
env.customCache = {
  async match(request: RequestInfo | URL) {
    const result = await (await caches.open(MODEL_CACHE)).match(request);
    if (result) usedFiles.add(keyOf(request));
    return result;
  },
  async put(request: RequestInfo | URL, response: Response) {
    await (await caches.open(MODEL_CACHE)).put(request, response);
    usedFiles.add(keyOf(request));
  },
};
/** Release the speech session before loading companion models or another job. */
async function unloadSpeech() {
  if (transcriber) await transcriber.dispose();
  transcriber = null;
  loadedModel = '';
}
const postReply = (reply: WorkerReply) => self.postMessage(reply);
self.addEventListener('message', async (event: MessageEvent<unknown>) => {
  const message = workerRequest(event.data);
  if (!message) {
    const raw = record(event.data);
    const id = raw['id'];
    // Unrelated messages have no reply address. Owned malformed jobs must settle.
    if (typeof id !== 'string') return;
    let modelName = 'Speech model';
    let error: unknown = new Error('Unsupported speech operation.');
    try {
      assertModel(typeof raw['modelId'] === 'string' ? raw['modelId'] : '');
      modelName = speechModelConfig(String(raw['modelId'])).name;
      if (['transcribe', 'diarize', 'transcribe-live'].includes(String(raw['type'])))
        error = new Error('No decoded audio was received.');
    } catch (caught) {
      error = caught;
    }
    postReply({
      id,
      type: 'error',
      error: speechFailureMessage(error, {
        download: ['download', 'download-companions'].includes(String(raw['type'])),
        phase: 'loading the speech model',
        modelName,
      }),
    });
    return;
  }
  const { id, type, modelId, audio, options = {} } = message;
  if (busy) {
    postReply({
      id,
      type: 'error',
      error: 'Wait for the current processing job to finish.',
    });
    return;
  }
  busy = true;
  let runtimeReported = false;
  const progress = (status: string, amount?: number, file?: string) => {
    postReply({
      id,
      type: 'progress',
      progress: { status, progress: amount, file, ...(!runtimeReported ? { runtime } : {}) },
    });
    runtimeReported = true;
  };
  const download = ['download', 'download-companions'].includes(type);
  const live = type === 'transcribe-live';
  const loadOptions: PretrainedModelOptions = {
    device: 'wasm',
    dtype: 'q8',
    local_files_only: !download,
    progress_callback: (value) =>
      progress(
        value.status === 'progress'
          ? 'Downloading model file'
          : value.status === 'done'
            ? 'Model file saved'
            : 'Loading model',
        'progress' in value ? value.progress : value.status === 'done' ? 100 : 0,
        'file' in value ? value.file : undefined,
      ),
  };
  let segmentation: PreTrainedModel | undefined,
    embedding: PreTrainedModel | undefined,
    reply: WorkerReply | undefined;
  let phase = 'loading the speech model';
  try {
    assertModel(modelId);
    if (
      !['download', 'transcribe', 'transcribe-live', 'download-companions', 'diarize'].includes(
        type,
      )
    )
      throw new Error('Unsupported speech operation.');
    if (live && modelId !== DEFAULT_SPEECH_MODEL)
      throw new Error('Live transcription requires the downloaded Large V3 Turbo model.');
    if (live && (!audio?.length || audio.length > 20 * 16000))
      throw new Error('Live audio must contain at most twenty seconds.');
    const native = speechModelConfig(modelId).engine === 'native';
    if (native !== ['download-companions', 'diarize'].includes(type))
      throw new Error('This speech model requires its configured local engine.');
    env.allowLocalModels = !download;
    usedFiles = new Set<string>();
    let words: Word[] = [];
    if (!native) {
      if (download || loadedModel !== modelId || !transcriber) {
        await unloadSpeech();
        progress(download ? 'Preparing download' : 'Loading speech model', 0);
        const config = speechModelConfig(modelId);
        transcriber = await createTranscriber('automatic-speech-recognition', config.checkpoint, {
          ...loadOptions,
          dtype: config.dtype ?? 'q8',
          revision: config.revision,
        });
        const speech = speechModel(transcriber.model);
        assertWordTimestampSupport(speech.sessions['decoder_model_merged']?.outputNames);
        correctWhisperAlignment(speech);
        loadedModel = modelId;
      }
      if (!download) {
        if (!audio?.length) throw new Error('No decoded audio was received.');
        progress('Transcribing on this device', 0);
        phase = 'transcribing audio and aligning word timestamps';
        // Final jobs own a fresh worker. A warm live model must not accumulate
        // progress wrappers around generate/session.run on every window.
        if (!live)
          traceSpeechChunks(
            speechModel(transcriber.model),
            audio.length,
            (value) => postReply({ id, type: 'progress', progress: value }),
            (next) => {
              phase = next;
            },
          );
        if (!transcriber) throw new Error('The speech model returned no word timestamps.');
        const output: unknown = await transcriber(audio, {
          return_timestamps: 'word',
          chunk_length_s: 29,
          stride_length_s: 5,
          ...(options.language && options.language !== 'auto'
            ? { language: options.language, task: 'transcribe' }
            : {}),
        });
        const result: unknown = Array.isArray(output) ? output[0] : output;
        words = validatedWhisperWords(result, audio.length / 16000);
      }
    } else if (!download) {
      if (!audio?.length || !Array.isArray(options.words))
        throw new Error('The local speech engine did not return word timestamps.');
      words = options.words;
    }
    if (live) {
      progress('Live transcript ready', 100);
      reply = {
        id,
        type: 'result',
        result: {
          words,
          duration: (audio?.length ?? 0) / 16000,
          model: modelId,
          modelRevision: speechModelConfig(modelId).revision,
        },
      };
      return;
    }
    // Release browser speech before loading the two smaller speaker models.
    await unloadSpeech();
    phase = 'loading speaker recognition';
    progress(download ? 'Preparing speaker recognition' : 'Loading speaker recognition', 0);
    segmentation = await AutoModelForAudioFrameClassification.from_pretrained(
      SPEAKER_MODELS.segmentation,
      { ...loadOptions, dtype: 'fp32' },
    );
    const segmentProcessor = await AutoProcessor.from_pretrained(
      SPEAKER_MODELS.segmentation,
      loadOptions,
    );
    embedding = await AutoModelForXVector.from_pretrained(SPEAKER_MODELS.embedding, loadOptions);
    const embedProcessor = await AutoProcessor.from_pretrained(
      SPEAKER_MODELS.embedding,
      loadOptions,
    );
    if (download) {
      phase = 'verifying the downloaded model cache';
      if (!usedFiles.size)
        throw new Error('Model cache could not be verified. Check browser storage and retry.');
      const cache = await caches.open(MODEL_CACHE);
      if (!(await Promise.all([...usedFiles].map((file) => cache.match(file)))).every(Boolean))
        throw new Error('The browser could not save every model file. Free storage and retry.');
      const config = speechModelConfig(modelId);
      await (
        await caches.open(MODEL_MANIFEST_CACHE)
      ).put(
        modelManifestUrl(modelId),
        new Response(
          JSON.stringify({
            files: [...usedFiles],
            ...(native
              ? { engine: 'native-companions-v1', speakerModels: SPEAKER_MODELS }
              : {
                  checkpoint: config.checkpoint,
                  revision: config.revision,
                  precision: config.precision ?? 'q8',
                  wordTimestamps: true,
                }),
            createdAt: new Date().toISOString(),
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );
      progress('Ready for offline transcription and speaker recognition', 100);
      reply = { id, type: 'result' };
      return;
    }
    const speakers = options.speakers || [];
    phase = 'recognizing speakers';
    const turns = words.length
      ? await diarize(
          audio ?? new Float32Array(),
          tensorModel(segmentation, 'logits'),
          segmentationProcessor(segmentProcessor),
          tensorModel(embedding, 'embeddings'),
          audioProcessor(embedProcessor),
          speakers,
          progress,
        )
      : [];
    const duration = (audio?.length ?? 0) / 16000;
    const passages = speakerPassages(words, turns, duration);
    progress('Transcript ready', 100);
    reply = { id, type: 'result', result: { passages, speakers, model: modelId, duration } };
  } catch (error) {
    const modelName = (() => {
      try {
        return speechModelConfig(modelId).name;
      } catch {
        return 'Speech model';
      }
    })();
    const message = speechFailureMessage(error, { download, phase, modelName });
    reply = { id, type: 'error', error: message };
  } finally {
    if (!live || reply?.type !== 'result') await unloadSpeech().catch(() => {});
    await segmentation?.dispose().catch(() => {});
    await embedding?.dispose().catch(() => {});
    busy = false;
    if (reply) postReply(reply);
  }
});
