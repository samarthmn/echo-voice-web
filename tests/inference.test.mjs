import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.location = { origin: 'http://localhost:3111' };
Object.defineProperty(globalThis, 'navigator', { value: { storage: { persist: async () => true } }, configurable: true });

class MemoryCache {
  values = new Map();
  async put(key, value) { this.values.set(String(key), value.clone()); }
  async match(key) { return this.values.get(String(key))?.clone(); }
  async delete(key) { return this.values.delete(key.url || String(key)); }
  async keys() { return [...this.values.keys()].map(url => new Request(url)); }
}
const cacheStores = new Map();
globalThis.caches = { async open(name) { if (!cacheStores.has(name)) cacheStores.set(name, new MemoryCache()); return cacheStores.get(name); } };
let workerCalls = []; let instances = [];
class FakeWorker extends EventTarget {
  constructor() { super(); instances.push(this); }
  postMessage(message) { this.lastMessage = message; workerCalls.push(message); }
  terminate() { this.terminated = true; }
  async finish(result) {
    if (this.lastMessage.type === 'download-companions') {
      // This fake worker verifies the orchestration contract, not real model execution.
      const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
      const path = 'https://huggingface.co/test/companion-download.onnx';
      await files.put(path, new Response('fixture companion'));
      await manifests.put(modelManifestUrl(this.lastMessage.modelId), new Response(JSON.stringify(manifestData(this.lastMessage.modelId, [path]))));
    }
    this.dispatchEvent(new MessageEvent('message', { data: { id: this.lastMessage.id, type: 'result', result } })); }
}
globalThis.Worker = FakeWorker;
const inference = await import('../web/inference.js');
const { MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl, speechModelConfig, MODELS, SPEAKER_MODELS } = await import('../web/models.js');
const turbo = MODELS[0].id; const large = MODELS[1].id;
const manifestData = (id, files) => speechModelConfig(id).engine === 'native' ? ({ files, engine: 'native-companions-v1', speakerModels: SPEAKER_MODELS }) : ({ files, checkpoint: speechModelConfig(id).checkpoint, revision: speechModelConfig(id).revision, precision: speechModelConfig(id).precision ?? 'q8', wordTimestamps: true });
const turn = () => new Promise(resolve => setImmediate(resolve));

let nativeReady = true;
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/speech') return Response.json({ available: true, ready: nativeReady });
  if (options.method === 'POST' && url.startsWith('/api/speech/jobs?')) return Response.json({ jobId: new URL(url, location.origin).searchParams.get('jobId'), state: 'queued' });
  if (url.startsWith('/api/speech/jobs/')) return Response.json({ state: options.method === 'DELETE' ? 'cancelled' : 'completed' });
  assert.fail(`Unexpected native request: ${options.method || 'GET'} ${url}`);
};

test('partial downloads are never reported as offline ready and missing cached files invalidate readiness', async () => {
  const files = await caches.open(MODEL_CACHE); const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${turbo}/resolve/main/encoder.onnx`;
  await files.put(path, new Response('weights'));
  assert.deepEqual(await inference.getDownloadedModels(), []);
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify(manifestData(turbo, [path]))));
  assert.deepEqual(await inference.getDownloadedModels(), [turbo]);
  await files.delete(path);
  assert.deepEqual(await inference.getDownloadedModels(), []);
  assert.equal(await manifests.match(modelManifestUrl(turbo)), undefined);
});

test('older complete downloads require the timestamp-capable checkpoint without deleting cached weights', async () => {
  const files = await caches.open(MODEL_CACHE); const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${turbo}/resolve/main/decoder_model_merged_quantized.onnx`;
  await files.put(path, new Response('old weights'));
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify({ files: [path] })));
  assert.ok(!(await inference.getDownloadedModels()).includes(turbo));
  assert.ok(await files.match(path));
  assert.deepEqual(await inference.getOutdatedModels(), [turbo]);
  assert.ok(await manifests.match(modelManifestUrl(turbo)));
  await manifests.delete(modelManifestUrl(turbo));
});

