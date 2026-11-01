import {
  apiError,
  record,
  transcriptResult,
  heartbeat,
  manifest as parseManifest,
  meetingDetails as parseMeeting,
  meetingIdentity,
  responseJson,
  settings as parseSettings,
  vocabulary as parseVocabulary,
  workerReply,
} from './guards.ts';
import type { DownloadState, Meeting, Progress, Speaker, VocabularyEntry } from './types/domain.ts';
import type {
  InferenceOptions,
  LiveOptions,
  LiveResult,
  TranscriptResult,
  WorkerOperation,
  WorkerRequest,
} from './types/worker.ts';
interface LiveJob {
  jobId: string;
  controller: AbortController;
  fail?: ((error: unknown) => void) | null;
}
import { errorInfo } from './guards.ts';
import {
  resolveSpeechModel,
  assertModel,
  speechModelConfig,
  speechManifestMatches,
  DEFAULT_SPEECH_MODEL,
  MODEL_CACHE,
  MODEL_MANIFEST_CACHE,
  modelManifestUrl,
  MODELS,
} from './models.ts';
import {
  TRANSCRIPTION_CANCELLED,
  automaticTranscriptionEligible,
} from './automatic-transcription.ts';
import { createProcessingHeartbeat } from './processing-heartbeat.ts';
import { getNativeSpeechStatus, runNativeSpeech, cancelNativeSpeech } from './native-speech.ts';
import { validatedWhisperWords } from './whisper-alignment.ts';

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
let rejectActive: ((error: unknown) => void) | null = null;
let normalPending = 0;
let liveWorker: Worker | null = null,
  liveJob: LiveJob | null = null;
const activeAudioFetches = new Set<AbortController>();
const pendingDownloads = new Map<string, Promise<void>>();
let downloadState: DownloadState & { modelId: string } = {
  status: 'idle',
  modelId: '',
  progress: 0,
};
const isAborted = (signal: AbortSignal) => signal.aborted;
const cancelled = () => new DOMException(TRANSCRIPTION_CANCELLED, 'AbortError');

/** Expose download state independently of the currently mounted workspace page. */
export function getModelDownloadState() {
  return { ...downloadState };
}
function publishDownload(state: DownloadState & { modelId: string }) {
  downloadState = { ...state };
  window.dispatchEvent(
    new CustomEvent('echo-model-download-state', { detail: getModelDownloadState() }),
  );
}

/** Queue speech operations so downloads, cache changes, and transcription do not overlap. */
function serial<T>(operation: () => Promise<T>): Promise<T> {
  normalPending++;
  releaseLiveInference();
  publishInferenceState();
  const token = generation;
  const result = queue
    .catch(() => {
      /* The next queued job must run even if its predecessor fails. */
    })
    .then(() => {
      if (token !== generation) throw cancelled();
      return operation();
    });
  const settled = result.finally(() => {
    normalPending--;
    publishInferenceState();
  });
  queue = settled.catch(() => {
    /* The queue remains usable after a failed or cancelled job. */
  });
  return settled;
}

