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
const { MODEL_CACHE, MODEL_MANIFEST_CACHE, modelManifestUrl, MODELS } = await import('../web/models.js');
const turbo = MODELS[0].id; const large = MODELS[1].id;
const turn = () => new Promise(resolve => setImmediate(resolve));

test('partial downloads are never reported as offline ready and missing cached files invalidate readiness', async () => {
  const files = await caches.open(MODEL_CACHE); const manifests = await caches.open(MODEL_MANIFEST_CACHE);
  const path = `https://huggingface.co/${turbo}/resolve/main/encoder.onnx`;
  await files.put(path, new Response('weights'));
  assert.deepEqual(await inference.getDownloadedModels(), []);
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify({ files: [path] })));
  assert.deepEqual(await inference.getDownloadedModels(), [turbo]);
  await files.delete(path);
  assert.deepEqual(await inference.getDownloadedModels(), []);
  assert.equal(await manifests.match(modelManifestUrl(turbo)), undefined);
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
  await manifests.put(modelManifestUrl(turbo), new Response(JSON.stringify({ files: [turboPath] })));
  await manifests.put(modelManifestUrl(large), new Response(JSON.stringify({ files: [largePath] })));
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