test('old browser Large markers never report native readiness and saved weights are retained', async () => {
  const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${speechModelConfig(large).checkpoint}/resolve/main/encoder_model_quantized.onnx`;
  await files.put(path, new Response('old large encoder'));
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify({ files: [path], checkpoint: speechModelConfig(large).checkpoint, revision: speechModelConfig(large).revision, precision: 'q8', wordTimestamps: true, forwardVerified: true })));
  assert.ok(!(await inference.getDownloadedModels()).includes(large));
  assert.ok((await inference.getOutdatedModels()).includes(large));
  assert.ok(await files.match(path));
  const turboPath = `https://huggingface.co/${speechModelConfig(turbo).checkpoint}/resolve/main/encoder_model_quantized.onnx`;
  await files.put(turboPath, new Response('existing turbo encoder'));
  const compatible = manifestData(turbo, [turboPath]); delete compatible.precision;
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify(compatible)));
  assert.ok((await inference.getDownloadedModels()).includes(turbo));
  await manifests.delete(modelManifestUrl(turbo));
  await manifests.delete(modelManifestUrl(large));
});

test('Large readiness combines native qualification and complete speaker cache files', async () => {
  const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = 'https://huggingface.co/test/speaker.onnx';
  await files.put(path, new Response('speaker weights'));
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(manifestData(large, [path]))));
  nativeReady = false;
  assert.ok(!(await inference.getDownloadedModels()).includes(large));
  nativeReady = true;
  assert.ok((await inference.getDownloadedModels()).includes(large));
  await files.delete(path);
  assert.ok(!(await inference.getDownloadedModels()).includes(large));
  assert.equal(await manifests.match(modelManifestUrl(large)), undefined);
});

test('downloads serialize and cancelling rejects active and queued jobs', async () => {
  workerCalls = []; instances = [];
  const first = inference.downloadModel(turbo);
  const queued = inference.downloadModel(large);
  const firstRejected = assert.rejects(first, error => error.name === 'AbortError');
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  await turn();
  assert.equal(workerCalls.length, 1);
  inference.cancelInference();
  await Promise.all([firstRejected, queuedRejected]);
  assert.equal(instances[0].terminated, true);
  assert.equal(workerCalls.length, 1);
  const next = inference.downloadModel(large);
  await turn(); instances.at(-1).finish(); await next;
  assert.equal(workerCalls.length, 2);
});

test('worker runtime metadata reaches the main-thread diagnostic log and preserves progress delivery', async () => {
  const messages = [], progress = [];
  const originalInfo = console.info;
  console.info = (...args) => messages.push(args);
  try {
    const job = inference.downloadModel(turbo, value => progress.push(value));
    await turn();
    const current = instances.at(-1);
    const detail = { status: 'Loading speech model', progress: 0, runtime: { threads: 4, isolated: true } };
    current.dispatchEvent(new MessageEvent('message', { data: { id: current.lastMessage.id, type: 'progress', progress: detail } }));
    current.finish();
    await job;
    assert.deepEqual(messages, [['[Echo inference] WASM runtime ' + JSON.stringify(detail.runtime)]]);
    assert.deepEqual(progress, [detail]);
  } finally { console.info = originalInfo; }
});

test('download snapshots retain progress without a mounted page and duplicate requests reuse one worker job', async () => {
  const events = [];
  const observe = event => events.push(event.detail);
  window.addEventListener('echo-model-download-state', observe);
  try {
    const count = workerCalls.length;
    const download = inference.downloadModel(turbo);
    assert.equal(inference.downloadModel(turbo), download);
    assert.equal(inference.getModelDownloadState().status, 'queued');
    await turn();
    assert.equal(workerCalls.length, count + 1);
    const active = instances.at(-1);
    active.dispatchEvent(new MessageEvent('message', { data: { id: active.lastMessage.id, type: 'progress', progress: { status: 'Downloading weights', progress: 57 } } }));
    const snapshot = inference.getModelDownloadState();
    assert.deepEqual(snapshot, { modelId: turbo, status: 'downloading', progress: 57, detail: 'Downloading weights' });
    snapshot.progress = 100;
    assert.equal(inference.getModelDownloadState().progress, 57);
    assert.ok(!(await inference.getDownloadedModels()).includes(turbo));
    active.finish();
    await download;
    assert.equal(inference.getModelDownloadState().status, 'completed');
    assert.equal(events.filter(state => state.status === 'completed').length, 1);
    // A completed operation alone cannot manufacture a complete offline cache marker.
    assert.ok(!(await inference.getDownloadedModels()).includes(turbo));
  } finally {
    window.removeEventListener('echo-model-download-state', observe);
  }
});

