import { assertModel, MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl, MODELS } from './models.js';
export { MODELS } from './models.js';

let worker = null;
let queue = Promise.resolve();
let generation = 0;
let rejectActive = null;
const activeAudioFetches = new Set();
const cancelled = () => new DOMException('Local processing was cancelled. Your saved audio is unchanged.', 'AbortError');

function serial(operation) {
  const token = generation;
  const result = queue.catch(() => {}).then(() => {
    if (token !== generation) throw cancelled();
    return operation();
  });
  queue = result.catch(() => {});
  return result;
}

function callWorker(type, modelId, onProgress, audio) {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('This browser does not support local speech processing. Try a current Chrome, Edge, Firefox, or Safari browser.'));
  worker ??= new Worker(new URL('/js/inference-worker.js', location.origin), { type: 'module' });
  const currentWorker = worker;
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      currentWorker.removeEventListener('message', message);
      currentWorker.removeEventListener('error', error);
      rejectActive = null;
    };
    const fail = (reason) => { cleanup(); reject(reason); };
    const message = (event) => {
      if (event.data.id !== id) return;
      if (event.data.type === 'progress') { try { onProgress?.(event.data.progress); } catch (error) { console.error('Progress callback failed.', error); } }
      else if (event.data.type === 'result') { cleanup(); resolve(event.data.result); }
      else if (event.data.type === 'error') fail(new Error(event.data.error));
    };
    const error = (event) => {
      currentWorker.terminate(); worker = null;
      fail(new Error(event.message || 'Local speech processing stopped unexpectedly. Try again with the smaller model.'));
    };
    rejectActive = fail;
    currentWorker.addEventListener('message', message);
    currentWorker.addEventListener('error', error);
    currentWorker.postMessage({ id, type, modelId, audio }, audio ? [audio.buffer] : []);
  });
}

export function cancelInference() {
  generation++;
  for (const controller of activeAudioFetches) controller.abort();
  worker?.terminate(); worker = null;
  rejectActive?.(cancelled());
  rejectActive = null;
}

export async function getDownloadedModels() {
  if (typeof caches === 'undefined') return [];
  const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const files = await caches.open(MODEL_CACHE);
  const downloaded = [];
  for (const model of MODELS) {
    const manifest = await manifests.match(modelManifestUrl(model.id));
    if (!manifest) continue;
    try {
      const data = await manifest.json();
      if (data.files.length && (await Promise.all(data.files.map(url => files.match(url)))).every(Boolean)) downloaded.push(model.id);
      else await manifests.delete(modelManifestUrl(model.id));
    } catch { await manifests.delete(modelManifestUrl(model.id)); }
  }
  return downloaded;
}

export function downloadModel(id, onProgress) {
  assertModel(id);
  return serial(async () => {
    if (typeof caches === 'undefined') throw new Error('Model storage requires a secure browser context. Open Echo Voice on localhost.');
    await navigator.storage?.persist?.().catch(() => false);
    await callWorker('download', id, onProgress);
  });
}

export function removeModel(id) {
  assertModel(id);
  cancelInference();
  return serial(async () => {
    const manifest = await caches.open(MODEL_MANIFEST_CACHE);
    await manifest.delete(modelManifestUrl(id));
    const cache = await caches.open(MODEL_CACHE);
    for (const request of await cache.keys()) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path.includes(`/${id}/`)) await cache.delete(request);
    }
  });
}

async function decodeAudio(blob) {
  if (!blob.size) throw new Error('There is no audio to transcribe. Record or import some audio first.');
  if (blob.size > 512 * 1024 * 1024) throw new Error('This audio exceeds the browser processing limit of 512 MB. Split it into smaller recordings.');
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (buffer.duration > 7200) throw new Error('For reliable browser processing, split recordings longer than two hours before importing.');
    const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = buffer; source.connect(offline.destination); source.start();
    return (await offline.startRendering()).getChannelData(0);
  } catch (error) {
    if (error instanceof Error && error.message.includes('two hours')) throw error;
    throw new Error('This browser could not decode the audio. Try WAV, MP3, or a recording made in this browser.');
  } finally { await context.close(); }
}

export function transcribeAudio(blob, modelId, onProgress) {
  assertModel(modelId);
  const token = generation;
  return serial(async () => {
    if (!(await getDownloadedModels()).includes(modelId)) throw new Error('Download this speech model in Models before transcribing. No audio leaves this device.');
    onProgress?.({ status: 'Decoding saved audio', progress: 0 });
    const audio = await decodeAudio(blob);
    if (token !== generation) throw cancelled();
    return await callWorker('transcribe', modelId, onProgress, audio);
  });
}