/** Live jobs share a warm ASR worker, but never the final processing queue. */
export function getInferenceState() {
  return {
    busy: normalPending > 0 || processingMeetings.size > 0,
    liveJobId: liveJob?.jobId ?? null,
  };
}
function publishInferenceState() {
  window.dispatchEvent(new CustomEvent('echo-inference-state', { detail: getInferenceState() }));
}
export function cancelLiveInference(jobId: string) {
  if (liveJob?.jobId !== jobId) return false;
  liveJob.controller.abort();
  liveJob.fail?.(cancelled());
  liveWorker?.terminate();
  liveWorker = null;
  return true;
}
export function releaseLiveInference() {
  if (liveJob) cancelLiveInference(liveJob.jobId);
  liveWorker?.terminate();
  liveWorker = null;
}
export async function getLiveModelStatus() {
  if (typeof caches === 'undefined') return { ready: false, modelId: DEFAULT_SPEECH_MODEL };
  const model = speechModelConfig(DEFAULT_SPEECH_MODEL);
  const manifest = await (
    await caches.open(MODEL_MANIFEST_CACHE)
  ).match(modelManifestUrl(model.id));
  const data = parseManifest(manifest ? await responseJson(manifest).catch(() => null) : null);
  const cache = await caches.open(MODEL_CACHE);
  const ready = !!(
    data &&
    speechManifestMatches(data, model) &&
    Array.isArray(data.files) &&
    data.files.length &&
    (await Promise.all(data.files.map((file) => cache.match(file)))).every(Boolean)
  );
  return { ready, modelId: model.id, modelRevision: model.revision };
}
export async function transcribeLiveWindow(
  audio: Float32Array,
  { jobId = crypto.randomUUID(), language = 'auto', signal, onProgress }: LiveOptions = {},
): Promise<LiveResult> {
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > 20 * 16000)
    throw new Error('Live audio must contain at most twenty seconds.');
  if (getInferenceState().busy || liveJob)
    throw Object.assign(new Error('Local processing is busy.'), { code: 'processing-busy' });
  const job: LiveJob = { jobId, controller: new AbortController() };
  const duration = audio.length / 16000;
  liveJob = job;
  const abort = () => cancelLiveInference(jobId);
  signal?.addEventListener('abort', abort, { once: true });
  publishInferenceState();
  try {
    if (signal?.aborted) abort();
    const model = await getLiveModelStatus();
    if (isAborted(job.controller.signal)) throw cancelled();
    if (!model.ready)
      throw Object.assign(
        new Error('Download Large V3 Turbo in Models to enable live transcription.'),
        { code: 'model-missing' },
      );
    if (getInferenceState().busy)
      throw Object.assign(new Error('Local processing is busy.'), { code: 'processing-busy' });
    if (typeof Worker === 'undefined')
      throw new Error('This browser does not support local speech processing.');
    const url = new URL('/js/inference-worker.js', location.origin);
    const version = window.echoAssetVersions?.['/js/inference-worker.js'];
    if (version) url.searchParams.set('v', version);
    liveWorker ??= new Worker(url, { type: 'module' });
    const currentWorker = liveWorker;
    const result = await new Promise<unknown>((resolve, reject: (reason?: unknown) => void) => {
      let settled = false;
      const cleanup = () => {
        currentWorker.removeEventListener('message', message);
        currentWorker.removeEventListener('error', error);
        job.fail = null;
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        currentWorker.terminate();
        if (liveWorker === currentWorker) liveWorker = null;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original API/runtime rejection value and its identity for existing error handling.
        reject(reason);
      };
      const message = (event: MessageEvent<unknown>) => {
        const data = workerReply(event.data);
        if (!data) {
          if (record(event.data)['id'] === jobId)
            fail(new Error('Live speech returned an invalid audio duration.'));
          return;
        }
        if (data.id !== jobId || settled) return;
        if (data.type === 'progress') {
          try {
            onProgress?.(data.progress);
          } catch (error) {
            console.error('Progress callback failed.', error);
          }
        } else if (data.type === 'result') {
          settled = true;
          cleanup();
          resolve(data.result);
        } else fail(new Error(data.error));
      };
      const error = (event: ErrorEvent) => {
        fail(new Error(event.message || 'Live speech processing stopped unexpectedly.'));
      };
      job.fail = fail;
      currentWorker.addEventListener('message', message);
      currentWorker.addEventListener('error', error);
      try {
        currentWorker.postMessage(
          {
            id: jobId,
            type: 'transcribe-live',
            modelId: DEFAULT_SPEECH_MODEL,
            audio,
            options: { language },
          },
          [audio.buffer as ArrayBuffer],
        );
      } catch (error) {
        fail(error);
      }
    });
    if (isAborted(job.controller.signal)) throw cancelled();
    const value = record(result);
    if (value['duration'] !== duration)
      throw new Error('Live speech returned an invalid audio duration.');
    const words = validatedWhisperWords({ chunks: value['words'] }, duration);
    if (
      typeof value['modelRevision'] !== 'string' ||
      value['modelRevision'] !== model.modelRevision
    )
      throw new Error('Live speech returned an unexpected model revision.');
    return { ...value, duration, modelRevision: value['modelRevision'], words };
  } catch (error) {
    if (liveWorker && liveJob === job) {
      liveWorker.terminate();
      liveWorker = null;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (liveJob === job) liveJob = null;
    publishInferenceState();
  }
}

