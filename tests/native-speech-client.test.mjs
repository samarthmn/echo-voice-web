import test from 'node:test';
import assert from 'node:assert/strict';
import { runNativeSpeech, cancelNativeSpeech, nativePCM, createNativeSpeechClient } from '../web/native-speech.js';
const turn = () => new Promise(resolve => setImmediate(resolve));

test('PCM transport uses exactly the subarray samples as little-endian floats', () => {
  const pcm = nativePCM(new Float32Array([99, .5, -.25, 99]).subarray(1, 3));
  assert.equal(pcm.byteLength, 8);
  assert.equal(new DataView(pcm).getFloat32(0, true), .5);
  assert.equal(new DataView(pcm).getFloat32(4, true), -.25);
  assert.throws(() => nativePCM(new Float32Array([NaN])), /invalid samples/);
});

test('native job progress and timestamp result use the client-owned identifier', async t => {
  const previous = globalThis.fetch, requests = [], progress = [];
  t.after(() => { globalThis.fetch = previous; });
  let jobId;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      const query = new URL(url, 'http://localhost').searchParams;
      jobId = query.get('jobId');
      assert.match(jobId, /^[a-f\d-]{36}$/);
      assert.equal(query.get('operation'), 'transcribe');
      assert.equal(query.get('language'), 'en');
      assert.equal(options.headers['Content-Type'], 'application/octet-stream');
      assert.equal(options.body.byteLength, 8);
      return Response.json({ jobId, state: 'queued' }, { status: 202 });
    }
    assert.equal(url, `/api/speech/jobs/${jobId}`);
    return Response.json({ state: 'completed', progress: { status: 'Transcript ready', progress: 100 }, result: { words: [{ text: 'hello', timestamp: [0, 1] }], duration: 1 } });
  };
  const result = await runNativeSpeech('transcribe', new Float32Array([0, 1]), 'english', value => progress.push(value));
  assert.equal(result.words[0].text, 'hello');
  assert.equal(progress[0].status, 'Transcript ready');
  assert.equal(requests.length, 2);
});

test('cancelling a pending upload fences only its exact ID and ignores a late successful reply', async t => {
  const previous = globalThis.fetch, deleted = [];
  t.after(() => { globalThis.fetch = previous; });
  let releaseUpload, jobId;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      jobId = new URL(url, 'http://localhost').searchParams.get('jobId');
      // Deliberately ignore abort to model a late response after server reservation.
      return new Promise(resolve => { releaseUpload = () => resolve(Response.json({ jobId, state: 'queued' })); });
    }
    if (options.method === 'DELETE') { deleted.push(url); return Response.json({ jobId, state: 'cancelled' }); }
    assert.fail('A cancelled late upload must never poll or use the result');
  };
  const job = runNativeSpeech('download');
  const rejected = assert.rejects(job, error => error.name === 'AbortError');
  await turn();
  cancelNativeSpeech();
  releaseUpload();
  await rejected;
  assert.ok(deleted.length >= 1);
  assert.ok(deleted.every(url => url === `/api/speech/jobs/${jobId}`));
});

test('native failure and lost upload replies clean up the owned job without cancelling another tab', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const lost of [false, true]) {
    let jobId; const deletes = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        jobId = new URL(url, 'http://localhost').searchParams.get('jobId');
        if (lost) throw new TypeError('reply lost');
        return Response.json({ jobId });
      }
      if (options.method === 'DELETE') { deletes.push(url); return Response.json({ jobId, state: 'cancelled' }); }
      return Response.json({ state: 'failed', error: 'Native encoder failed' });
    };
    await assert.rejects(runNativeSpeech('download'), lost ? /reply lost/ : /Native encoder failed/);
    assert.deepEqual(deletes, lost ? [`/api/speech/jobs/${jobId}`] : []);
    await turn();
  }
});