const processingMeetings = new Set();
/** Explicit literal aliases only. Conflicting aliases and fuzzy guesses are left unchanged. */
export function applyVocabulary(text, entries) {
  const aliases = new Map();
  for (const entry of entries.filter(entry => entry.enabled)) {
    for (const alias of entry.aliases || []) {
      const key = alias.trim().toLocaleLowerCase();
      if (!key) continue;
      if (aliases.has(key) && aliases.get(key) !== entry.term) aliases.set(key, null);
      else if (!aliases.has(key)) aliases.set(key, entry.term);
    }
  }
  const valid = [...aliases].filter(([, term]) => term).sort(([a], [b]) => b.length - a.length);
  if (!valid.length) return text;
  const escaped = valid.map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return text.replace(pattern, match => aliases.get(match.toLocaleLowerCase()) || match);
}

async function requestJson(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `The local server returned ${response.status}.`);
  return data;
}
const report = (modelId, meetingId) => detail => window.dispatchEvent(new CustomEvent('echo-model-progress', { detail: { ...detail, modelId, ...(meetingId ? { meetingId } : {}) } }));

export async function transcribeMeeting(meetingId, modelId, trackId) {
  if (processingMeetings.has(meetingId)) throw new Error('This meeting is already being transcribed.');
  processingMeetings.add(meetingId);
  const token = generation;
  const checkCancelled = () => { if (token !== generation) throw cancelled(); };
  const controller = new AbortController();
  activeAudioFetches.add(controller);
  window.dispatchEvent(new CustomEvent('echo-transcription-start', { detail: { meetingId, modelId } }));
  let meeting;
  try {
    meeting = await requestJson(`/meetings/${encodeURIComponent(meetingId)}`);
    checkCancelled();
    if (['recording', 'paused'].includes(meeting.status)) throw new Error('Finish recording before transcribing this meeting.');
    const tracks = trackId ? meeting.tracks.filter(track => track.id === trackId) : meeting.tracks;
    if (!tracks.length) throw new Error('This meeting has no saved audio to transcribe.');
    if (!(await getDownloadedModels()).includes(modelId)) throw new Error('Download the selected speech model in Models before transcribing.');
    checkCancelled();
    const vocabularyResponse = await requestJson('/vocabulary');
    const vocabulary = (vocabularyResponse.entries || []).filter(entry => entry.enabled);
    checkCancelled();
    await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', { status: 'processing', error: '' });
    const passages = []; let offset = 0;
    for (const track of tracks) {
      checkCancelled();
      const audioUrl = new URL(track.url, location.origin);
      if (audioUrl.origin !== location.origin || !audioUrl.pathname.startsWith('/api/meetings/')) throw new Error('The saved audio has an invalid local address.');
      const response = await fetch(audioUrl, { signal: controller.signal });
      if (!response.ok) throw new Error('The saved audio could not be loaded. Check the local data folder.');
      const blob = await response.blob();
      checkCancelled();
      const result = await transcribeAudio(blob, modelId, report(modelId, meetingId));
      passages.push(...result.passages.map(passage => ({ ...passage, text: applyVocabulary(passage.text, vocabulary), start: passage.start + offset, end: passage.end + offset })));
      offset += result.duration ?? Math.max(0, ...result.passages.map(passage => passage.end));
    }
    if (!passages.length) throw new Error('No speech was detected. Your recording is saved; check the microphone or try another speech model.');
    checkCancelled();
    if (offset > (meeting.duration || 0)) await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', { duration: offset });
    checkCancelled();
    const saved = await requestJson(`/meetings/${encodeURIComponent(meetingId)}/transcripts`, 'POST', { model: modelId, passages, vocabulary });
    window.dispatchEvent(new CustomEvent('echo-transcript-saved', { detail: saved }));
    return saved;
  } catch (error) {
    if (meeting && !['recording', 'paused'].includes(meeting.status)) {
      await requestJson(`/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', { status: meeting.transcripts.length ? 'ready' : 'saved', error: error.message }).catch(() => {});
    }
    report(modelId, meetingId)({ status: error.name === 'AbortError' ? 'Cancelled' : 'Failed', progress: 0, error: error.message });
    window.dispatchEvent(new CustomEvent('echo-transcription-error', { detail: { meetingId, modelId, error: error.message } }));
    throw error;
  } finally { processingMeetings.delete(meetingId); activeAudioFetches.delete(controller); }
}

window.echoInference = {
  models: MODELS, getDownloadedModels, removeModel, cancelInference, transcribeAudio, transcribeMeeting,
  downloadModel: (id, callback) => downloadModel(id, progress => { report(id)(progress); callback?.(progress); }),
};
