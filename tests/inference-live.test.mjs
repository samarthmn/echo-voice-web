import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
globalThis.location = { origin: 'http://localhost:3111' };
Object.defineProperty(globalThis, 'navigator', { value: { storage: { persist: async () => true } }, configurable: true });
class MemoryCache {
  values = new Map();
  async put(key, value) { this.values.set(key, value.clone()); }
  async match(key) { return this.values.get(key)?.clone(); }
}
const stores = new Map(), workers = [];
globalThis.caches = { async open(key) { if (!stores.has(key)) stores.set(key, new MemoryCache()); return stores.get(key); } };
class FakeWorker extends EventTarget {
  constructor() { super(); workers.push(this); this.messages = []; }
  postMessage(message) { this.messages.push(message); this.last = message; }
  terminate() { this.terminated = true; }
  finish(result = { words: [{ text: 'hello', timestamp: [1, 2] }], duration: 20, modelRevision: revision }) {
    this.dispatchEvent(new MessageEvent('message', { data: { id: this.last.id, type: 'result', result } }));
  }
}
globalThis.Worker = FakeWorker;
const inference = await import('../web/inference.js');
const { MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl, DEFAULT_SPEECH_MODEL, speechModelConfig } = await import('../web/models.js');
const config = speechModelConfig(DEFAULT_SPEECH_MODEL), revision = config.revision;
const file = 'https://huggingface.co/test/live.onnx';
const files = await caches.open(MODEL_CACHE), manifests = await caches.open(MODEL_MANIFEST_CACHE);
await files.put(file, new Response('fixture'));
await manifests.put(modelManifestUrl(DEFAULT_SPEECH_MODEL), Response.json({ checkpoint: config.checkpoint, revision, wordTimestamps: true, files: [file] }));
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };

test('controller reuses a warm Turbo ASR worker while routing each result by job ID', async () => {
  const first = inference.transcribeLiveWindow(new Float32Array(20 * 16000), { jobId: 'live-one' }); await flush();
  const worker = workers.at(-1);
  assert.equal(worker.last.type, 'transcribe-live'); assert.equal(worker.last.modelId, DEFAULT_SPEECH_MODEL);
  worker.dispatchEvent(new MessageEvent('message', { data: { id: 'unrelated', type: 'result', result: {} } }));
  worker.finish(); assert.equal((await first).words[0].text, 'hello'); assert.equal(worker.terminated, undefined);
  const second = inference.transcribeLiveWindow(new Float32Array(20 * 16000), { jobId: 'live-two', language: 'fr' }); await flush();
  assert.equal(workers.at(-1), worker); assert.equal(worker.last.options.language, 'fr');
  worker.finish(); await second; assert.equal(worker.messages.length, 2);
  inference.releaseLiveInference(); assert.equal(worker.terminated, true);
});

test('live cancellation ignores unrelated IDs and releases only the matching runtime', async () => {
  const job = inference.transcribeLiveWindow(new Float32Array(20 * 16000), { jobId: 'live-scoped' });
  const rejected = assert.rejects(job, error => error.name === 'AbortError'); await flush();
  const worker = workers.at(-1);
  assert.equal(inference.cancelLiveInference('other-job'), false); assert.equal(worker.terminated, undefined);
  assert.equal(inference.cancelLiveInference('live-scoped'), true); await rejected;
  assert.equal(worker.terminated, true); assert.equal(inference.getInferenceState().liveJobId, null);
  const retry = inference.transcribeLiveWindow(new Float32Array(20 * 16000)); await flush(); workers.at(-1).finish(); await retry;
  inference.releaseLiveInference();
});

test('ordinary processing preempts live immediately and cancellation does not reject the unrelated download', async () => {
  const live = inference.transcribeLiveWindow(new Float32Array(20 * 16000), { jobId: 'preempted' });
  const rejected = assert.rejects(live, error => error.name === 'AbortError'); await flush();
  const old = workers.at(-1);
  const download = inference.downloadModel(DEFAULT_SPEECH_MODEL);
  assert.equal(old.terminated, true); assert.equal(inference.getInferenceState().busy, true);
  await rejected; await flush();
  const next = workers.at(-1); assert.notEqual(next, old); assert.equal(next.last.type, 'download');
  assert.equal(inference.cancelLiveInference('preempted'), false); assert.equal(next.terminated, undefined);
  await assert.rejects(inference.transcribeLiveWindow(new Float32Array(20 * 16000)), error => error.code === 'processing-busy');
  next.finish(); await download; assert.equal(inference.getInferenceState().busy, false);
});

test('aborting live via signal terminates its worker without advancing final cancellation generation', async () => {
  const controller = new AbortController();
  const job = inference.transcribeLiveWindow(new Float32Array(20 * 16000), { jobId: 'signal-job', signal: controller.signal });
  const rejected = assert.rejects(job, error => error.name === 'AbortError'); await flush();
  controller.abort(); await rejected; assert.equal(workers.at(-1).terminated, true);
  const next = inference.downloadModel(DEFAULT_SPEECH_MODEL); await flush(); workers.at(-1).finish(); await next;
});

test('invalid live timestamps or revision dispose the warm runtime and preserve a clean retry', async () => {
  for (const result of [
    { words: [{ text: 'bad', timestamp: [2, 1] }], duration: 20, modelRevision: revision },
    { words: [{ text: 'bad', timestamp: [1, 2] }], duration: 20, modelRevision: 'wrong' },
    { words: [{ text: 'bad', timestamp: [1, 2] }], duration: 30, modelRevision: revision },
  ]) {
    const job = inference.transcribeLiveWindow(new Float32Array(20 * 16000)); const rejected = assert.rejects(job, /invalid|unexpected/); await flush();
    const worker = workers.at(-1); worker.finish(result); await rejected; assert.equal(worker.terminated, true);
  }
  const next = inference.transcribeLiveWindow(new Float32Array(20 * 16000)); await flush(); workers.at(-1).finish(); await next; inference.releaseLiveInference();
});

test('missing offline model refuses live without constructing a worker or triggering download', async () => {
  const previous = files.values.get(file); files.values.delete(file);
  const count = workers.length;
  try {
    await assert.rejects(inference.transcribeLiveWindow(new Float32Array(20 * 16000)), error => error.code === 'model-missing');
    assert.equal(workers.length, count); assert.equal(inference.getModelDownloadState().status, 'completed');
  } finally { files.values.set(file, previous); }
});