/** Dispatch one worker job and forward its progress until a result or failure arrives. */
function callWorker(
  type: 'download' | 'download-companions',
  modelId: string,
  onProgress?: (progress: Progress) => void,
  audio?: Float32Array,
  options?: InferenceOptions,
): Promise<void>;
function callWorker(
  type: 'transcribe' | 'diarize',
  modelId: string,
  onProgress: ((progress: Progress) => void) | undefined,
  audio: Float32Array,
  options?: InferenceOptions,
): Promise<TranscriptResult>;
function callWorker(
  type: WorkerOperation,
  modelId: string,
  onProgress?: (progress: Progress) => void,
  audio?: Float32Array,
  options?: InferenceOptions,
): Promise<void | TranscriptResult> {
  if (typeof Worker === 'undefined')
    return Promise.reject(
      new Error(
        'This browser does not support local speech processing. Try a current Chrome, Edge, Firefox, or Safari browser.',
      ),
    );
  const workerUrl = new URL('/js/inference-worker.js', location.origin);
  const workerVersion = window.echoAssetVersions?.['/js/inference-worker.js'];
  if (workerVersion) workerUrl.searchParams.set('v', workerVersion);
  worker ??= new Worker(workerUrl, { type: 'module' });
  const currentWorker = worker;
  return new Promise<void | TranscriptResult>((resolve, reject: (reason?: unknown) => void) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      currentWorker.removeEventListener('message', message);
      currentWorker.removeEventListener('error', error);
      // Disposing ONNX sessions does not return their grown WASM heap to the
      // browser. Release the entire worker after each terminal result so a
      // failed Large V3 job cannot poison a later model or queued operation.
      currentWorker.terminate();
      if (worker === currentWorker) worker = null;
      rejectActive = null;
    };
    const fail = (reason: unknown) => {
      cleanup();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original API/runtime rejection value and its identity for existing error handling.
      reject(reason);
    };
    const message = (event: MessageEvent<unknown>) => {
      const data = workerReply(event.data);
      if (!data) {
        if (record(event.data)['id'] === id)
          fail(new Error('The speech model returned no word timestamps.'));
        return;
      }
      if (data.id !== id) return;
      if (data.type === 'progress') {
        if (data.progress.runtime)
          console.warn('[Echo inference] WASM runtime ' + JSON.stringify(data.progress.runtime));
        try {
          onProgress?.(data.progress);
        } catch (error) {
          console.error('Progress callback failed.', error);
        }
      } else if (data.type === 'result') {
        cleanup();
        if (type === 'download' || type === 'download-companions') resolve();
        else {
          try {
            resolve(transcriptResult(data.result));
          } catch (error) {
            fail(error);
          }
        }
      } else fail(new Error(data.error));
    };
    const error = (event: ErrorEvent) => {
      fail(
        new Error(
          event.message ||
            'Local speech processing stopped unexpectedly. Try Large V3 Turbo or close other tabs and retry.',
        ),
      );
    };
    rejectActive = fail;
    currentWorker.addEventListener('message', message);
    currentWorker.addEventListener('error', error);
    try {
      const message: WorkerRequest =
        type === 'download' || type === 'download-companions'
          ? { id, type, modelId, audio, options }
          : { id, type, modelId, audio: audio ?? new Float32Array(), options };
      currentWorker.postMessage(message, audio ? [audio.buffer as ArrayBuffer] : []);
    } catch (error) {
      fail(error);
    }
  });
}

/** Terminate the worker and reject the current job without discarding downloaded files. */
export function cancelInference() {
  const meetingIds = [...processingMeetings]
    .filter(([, token]) => token === generation)
    .map(([id]) => id);
  void suppressAutomaticTranscription(meetingIds);
  if (meetingIds.length)
    window.dispatchEvent(
      new CustomEvent('echo-transcription-cancelled', { detail: { meetingIds } }),
    );
  generation++;
  cancelNativeSpeech();
  processingHeartbeat.clear();
  for (const controller of activeAudioFetches) controller.abort();
  worker?.terminate();
  worker = null;
  rejectActive?.(cancelled());
  rejectActive = null;
  releaseLiveInference();
}