test('download snapshots distinguish deliberate cancellation from worker failure', async () => {
  const cancelledDownload = inference.downloadModel(turbo);
  const rejected = assert.rejects(cancelledDownload, error => error.name === 'AbortError');
  await turn();
  inference.cancelInference();
  await rejected;
  assert.equal(inference.getModelDownloadState().status, 'cancelled');
  const failedDownload = inference.downloadModel(turbo);
  const failed = assert.rejects(failedDownload, /Network unavailable/);
  await turn();
  const active = instances.at(-1);
  active.dispatchEvent(new MessageEvent('message', { data: { id: active.lastMessage.id, type: 'error', error: 'Network unavailable' } }));
  await failed;
  assert.equal(inference.getModelDownloadState().status, 'failed');
  assert.equal(inference.getModelDownloadState().error, 'Network unavailable');
});

test('failed native processing releases its worker and queued downloads start with a fresh runtime', async () => {
  const first = inference.downloadModel(large);
  const rejected = assert.rejects(first, /ONNX runtime exception/);
  const next = inference.downloadModel(turbo);
  await turn();
  const failedWorker = instances.at(-1);
  failedWorker.dispatchEvent(new MessageEvent('message', { data: {
    id: failedWorker.lastMessage.id, type: 'error', error: 'ONNX runtime exception 2509384728',
  } }));
  await rejected;
  await turn();
  assert.equal(failedWorker.terminated, true);
  const freshWorker = instances.at(-1);
  assert.notEqual(freshWorker, failedWorker);
  assert.equal(freshWorker.lastMessage.modelId, turbo);
  freshWorker.finish();
  await next;
  assert.equal(freshWorker.terminated, true);
  assert.equal(inference.getModelDownloadState().status, 'completed');
  assert.equal(inference.getModelDownloadState().modelId, turbo);
});

test('completed downloads release their WASM heap before subsequent operations', async () => {
  const first = inference.downloadModel(turbo);
  await turn();
  const firstWorker = instances.at(-1);
  firstWorker.finish();
  await first;
  assert.equal(firstWorker.terminated, true);
  const next = inference.downloadModel(large);
  await turn();
  const nextWorker = instances.at(-1);
  assert.notEqual(nextWorker, firstWorker);
  nextWorker.finish();
  await next;
  assert.equal(nextWorker.terminated, true);
});

test('synchronous worker dispatch failures clean up the runtime and allow retry', async () => {
  const originalPost = FakeWorker.prototype.postMessage;
  FakeWorker.prototype.postMessage = () => { throw new DOMException('Unable to transfer audio.', 'DataCloneError'); };
  try {
    await assert.rejects(inference.downloadModel(turbo), /Unable to transfer audio/);
    assert.equal(instances.at(-1).terminated, true);
  } finally {
    FakeWorker.prototype.postMessage = originalPost;
  }
  const retry = inference.downloadModel(turbo);
  await turn();
  instances.at(-1).finish();
  await retry;
});

test('transcription refuses uncached models before decoding or starting a worker', async () => {
  const count = workerCalls.length;
  await assert.rejects(inference.transcribeAudio(new Blob(['audio']), turbo), /Download this speech model/);
  assert.equal(workerCalls.length, count);
});

test('cancelling during storage persistence prevents a worker download and permits a later retry', async () => {
  const originalPersist = navigator.storage.persist;
  let releasePersistence;
  navigator.storage.persist = () => new Promise(resolve => { releasePersistence = resolve; });
  const count = workerCalls.length;
  try {
    const download = inference.downloadModel(turbo);
    const rejected = assert.rejects(download, error => error.name === 'AbortError');
    await turn();
    assert.equal(typeof releasePersistence, 'function');
    inference.cancelInference();
    releasePersistence(true);
    await turn();
    // Settle an unexpected worker so the regression fails without hanging the queue.
    if (workerCalls.length > count) instances.at(-1).finish();
    await rejected;
    assert.equal(workerCalls.length, count);
  } finally {
    navigator.storage.persist = originalPersist;
    inference.cancelInference();
  }
  const retry = inference.downloadModel(large);
  await turn();
  instances.at(-1).finish();
  await retry;
  assert.equal(workerCalls.length, count + 1);
});

test('removal deletes only selected model files and its complete marker', async () => {
  const files = await caches.open(MODEL_CACHE); const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const turboPath = `https://huggingface.co/${turbo}/resolve/main/model.onnx`;
  const largePath = `https://huggingface.co/${large}/resolve/main/model.onnx`;
  await files.put(turboPath, new Response('turbo')); await files.put(largePath, new Response('large'));
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify(manifestData(turbo, [turboPath]))));
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(manifestData(large, [largePath]))));
  await inference.removeModel(turbo);
  assert.deepEqual(await inference.getDownloadedModels(), [large]);
  assert.equal(await files.match(turboPath), undefined);
  assert.ok(await files.match(largePath));
});

