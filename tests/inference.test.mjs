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
  finish(result) { this.dispatchEvent(new MessageEvent('message', { data: { id: this.lastMessage.id, type: 'result', result } })); }
}
globalThis.Worker = FakeWorker;
const inference = await import('../web/inference.js');
const { MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl, speechModelConfig, MODELS } = await import('../web/models.js');
const turbo = MODELS[0].id; const large = MODELS[1].id;
const manifestData = (id, files) => ({ files, checkpoint: speechModelConfig(id).checkpoint, revision: speechModelConfig(id).revision, precision: speechModelConfig(id).precision ?? 'q8', wordTimestamps: true, ...(speechModelConfig(id).requireForwardVerification ? { forwardVerified: true } : {}) });
const turn = () => new Promise(resolve => setImmediate(resolve));

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

test('Large V3 invalidates a different precision without removing weights while existing Turbo stays ready', async () => {
  const files = await caches.open(MODEL_CACHE); const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${speechModelConfig(large).checkpoint}/resolve/main/encoder_model_quantized.onnx`;
  await files.put(path, new Response('old large encoder'));
  const old = manifestData(large, [path]); old.precision = 'q4-encoder-q8-decoder';
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(old)));
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

test('Large cached files require successful forward qualification while older Turbo markers stay compatible', async () => {
  const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${speechModelConfig(large).checkpoint}/resolve/main/decoder_model_merged_quantized.onnx`;
  await files.put(path, new Response('weights'));
  const old = manifestData(large, [path]); delete old.forwardVerified;
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(old)));
  assert.ok(!(await inference.getDownloadedModels()).includes(large));
  assert.ok((await inference.getOutdatedModels()).includes(large));
  assert.ok(await files.match(path));
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify(manifestData(large, [path]))));
  assert.ok((await inference.getDownloadedModels()).includes(large));
  await manifests.delete(modelManifestUrl(large));
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
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, location.origin).pathname;
    if (path.endsWith('/audio')) return new Response('fixture audio');
    if (path === '/api/vocabulary') return Response.json({ entries: [] });
    if (path === '/api/settings') return Response.json({ language: 'english' });
    if (path.endsWith('/transcripts')) return Response.json({ id: 'saved-transcript' });
    if (path.startsWith('/api/meetings/')) return Response.json({ status: 'saved', transcripts: [], duration: 1, tracks: [{ id: 'track', url: '/api/meetings/unload-test/audio' }] });
    assert.fail(`Unexpected request: ${options.method || 'GET'} ${path}`);
  };
  try {
    await files.put(fixture, new Response('weights'));
    await manifests.put(key, new Response(JSON.stringify(manifestData(turbo, [fixture]))));
    assert.equal(warns(), false);
    for (const outcome of ['success', 'error', 'cancel']) {
      const count = instances.length;
      const job = inference.transcribeMeeting(`unload-${outcome}`, turbo);
      // Covers metadata/audio loading and a job that has not reached its worker yet.
      assert.equal(warns(), true);
      const rejected = outcome === 'success' ? null : assert.rejects(job, outcome === 'cancel' ? error => error.name === 'AbortError' : /native failure/);
      await turn();
      assert.equal(instances.length, count + 1);
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
    globalThis.fetch = originalFetch;
    globalThis.AudioContext = originalAudioContext;
    globalThis.OfflineAudioContext = originalOfflineContext;
    await files.delete(fixture);
    if (previous) await manifests.put(key, previous); else await manifests.delete(key);
  }
});