/** Return only allowlisted models whose complete manifest still exists in browser cache. */
export async function getDownloadedModels() {
  if (typeof caches === 'undefined') return [];
  const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const files = await caches.open(MODEL_CACHE);
  const downloaded: string[] = [];
  const native = await getNativeSpeechStatus().catch(() => null);
  for (const model of MODELS) {
    const manifest = await manifests.match(modelManifestUrl(model.id));
    if (!manifest) continue;
    try {
      const data = parseManifest(await responseJson(manifest));
      // Keep older files, but require an updated export before advertising readiness.
      if (!data || !speechManifestMatches(data, model)) continue;
      if (
        data.files.length &&
        (await Promise.all(data.files.map((url) => files.match(url)))).every(Boolean)
      ) {
        if (model.engine !== 'native' || (native?.available === true && native.ready === true))
          downloaded.push(model.id);
      } else await manifests.delete(modelManifestUrl(model.id));
    } catch {
      await manifests.delete(modelManifestUrl(model.id));
    }
  }
  return downloaded;
}

/** Identify preserved legacy downloads that need timestamp-capable replacement weights. */
export async function getOutdatedModels() {
  if (typeof caches === 'undefined') return [];
  const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const outdated: string[] = [];
  for (const model of MODELS) {
    const manifest = await manifests.match(modelManifestUrl(model.id));
    if (!manifest) continue;
    try {
      const data = parseManifest(await responseJson(manifest));
      if (!data || !speechManifestMatches(data, model)) outdated.push(model.id);
    } catch {
      /* Malformed markers are handled by the readiness check. */
    }
  }
  return outdated;
}

/** Download an allowlisted speech model and verify it is usable from the local cache. */
export function downloadModel(
  id: string,
  onProgress?: (progress: Progress) => void,
): Promise<void> {
  assertModel(id);
  if (pendingDownloads.has(id)) return pendingDownloads.get(id) ?? Promise.resolve();
  const token = generation;
  if (!['queued', 'downloading'].includes(downloadState.status))
    publishDownload({ modelId: id, status: 'queued', progress: 0, detail: 'Preparing download…' });
  const job = serial(async () => {
    publishDownload({
      modelId: id,
      status: 'downloading',
      progress: 0,
      detail: 'Preparing download…',
    });
    if (typeof caches === 'undefined')
      throw new Error('Model storage requires a secure browser context. Open Echo on localhost.');
    await (navigator as { storage?: Partial<StorageManager> }).storage
      ?.persist?.()
      .catch(() => false);
    if (token !== generation) throw cancelled();
    const progress = (progress: Progress) => {
      publishDownload({
        modelId: id,
        status: 'downloading',
        progress: progress.progress || 0,
        detail: progress.status || 'Downloading…',
      });
      onProgress?.(progress);
    };
    const native = speechModelConfig(id).engine === 'native';
    if (native) {
      const status = await getNativeSpeechStatus();
      if (token !== generation) throw cancelled();
      if (!status.available)
        throw new Error(
          status.detail ||
            'Install Node.js 22 or newer and run pnpm install --frozen-lockfile to enable Full Large V3.',
        );
      await runNativeSpeech('download', undefined, 'auto', progress);
      if (token !== generation) throw cancelled();
    }
    await callWorker(native ? 'download-companions' : 'download', id, progress);
    if (native) {
      if (token !== generation) throw cancelled();
      if (!(await getDownloadedModels()).includes(id))
        throw new Error(
          'The local speech model and speaker files could not be verified. Retry the download.',
        );
      if (token !== generation) throw cancelled();
      // Only retire browser ASR weights after both replacement stages verify.
      // Speaker companions are shared with Turbo and must stay cached.
      const cache = await caches.open(MODEL_CACHE);
      for (const request of await cache.keys()) {
        const path = decodeURIComponent(new URL(request.url).pathname);
        if (
          [id, speechModelConfig(id).checkpoint].some((checkpoint) =>
            path.includes(`/${checkpoint}/`),
          )
        )
          await cache.delete(request);
      }
    }
  })
    .then(
      (result) => {
        publishDownload({ modelId: id, status: 'completed', progress: 100 });
        return result;
      },
      (error: unknown) => {
        publishDownload({
          modelId: id,
          status: errorInfo(error).name === 'AbortError' ? 'cancelled' : 'failed',
          progress: 0,
          error: errorInfo(error).message,
        });
        throw error;
      },
    )
    .finally(() => {
      if (pendingDownloads.get(id) === job) pendingDownloads.delete(id);
    });
  pendingDownloads.set(id, job);
  return job;
}