test('vocabulary corrections use explicit whole aliases without regex interpretation or fuzzy guesses', () => {
  const entries = [
    { term: 'OpenAI', aliases: ['open ai'], enabled: true },
    { term: 'C++', aliases: ['c plus plus'], enabled: true },
    { term: 'Node.js', aliases: ['node.js'], enabled: true },
    { term: 'Ignored', aliases: ['other'], enabled: false },
  ];
  assert.equal(inference.applyVocabulary('OPEN AI uses c plus plus, node.js and nodeXjs; reopen ai and other.', entries), 'OpenAI uses C++, Node.js and nodeXjs; reopen ai and other.');
  assert.equal(inference.applyVocabulary('acme', [{ term: 'A', aliases: ['acme'], enabled: true }, { term: 'B', aliases: ['acme'], enabled: true }]), 'acme');
});

test('reload protection follows pending transcript jobs and releases on success, failure and cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const originalAudioContext = globalThis.AudioContext;
  const originalOfflineContext = globalThis.OfflineAudioContext;
  const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const key = modelManifestUrl(turbo), previous = await manifests.match(key);
  const fixture = 'https://huggingface.co/test/unload-guard.onnx';
  const warns = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  globalThis.AudioContext = class {
    async decodeAudioData() { return { duration: 1 }; }
    async close() {}
  };
  globalThis.OfflineAudioContext = class {
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(16000) }; }
  };
  let processingPatched = false, refreshed = 0; const patches=[];
  const libraryRefresh = () => { assert.equal(processingPatched, true); refreshed++; };
  window.addEventListener('echo-library-changed', libraryRefresh);
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, location.origin).pathname;
    if (path.endsWith('/audio')) return new Response('fixture audio');
    if (path === '/api/vocabulary') return Response.json({ entries: [] });
    if (path === '/api/settings') return Response.json({ language: 'english' });
    if (path.endsWith('/transcripts')) return Response.json({ id: 'saved-transcript' });
    if (options.method === 'PATCH') {const patch=JSON.parse(options.body);patches.push(patch);if(patch.status==='processing') processingPatched=true;}
    if (path.startsWith('/api/meetings/')) return Response.json({ status: 'saved', autoTranscribeSuppressed:true, transcripts: [], duration: 1, tracks: [{ id: 'track', url: '/api/meetings/unload-test/audio' }] });
    assert.fail(`Unexpected request: ${options.method || 'GET'} ${path}`);
  };
  try {
    await files.put(fixture, new Response('weights'));
    await manifests.put(key, new Response(JSON.stringify(manifestData(turbo, [fixture]))));
    assert.equal(warns(), false);
    for (const outcome of ['success', 'error', 'cancel']) {
      processingPatched = false; refreshed = 0; patches.length=0;
      const count = instances.length;
      const job = inference.transcribeMeeting(`unload-${outcome}`, turbo);
      // Covers metadata/audio loading and a job that has not reached its worker yet.
      assert.equal(warns(), true);
      const rejected = outcome === 'success' ? null : assert.rejects(job, outcome === 'cancel' ? error => error.name === 'AbortError' : /native failure/);
      await turn();
      assert.equal(instances.length, count + 1);
      assert.equal(refreshed, 1, 'Library refresh follows the processing patch before inference');
      assert.equal(patches.find(patch=>patch.status==='processing').autoTranscribeSuppressed,false,'explicit retry clears durable automatic suppression');
      const current = instances.at(-1);
      assert.equal(current.lastMessage.type, 'transcribe');
      assert.equal(warns(), true);
      if (outcome === 'success') {
        current.finish({ passages: [{ start: 0, end: 1, text: 'hello', speaker: 'speaker-1' }], duration: 1, speakers: [] });
        await job;
      } else if (outcome === 'error') {
        current.dispatchEvent(new MessageEvent('message', { data: { id: current.lastMessage.id, type: 'error', error: 'native failure' } }));
        await rejected;
      } else {
        inference.cancelInference();
        // Cancellation immediately releases protection, even before API cleanup.
        assert.equal(warns(), false);
        await rejected;
        assert.ok(patches.some(patch=>patch.autoTranscribeSuppressed===true));
        assert.equal(patches.at(-1).autoTranscribeSuppressed,true);
      }
      assert.equal(warns(), false);
    }
    const download = inference.downloadModel(turbo);
    await turn();
    assert.equal(warns(), false);
    instances.at(-1).finish();
    await download;
    assert.equal(warns(), false);
  } finally {
    inference.cancelInference();
    window.removeEventListener('echo-library-changed', libraryRefresh);
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineContext;
    await files.delete(fixture);
    if (previous) await manifests.put(key, previous); else await manifests.delete(key);
  }
});