test('cancellation during native polling suppresses a late completed result and progress', async t => {
  const previous = globalThis.fetch, progress = [], deleted = [];
  t.after(() => { globalThis.fetch = previous; });
  let jobId, finishPoll;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      jobId = new URL(url, 'http://localhost').searchParams.get('jobId');
      return Response.json({ jobId, state: 'queued' });
    }
    if (options.method === 'DELETE') { deleted.push(url); return Response.json({ jobId, state: 'cancelled' }); }
    return new Promise(resolve => { finishPoll = () => resolve(Response.json({ state: 'completed', progress: { status: 'Ready', progress: 100 }, result: { words: [] } })); });
  };
  const job = runNativeSpeech('download', undefined, 'auto', value => progress.push(value));
  const rejected = assert.rejects(job, error => error.name === 'AbortError');
  await turn();
  assert.equal(typeof finishPoll, 'function');
  cancelNativeSpeech();
  finishPoll();
  await rejected;
  assert.deepEqual(progress, []);
  assert.ok(deleted.every(url => url === `/api/speech/jobs/${jobId}`));
});

const storageKey = 'echo-native-speech-owned-jobs-v1';
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function memoryLocks() {
  const held = new Set();
  return { async request(name, options, callback) {
    assert.equal(options.ifAvailable, true);
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
}
function clockFixture() {
  let nextId = 0;
  const timers = new Map();
  return {
    timers, setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id),
    async tick(delay) {
      await turn();
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]); entry[1].fn(); await turn();
    },
  };
}

test('pagehide keeps only an owned ID and uses keepalive; reload retries until exact acknowledgement', async t => {
  const locks = memoryLocks(), storage = memoryStorage(), events = new EventTarget(), clock = clockFixture(), requests = [];
  let id;
  const client = createNativeSpeechClient({ storage: () => storage, locks, events, ...clock, fetchRequest: async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      id = new URL(url, 'http://localhost').searchParams.get('jobId');
      // Ownership is durable before any server reservation/upload can complete.
      assert.deepEqual(JSON.parse(storage.getItem(storageKey)), [id]);
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    }
    throw new TypeError('offline');
  } });
  t.after(() => client.dispose());
  const job = client.run('download'), rejected = assert.rejects(job, error => error.name === 'AbortError');
  await turn(); events.dispatchEvent(new Event('pagehide')); await rejected; await turn();
  assert.ok(requests.some(request => request.options.method === 'DELETE' && request.options.keepalive === true));
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)), [id]);
  assert.equal(clock.timers.size, 0, 'Hidden pages do not spin recovery timers');
  client.dispose(); await turn();
  const recoveredClock = clockFixture(), recovered = [];
  const afterReload = createNativeSpeechClient({ storage: () => storage, locks, events: new EventTarget(), ...recoveredClock, fetchRequest: async (url, options) => {
    recovered.push({ url, options }); return Response.json({ jobId: id, state: 'cancelled' });
  } });
  t.after(() => afterReload.dispose());
  await recoveredClock.tick(0);
  assert.deepEqual(recovered.map(request => request.url), [`/api/speech/jobs/${id}`]);
  assert.equal(recovered[0].options.method, 'DELETE');
  assert.equal(storage.getItem(storageKey), null);
});

test('cancellation retry backs off, stops after a bounded burst and resumes on reconnection', async t => {
  const id = crypto.randomUUID(), storage = memoryStorage(), events = new EventTarget(), clock = clockFixture();
  storage.setItem(storageKey, JSON.stringify([id, 'invalid-id']));
  let ack = false, calls = 0;
  const client = createNativeSpeechClient({ storage: () => storage, locks: memoryLocks(), events, ...clock, retryDelays: [5, 10], fetchRequest: async (url, options) => {
    calls++; assert.equal(url, `/api/speech/jobs/${id}`); assert.equal(options.method, 'DELETE');
    if (!ack) throw new TypeError('offline');
    return Response.json({ jobId: id, state: 'cancelled' });
  } });
  t.after(() => client.dispose());
  await clock.tick(0); await clock.tick(5); await clock.tick(10);
  assert.equal(calls, 3); assert.equal(clock.timers.size, 0);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)), [id]);
  ack = true; events.dispatchEvent(new Event('online')); await clock.tick(0);
  assert.equal(calls, 4); assert.equal(storage.getItem(storageKey), null);
});