/** Remove a model's manifest and files while preserving files shared with other models. */
export function removeModel(id: string) {
  assertModel(id);
  cancelInference();
  return serial(async () => {
    if (speechModelConfig(id).engine === 'native') await requestJson('/speech/model', 'DELETE');
    const manifest = await caches.open(MODEL_MANIFEST_CACHE);
    await manifest.delete(modelManifestUrl(id));
    const cache = await caches.open(MODEL_CACHE);
    for (const request of await cache.keys()) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (
        [id, speechModelConfig(id).checkpoint].some((checkpoint) =>
          path.includes(`/${checkpoint}/`),
        )
      )
        await cache.delete(request);
    }
  });
}

/** Decode recording audio and resample it to the speech worker's 16 kHz input. */
async function decodeAudio(blob: Blob) {
  if (!blob.size)
    throw new Error('There is no audio to transcribe. Record or import some audio first.');
  if (blob.size > 512 * 1024 * 1024)
    throw new Error(
      'This audio exceeds the browser processing limit of 512 MB. Split it into smaller recordings.',
    );
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (buffer.duration > 7200)
      throw new Error(
        'For reliable browser processing, split recordings longer than two hours before importing.',
      );
    const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } catch (error) {
    if (error instanceof Error && error.message.includes('two hours')) throw error;
    throw new Error(
      'This browser could not decode the audio. Try WAV, MP3, or a recording made in this browser.',
      { cause: error },
    );
  } finally {
    await context.close();
  }
}

/** Run local speech inference on decoded audio using the selected supported model. */
export function transcribeAudio(
  blob: Blob,
  modelId: string,
  onProgress?: (progress: Progress) => void,
  options: InferenceOptions = {},
): Promise<TranscriptResult> {
  assertModel(modelId);
  const token = generation;
  return serial(async () => {
    if (!(await getDownloadedModels()).includes(modelId))
      throw new Error(
        'Download this speech model in Models before transcribing. No audio leaves this device.',
      );
    onProgress?.({ status: 'Decoding saved audio', progress: 0 });
    const audio = await decodeAudio(blob);
    if (token !== generation) throw cancelled();
    if (speechModelConfig(modelId).engine === 'native') {
      const result = await runNativeSpeech('transcribe', audio, options.language, onProgress);
      if (token !== generation) throw cancelled();
      const duration = audio.length / 16000;
      if (
        !Array.isArray(result?.words) ||
        result.words.some(
          (word) =>
            typeof word.text !== 'string' ||
            !Array.isArray(word.timestamp) ||
            word.timestamp.some((time) => !Number.isFinite(time)) ||
            word.timestamp[0] < 0 ||
            word.timestamp[1] < word.timestamp[0] ||
            word.timestamp[1] > duration + 0.1,
        )
      )
        throw new Error(
          'The local speech engine returned invalid word timestamps. Your saved audio is unchanged.',
        );
      return await callWorker('diarize', modelId, onProgress, audio, {
        ...options,
        words: result.words,
      });
    }
    return await callWorker('transcribe', modelId, onProgress, audio, options);
  });
}