test('Large ASR uses the native engine then sends decoded audio and real word timestamps only to diarization', async () => {
  const previousFetch = globalThis.fetch, previousAudio = globalThis.AudioContext, previousOffline = globalThis.OfflineAudioContext;
  const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const fixture = 'https://huggingface.co/test/native-companion.onnx';
  let nativeId, nativeRequests = [];
  globalThis.AudioContext = class { async decodeAudioData() { return { duration: 1 }; } async close() {} };
  globalThis.OfflineAudioContext = class {
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(16000).fill(.1) }; }
  };
  globalThis.fetch = async (url, options = {}) => {
    nativeRequests.push({ url, options });
    if (url === '/api/speech') return Response.json({ available: true, ready: true });
    if (options.method === 'POST') {
      const query = new URL(url, location.origin).searchParams;
      assert.equal(query.get('modelId'), large); assert.equal(query.get('language'), 'fr');
      assert.equal(query.get('operation'), 'transcribe'); assert.equal(options.body.byteLength, 16000 * 4);
      nativeId = query.get('jobId'); return Response.json({ jobId: nativeId });
    }
    assert.equal(url, `/api/speech/jobs/${nativeId}`);
    return Response.json({ state: 'completed', result: { words: [{ text: 'bonjour', timestamp: [0, .9] }], duration: 1 } });
  };
  try {
    await files.put(fixture, new Response('companion weights'));
    await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(manifestData(large, [fixture]))));
    const count = instances.length;
    const job = inference.transcribeAudio(new Blob(['recording']), large, undefined, { language: 'fr', speakers: [] });
    await turn();
    assert.equal(instances.length, count + 1);
    const current = instances.at(-1);
    assert.equal(current.lastMessage.type, 'diarize');
    assert.equal(current.lastMessage.audio.length, 16000);
    assert.deepEqual(current.lastMessage.options.words, [{ text: 'bonjour', timestamp: [0, .9] }]);
    current.finish({ passages: [{ text: 'bonjour', start: 0, end: .9, speaker: 'speaker-1' }], duration: 1, speakers: [] });
    const result = await job;
    assert.equal(result.passages[0].text, 'bonjour');
    assert.equal(nativeRequests.filter(request => request.options.method === 'POST').length, 1);
  } finally {
    inference.cancelInference(); globalThis.fetch = previousFetch; globalThis.AudioContext = previousAudio; globalThis.OfflineAudioContext = previousOffline;
    await files.delete(fixture); await manifests.delete(modelManifestUrl(large));
  }
});

test('successful native migration retires only browser Large ASR weights while failure preserves them', async () => {
  const files = await caches.open(MODEL_CACHE);
  const retired = ['https://huggingface.co/Xenova/whisper-large-v3/resolve/pinned/onnx/encoder_model_quantized.onnx', 'https://huggingface.co/onnx-community/whisper-large-v3/resolve/main/decoder.onnx'];
  const retained = ['https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/model.onnx', 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/model.onnx', 'https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped/resolve/pinned/model.onnx'];
  for (const path of [...retired, ...retained]) await files.put(path, new Response('weights'));
  const failedDownload = inference.downloadModel(large);
  const failed = assert.rejects(failedDownload, /companion failure/);
  await turn();
  const failedWorker = instances.at(-1);
  assert.equal(failedWorker.lastMessage.type, 'download-companions');
  failedWorker.dispatchEvent(new MessageEvent('message', { data: { id: failedWorker.lastMessage.id, type: 'error', error: 'companion failure' } }));
  await failed;
  for (const path of retired) assert.ok(await files.match(path), 'A failed replacement must preserve old weights');
  const success = inference.downloadModel(large);
  await turn(); await instances.at(-1).finish(); await success;
  for (const path of retired) assert.equal(await files.match(path), undefined);
  for (const path of retained) assert.ok(await files.match(path), 'Turbo and shared speaker models must remain available');
});