test('stalled cancellation and status calls have bounded waits; completed IDs need no cleanup DELETE', async t => {
  const id = crypto.randomUUID(), storage = memoryStorage(), events = new EventTarget(), clock = clockFixture();
  storage.setItem(storageKey, JSON.stringify([id]));
  const client = createNativeSpeechClient({ storage: () => storage, locks: memoryLocks(), events, ...clock, fetchRequest: async (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
  t.after(() => client.dispose());
  await clock.tick(0); await clock.tick(3000);
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)), [id]);
  const status = client.getStatus(), failed = assert.rejects(status, /did not respond/);
  await clock.tick(10000); await failed;
  client.dispose();

  const completedStorage = memoryStorage(), completedRequests = [];
  const completed = createNativeSpeechClient({ storage: () => completedStorage, events: new EventTarget(), fetchRequest: async (url, options = {}) => {
    completedRequests.push({ url, options });
    if (options.method === 'POST') return Response.json({ jobId: new URL(url, 'http://localhost').searchParams.get('jobId') });
    return Response.json({ state: 'completed', result: { words: [] } });
  } });
  t.after(() => completed.dispose());
  await completed.run('download');
  assert.equal(completedStorage.getItem(storageKey), null);
  assert.equal(completedRequests.filter(request => request.options.method === 'DELETE').length, 0);
});

test('a successful status refresh resumes exhausted owned cancellation without touching server activeJob', async t => {
  const id = crypto.randomUUID(), foreign = crypto.randomUUID(), storage = memoryStorage(), events = new EventTarget(), clock = clockFixture(), deleted = [];
  storage.setItem(storageKey, JSON.stringify([id]));
  let ready = false;
  const client = createNativeSpeechClient({ storage: () => storage, locks: memoryLocks(), events, ...clock, retryDelays: [], fetchRequest: async (url, options = {}) => {
    if (url === '/api/speech') return Response.json({ available: true, activeJob: { jobId: foreign, state: 'running' } });
    deleted.push(url);
    if (!ready) throw new TypeError('server stopped');
    return Response.json({ jobId: id, state: 'cancelled' });
  } });
  t.after(() => client.dispose());
  await clock.tick(0); assert.equal(clock.timers.size, 0);
  ready = true; await client.getStatus(); await clock.tick(0);
  assert.deepEqual(deleted, [`/api/speech/jobs/${id}`, `/api/speech/jobs/${id}`]);
  assert.ok(deleted.every(url => !url.includes(foreign)));
  assert.equal(storage.getItem(storageKey), null);
});

test('duplicating session storage cannot cancel a live source-tab job protected by its Web Lock', async t => {
  const locks = memoryLocks(), sourceStorage = memoryStorage(), sourceEvents = new EventTarget();
  let id, deletes = [];
  const source = createNativeSpeechClient({ locks, storage: () => sourceStorage, events: sourceEvents, fetchRequest: async (url, options = {}) => {
    if (options.method === 'POST') {
      id = new URL(url, 'http://localhost').searchParams.get('jobId');
      return Response.json({ jobId: id });
    }
    if (options.method === 'DELETE') { deletes.push(url); return Response.json({ jobId: id, state: 'cancelled' }); }
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  } });
  t.after(() => source.dispose());
  const job = source.run('download'), rejected = assert.rejects(job, error => error.name === 'AbortError');
  await turn();
  const copied = memoryStorage(); copied.setItem(storageKey, sourceStorage.getItem(storageKey));
  const duplicate = createNativeSpeechClient({ locks, storage: () => copied, events: new EventTarget(), fetchRequest: async () => assert.fail('A duplicate must not contact a source-owned job') });
  t.after(() => duplicate.dispose());
  await turn();
  assert.equal(copied.getItem(storageKey), null);
  assert.deepEqual(JSON.parse(sourceStorage.getItem(storageKey)), [id]);
  assert.deepEqual(deletes, []);
  source.cancel(); await rejected; await turn();
  assert.deepEqual(deletes, [`/api/speech/jobs/${id}`]);
  assert.equal(sourceStorage.getItem(storageKey), null);
});

test('cancellation before recovery or lock acquisition prevents any POST and releases acquired locks', async t => {
  const locks = memoryLocks(), storage = memoryStorage(), requests = [];
  const client = createNativeSpeechClient({ locks, storage: () => storage, events: new EventTarget(), fetchRequest: async url => { requests.push(url); assert.fail('Cancelled start must not upload'); } });
  t.after(() => client.dispose());
  const job = client.run('download'), rejected = assert.rejects(job, error => error.name === 'AbortError');
  client.cancel(); await rejected;
  assert.deepEqual(requests, []); assert.equal(storage.getItem(storageKey), null);
});