const processingMeetings = new Map<string, number>();
const cancellationSaves = new Map<string, Promise<unknown>>();
function suppressAutomaticTranscription(meetingIds: string[]) {
  return Promise.all(
    meetingIds.map((id) => {
      if (!cancellationSaves.has(id)) {
        const save = requestJson(
          `/meetings/${encodeURIComponent(id)}`,
          'PATCH',
          { autoTranscribeSuppressed: true },
          undefined,
          { keepalive: true },
        )
          .catch(() => {
            /* Cancellation is best effort when the page is leaving or Echo is unavailable. */
          })
          .finally(() => {
            if (cancellationSaves.get(id) === save) cancellationSaves.delete(id);
          });
        cancellationSaves.set(id, save);
      }
      return cancellationSaves.get(id) ?? Promise.resolve();
    }),
  );
}
// A cancelled generation may still be finishing API cleanup. It no longer owns
// computation worth protecting; warn only for pending jobs in the current one.
window.addEventListener('beforeunload', (event) => {
  if (![...processingMeetings.values()].some((token) => token === generation)) return;
  event.preventDefault();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Older Chromium requires returnValue as well as preventDefault for the unsaved-work prompt.
  event.returnValue = '';
});
/** Explicit literal aliases only. Conflicting aliases and fuzzy guesses are left unchanged. */
export function applyVocabulary(text: string, entries: VocabularyEntry[]) {
  const aliases = new Map<string, string | null>();
  for (const entry of entries.filter((entry) => entry.enabled)) {
    for (const alias of entry.aliases ?? []) {
      const key = alias.trim().toLocaleLowerCase();
      if (!key) continue;
      if (aliases.has(key) && aliases.get(key) !== entry.term) aliases.set(key, null);
      else if (!aliases.has(key)) aliases.set(key, entry.term);
    }
  }
  const valid = [...aliases].filter(([, term]) => term).sort(([a], [b]) => b.length - a.length);
  if (!valid.length) return text;
  const escaped = valid.map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  return text.replace(pattern, (match) => aliases.get(match.toLocaleLowerCase()) || match);
}

/** Call the local API and preserve actionable JSON or HTTP status errors. */
async function requestJson(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    ...options,
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const data = await responseJson(response).catch(() => null);
  if (!response.ok)
    throw new Error(apiError(data) || `The local server returned ${response.status}.`);
  return data;
}
const report = (modelId: string, meetingId?: string) => (detail: Progress) =>
  window.dispatchEvent(
    new CustomEvent('echo-model-progress', {
      detail: { ...detail, modelId, ...(meetingId ? { meetingId } : {}) },
    }),
  );
const processingHeartbeat = createProcessingHeartbeat({
  request: (meetingIds, signal) =>
    requestJson('/processing/heartbeat', 'POST', { meetingIds }, signal).then(heartbeat),
  onRestore: () => window.dispatchEvent(new Event('echo-library-changed')),
});

/** Transcribe a saved audio track and append a new version with a vocabulary snapshot. */
export async function transcribeMeeting(
  meetingId: string,
  modelId?: string,
  trackId?: string,
  options: { automatic?: boolean } = {},
): Promise<Omit<Meeting, 'id'> | Pick<Meeting, 'id'>> {
  modelId = resolveSpeechModel(modelId);
  if (processingMeetings.has(meetingId))
    throw new Error('This meeting is already being transcribed.');
  const token = generation;
  processingMeetings.set(meetingId, token);
  releaseLiveInference();
  publishInferenceState();
  const checkCancelled = () => {
    if (token !== generation) throw cancelled();
  };
  const controller = new AbortController();
  activeAudioFetches.add(controller);
  if (!options.automatic)
    window.dispatchEvent(
      new CustomEvent('echo-transcription-start', { detail: { meetingId, modelId } }),
    );
  let meeting: Omit<Meeting, 'id'> | undefined;
  try {
    meeting = parseMeeting(await requestJson(`/meetings/${encodeURIComponent(meetingId)}`));
    checkCancelled();
    if (options.automatic && !automaticTranscriptionEligible(meeting)) return meeting;
    if (options.automatic)
      window.dispatchEvent(
        new CustomEvent('echo-transcription-start', { detail: { meetingId, modelId } }),
      );
    if (['recording', 'paused'].includes(meeting.status))
      throw new Error('Finish recording before transcribing this meeting.');
    const tracks = trackId
      ? meeting.tracks.filter((track) => track.id === trackId)
      : meeting.tracks;
    if (!tracks.length) throw new Error('This meeting has no saved audio to transcribe.');
    if (!(await getDownloadedModels()).includes(modelId))
      throw new Error('Download the selected speech model in Models before transcribing.');
    checkCancelled();
    const vocabulary = parseVocabulary(await requestJson('/vocabulary')).filter(
      (entry) => entry.enabled,
    );
    await cancellationSaves.get(meetingId);
    checkCancelled();
    await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', {
      status: 'processing',
      error: '',
      ...(!options.automatic ? { autoTranscribeSuppressed: false } : {}),
    });
    checkCancelled();
    window.dispatchEvent(new Event('echo-library-changed'));
    processingHeartbeat.start(meetingId);
    const passages: TranscriptResult['passages'] = [];
    let offset = 0;
    let speakers: Speaker[] = [];
    const settings = parseSettings(await requestJson('/settings'));
    for (const track of tracks) {
      checkCancelled();
      const audioUrl = new URL(track.url ?? 'undefined', location.origin);
      if (audioUrl.origin !== location.origin || !audioUrl.pathname.startsWith('/api/meetings/'))
        throw new Error('The saved audio has an invalid local address.');
      const response = await fetch(audioUrl, { signal: controller.signal });
      if (!response.ok)
        throw new Error('The saved audio could not be loaded. Check the local data folder.');
      const blob = await response.blob();
      checkCancelled();
      const result = await transcribeAudio(blob, modelId, report(modelId, meetingId), {
        speakers,
        language: settings.language,
      });
      speakers = result.speakers ?? speakers;
      passages.push(
        ...result.passages.map((passage) => ({
          ...passage,
          text: applyVocabulary(passage.text, vocabulary),
          start: passage.start + offset,
          end: passage.end + offset,
        })),
      );
      offset += result.duration ?? Math.max(0, ...result.passages.map((passage) => passage.end));
    }
    if (!passages.length)
      throw new Error(
        'No speech was detected. Your recording is saved; check the microphone or try another speech model.',
      );
    checkCancelled();
    if (offset > (meeting.duration || 0))
      await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', {
        duration: offset,
      });
    checkCancelled();
    processingHeartbeat.stop(meetingId);
    const saved = meetingIdentity(
      await requestJson(`/meetings/${encodeURIComponent(meetingId)}/transcripts`, 'POST', {
        model: modelId,
        passages,
        vocabulary,
      }),
    );
    window.dispatchEvent(new CustomEvent('echo-transcript-saved', { detail: saved }));
    return saved;
  } catch (error) {
    processingHeartbeat.stop(meetingId);
    await cancellationSaves.get(meetingId);
    if (meeting && !['recording', 'paused'].includes(meeting.status)) {
      await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', {
        status: meeting.transcripts.length ? 'ready' : 'saved',
        error: errorInfo(error).message,
        ...(errorInfo(error).name === 'AbortError' ? { autoTranscribeSuppressed: true } : {}),
      }).catch(() => {
        /* Cancellation is best effort; cleanup continues independently. */
      });
    }
    report(
      modelId,
      meetingId,
    )({
      status: errorInfo(error).name === 'AbortError' ? 'Cancelled' : 'Failed',
      progress: 0,
      error: errorInfo(error).message,
    });
    window.dispatchEvent(
      new CustomEvent('echo-transcription-error', {
        detail: { meetingId, modelId, error: errorInfo(error).message },
      }),
    );
    throw error;
  } finally {
    processingHeartbeat.stop(meetingId);
    if (processingMeetings.get(meetingId) === token) processingMeetings.delete(meetingId);
    publishInferenceState();
    activeAudioFetches.delete(controller);
  }
}

window.echoInference = {
  models: MODELS,
  getDownloadedModels,
  getOutdatedModels,
  getModelDownloadState,
  getNativeSpeechStatus,
  removeModel,
  cancelInference,
  transcribeAudio,
  transcribeMeeting,
  getLiveModelStatus,
  transcribeLiveWindow,
  cancelLiveInference,
  releaseLiveInference,
  getInferenceState,
  suppressAutomaticTranscription,
  downloadModel: (id: string, callback?: (progress: Progress) => void) =>
    downloadModel(id, (progress) => {
      report(id)(progress);
      callback?.(progress);
    }),
};
