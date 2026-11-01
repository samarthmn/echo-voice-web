import { fetchUrl, bytes } from '../helpers/assertions.ts';
import { array } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runNativeSpeech,
  cancelNativeSpeech,
  nativePCM,
  createNativeSpeechClient,
} from '../../web/native-speech.ts';
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('PCM transport uses exactly the subarray samples as little-endian floats', () => {
  const pcm = nativePCM(new Float32Array([99, 0.5, -0.25, 99]).subarray(1, 3));
  assert.equal(pcm.byteLength, 8);
  assert.equal(new DataView(pcm).getFloat32(0, true), 0.5);
  assert.equal(new DataView(pcm).getFloat32(4, true), -0.25);
  assert.throws(() => nativePCM(new Float32Array([NaN])), /invalid samples/);
});

test('native job progress and timestamp result use the client-owned identifier', async (t) => {
  const previous = globalThis.fetch,
    requests: { url: string; options: RequestInit }[] = [],
    progress: { status: unknown }[] = [];
  t.after(() => {
    globalThis.fetch = previous;
  });
  let jobId: string | null | undefined;
  globalThis.fetch = async (input, options = {}) => {
    const url = fetchUrl(input);
    requests.push({ url, options });
    if (options.method === 'POST') {
      const query = new URL(fetchUrl(url), 'http://localhost').searchParams;
      jobId = query.get('jobId');
      assert.match(defined(jobId), /^[a-f\d-]{36}$/);
      assert.equal(query.get('operation'), 'transcribe');
      assert.equal(query.get('language'), 'en');
      assert.equal(new Headers(options.headers).get('Content-Type'), 'application/octet-stream');
      assert.equal(bytes(options.body).byteLength, 8);
      return Response.json({ jobId, state: 'queued' }, { status: 202 });
    }
    assert.equal(url, `/api/speech/jobs/${jobId}`);
    return Response.json({
      state: 'completed',
      progress: { status: 'Transcript ready', progress: 100 },
      result: { words: [{ text: 'hello', timestamp: [0, 1] }], duration: 1 },
    });
  };
  const result = await runNativeSpeech('transcribe', new Float32Array([0, 1]), 'english', (value) =>
    progress.push(value),
  );
  assert.equal(defined(defined(defined(result).words)[0]).text, 'hello');
  assert.equal(defined(progress[0]).status, 'Transcript ready');
  assert.equal(requests.length, 2);
});

test('cancelling a pending upload fences only its exact ID and ignores a late successful reply', async (t) => {
  const previous = globalThis.fetch,
    deleted: (RequestInfo | URL)[] = [];
  t.after(() => {
    globalThis.fetch = previous;
  });
  let releaseUpload: (() => void) | undefined, jobId: string | null;
  globalThis.fetch = async (input, options = {}) => {
    const url = fetchUrl(input);
    if (options.method === 'POST') {
      jobId = new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId');
      // Deliberately ignore abort to model a late response after server reservation.
      return new Promise((resolve) => {
        releaseUpload = () => resolve(Response.json({ jobId, state: 'queued' }));
      });
    }
    if (options.method === 'DELETE') {
      deleted.push(url);
      return Response.json({ jobId, state: 'cancelled' });
    }
    assert.fail('A cancelled late upload must never poll or use the result');
  };
  const job = runNativeSpeech('download');
  const rejected = assert.rejects(job, (error) => object(error)['name'] === 'AbortError');
  await turn();
  cancelNativeSpeech();
  defined(releaseUpload)();
  await rejected;
  assert.ok(deleted.length >= 1);
  assert.ok(deleted.every((url) => url === `/api/speech/jobs/${jobId}`));
});

test('native failure and lost upload replies clean up the owned job without cancelling another tab', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const lost of [false, true]) {
    let jobId: string | null | undefined;
    const deletes: unknown = [];
    globalThis.fetch = async (input, options = {}) => {
      const url = fetchUrl(input);
      if (options.method === 'POST') {
        jobId = new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId');
        if (lost) throw new TypeError('reply lost');
        return Response.json({ jobId });
      }
      if (options.method === 'DELETE') {
        array(deletes).push(url);
        return Response.json({ jobId, state: 'cancelled' });
      }
      return Response.json({ state: 'failed', error: 'Native encoder failed' });
    };
    await assert.rejects(
      runNativeSpeech('download'),
      lost ? /reply lost/ : /Native encoder failed/,
    );
    assert.deepEqual(deletes, lost ? [`/api/speech/jobs/${jobId}`] : []);
    await turn();
  }
});

test('cancellation during native polling suppresses a late completed result and progress', async (t) => {
  const previous = globalThis.fetch,
    progress: unknown = [],
    deleted: (RequestInfo | URL)[] = [];
  t.after(() => {
    globalThis.fetch = previous;
  });
  let jobId: string | null, finishPoll: (() => void) | undefined;
  globalThis.fetch = async (input, options = {}) => {
    const url = fetchUrl(input);
    if (options.method === 'POST') {
      jobId = new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId');
      return Response.json({ jobId, state: 'queued' });
    }
    if (options.method === 'DELETE') {
      deleted.push(url);
      return Response.json({ jobId, state: 'cancelled' });
    }
    return new Promise((resolve) => {
      finishPoll = () =>
        resolve(
          Response.json({
            state: 'completed',
            progress: { status: 'Ready', progress: 100 },
            result: { words: [] },
          }),
        );
    });
  };
  const job = runNativeSpeech('download', undefined, 'auto', (value) =>
    array(progress).push(value),
  );
  const rejected = assert.rejects(job, (error) => object(error)['name'] === 'AbortError');
  await turn();
  assert.equal(typeof finishPoll, 'function');
  cancelNativeSpeech();
  defined(finishPoll)();
  await rejected;
  assert.deepEqual(progress, []);
  assert.ok(deleted.every((url) => url === `/api/speech/jobs/${jobId}`));
});

const storageKey = 'echo-native-speech-owned-jobs-v1';
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
function memoryLocks() {
  const held = new Set<string>();
  return {
    async request<T>(
      name: string,
      options: { ifAvailable: true },
      callback: (lock: { name: string } | null) => Promise<T>,
    ) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
function clockFixture() {
  let nextId = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  return {
    timers,
    setTimer: (fn: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer: (id: number | ReturnType<typeof setTimeout> | undefined) => {
      if (typeof id === 'number') timers.delete(id);
    },
    async tick(delay: number) {
      await turn();
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].fn();
      await turn();
    },
  };
}

test('pagehide keeps only an owned ID and uses keepalive; reload retries until exact acknowledgement', async (t) => {
  const locks = memoryLocks(),
    storage = memoryStorage(),
    events = new EventTarget(),
    clock = clockFixture(),
    requests: { url: RequestInfo | URL; options: RequestInit }[] = [];
  let id: string | null | undefined;
  const client = createNativeSpeechClient({
    storage: () => storage,
    locks,
    events,
    ...clock,
    fetchRequest: async (input, options = {}) => {
      const url = fetchUrl(input);
      requests.push({ url, options });
      if (options.method === 'POST') {
        id = new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId');
        // Ownership is durable before any server reservation/upload can complete.
        assert.deepEqual(JSON.parse(defined(storage.getItem(storageKey))) as unknown, [id]);
        return new Promise<Response>((_resolve, reject) =>
          defined(options.signal).addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        );
      }
      throw new TypeError('offline');
    },
  });
  t.after(() => client.dispose());
  const job = client.run('download'),
    rejected = assert.rejects(job, (error) => object(error)['name'] === 'AbortError');
  await turn();
  events.dispatchEvent(new Event('pagehide'));
  await rejected;
  await turn();
  assert.ok(
    requests.some(
      (request) => request.options.method === 'DELETE' && request.options.keepalive === true,
    ),
  );
  assert.deepEqual(JSON.parse(defined(storage.getItem(storageKey))) as unknown, [id]);
  assert.equal(clock.timers.size, 0, 'Hidden pages do not spin recovery timers');
  client.dispose();
  await turn();
  const recoveredClock = clockFixture(),
    recovered: { url: RequestInfo | URL; options: RequestInit | undefined }[] = [];
  const afterReload = createNativeSpeechClient({
    storage: () => storage,
    locks,
    events: new EventTarget(),
    ...recoveredClock,
    fetchRequest: async (url, options) => {
      recovered.push({ url, options });
      return Response.json({ jobId: id, state: 'cancelled' });
    },
  });
  t.after(() => afterReload.dispose());
  await recoveredClock.tick(0);
  assert.deepEqual(
    recovered.map((request) => request.url),
    [`/api/speech/jobs/${id}`],
  );
  assert.equal(defined(defined(recovered[0]).options).method, 'DELETE');
  assert.equal(storage.getItem(storageKey), null);
});

test('cancellation retry backs off, stops after a bounded burst and resumes on reconnection', async (t) => {
  const id = crypto.randomUUID(),
    storage = memoryStorage(),
    events = new EventTarget(),
    clock = clockFixture();
  storage.setItem(storageKey, JSON.stringify([id, 'invalid-id']));
  let ack = false,
    calls = 0;
  const client = createNativeSpeechClient({
    storage: () => storage,
    locks: memoryLocks(),
    events,
    ...clock,
    retryDelays: [5, 10],
    fetchRequest: async (url, options) => {
      calls++;
      assert.equal(url, `/api/speech/jobs/${id}`);
      assert.equal(defined(options).method, 'DELETE');
      if (!ack) throw new TypeError('offline');
      return Response.json({ jobId: id, state: 'cancelled' });
    },
  });
  t.after(() => client.dispose());
  await clock.tick(0);
  await clock.tick(5);
  await clock.tick(10);
  assert.equal(calls, 3);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(JSON.parse(defined(storage.getItem(storageKey))) as unknown, [id]);
  ack = true;
  events.dispatchEvent(new Event('online'));
  await clock.tick(0);
  assert.equal(calls, 4);
  assert.equal(storage.getItem(storageKey), null);
});

test('stalled cancellation and status calls have bounded waits; completed IDs need no cleanup DELETE', async (t) => {
  const id = crypto.randomUUID(),
    storage = memoryStorage(),
    events = new EventTarget(),
    clock = clockFixture();
  storage.setItem(storageKey, JSON.stringify([id]));
  const client = createNativeSpeechClient({
    storage: () => storage,
    locks: memoryLocks(),
    events,
    ...clock,
    fetchRequest: async (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        defined(defined(options).signal).addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        ),
      ),
  });
  t.after(() => client.dispose());
  await clock.tick(0);
  await clock.tick(3000);
  assert.deepEqual(JSON.parse(defined(storage.getItem(storageKey))) as unknown, [id]);
  const status = client.getStatus(),
    failed = assert.rejects(status, /did not respond/);
  await clock.tick(10000);
  await failed;
  client.dispose();

  const completedStorage = memoryStorage(),
    completedRequests: unknown[] = [];
  const completed = createNativeSpeechClient({
    storage: () => completedStorage,
    events: new EventTarget(),
    fetchRequest: async (input, options = {}) => {
      const url = fetchUrl(input);
      completedRequests.push({ url, options });
      if (options.method === 'POST')
        return Response.json({
          jobId: new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId'),
        });
      return Response.json({ state: 'completed', result: { words: [] } });
    },
  });
  t.after(() => completed.dispose());
  await completed.run('download');
  assert.equal(completedStorage.getItem(storageKey), null);
  assert.equal(
    completedRequests.filter((request) => object(object(request)['options'])['method'] === 'DELETE')
      .length,
    0,
  );
});

test('a successful status refresh resumes exhausted owned cancellation without touching server activeJob', async (t) => {
  const id = crypto.randomUUID(),
    foreign = crypto.randomUUID(),
    storage = memoryStorage(),
    events = new EventTarget(),
    clock = clockFixture(),
    deleted: unknown = [];
  storage.setItem(storageKey, JSON.stringify([id]));
  let ready = false;
  const client = createNativeSpeechClient({
    storage: () => storage,
    locks: memoryLocks(),
    events,
    ...clock,
    retryDelays: [],
    fetchRequest: async (input, _options = {}) => {
      const url = fetchUrl(input);
      if (url === '/api/speech')
        return Response.json({ available: true, activeJob: { jobId: foreign, state: 'running' } });
      array(deleted).push(url);
      if (!ready) throw new TypeError('server stopped');
      return Response.json({ jobId: id, state: 'cancelled' });
    },
  });
  t.after(() => client.dispose());
  await clock.tick(0);
  assert.equal(clock.timers.size, 0);
  ready = true;
  await client.getStatus();
  await clock.tick(0);
  assert.deepEqual(deleted, [`/api/speech/jobs/${id}`, `/api/speech/jobs/${id}`]);
  assert.ok(deleted.every((url) => !url.includes(foreign)));
  assert.equal(storage.getItem(storageKey), null);
});

test('duplicating session storage cannot cancel a live source-tab job protected by its Web Lock', async (t) => {
  const locks = memoryLocks(),
    sourceStorage = memoryStorage(),
    sourceEvents = new EventTarget();
  let id: string | null | undefined,
    deletes: unknown = [];
  const source = createNativeSpeechClient({
    locks,
    storage: () => sourceStorage,
    events: sourceEvents,
    fetchRequest: async (input, options = {}) => {
      const url = fetchUrl(input);
      if (options.method === 'POST') {
        id = new URL(fetchUrl(url), 'http://localhost').searchParams.get('jobId');
        return Response.json({ jobId: id });
      }
      if (options.method === 'DELETE') {
        array(deletes).push(url);
        return Response.json({ jobId: id, state: 'cancelled' });
      }
      return new Promise<Response>((_resolve, reject) =>
        defined(options.signal).addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        ),
      );
    },
  });
  t.after(() => source.dispose());
  const job = source.run('download'),
    rejected = assert.rejects(job, (error) => object(error)['name'] === 'AbortError');
  await turn();
  const copied = memoryStorage();
  copied.setItem(storageKey, defined(sourceStorage.getItem(storageKey)));
  const duplicate = createNativeSpeechClient({
    locks,
    storage: () => copied,
    events: new EventTarget(),
    fetchRequest: async () => assert.fail('A duplicate must not contact a source-owned job'),
  });
  t.after(() => duplicate.dispose());
  await turn();
  assert.equal(copied.getItem(storageKey), null);
  assert.deepEqual(JSON.parse(defined(sourceStorage.getItem(storageKey))) as unknown, [id]);
  assert.deepEqual(deletes, []);
  source.cancel();
  await rejected;
  await turn();
  assert.deepEqual(deletes, [`/api/speech/jobs/${id}`]);
  assert.equal(sourceStorage.getItem(storageKey), null);
});

test('cancellation before recovery or lock acquisition prevents any POST and releases acquired locks', async (t) => {
  const locks = memoryLocks(),
    storage = memoryStorage(),
    requests: unknown = [];
  const client = createNativeSpeechClient({
    locks,
    storage: () => storage,
    events: new EventTarget(),
    fetchRequest: async (url) => {
      array(requests).push(url);
      assert.fail('Cancelled start must not upload');
    },
  });
  t.after(() => client.dispose());
  const job = client.run('download'),
    rejected = assert.rejects(job, (error) => object(error)['name'] === 'AbortError');
  client.cancel();
  await rejected;
  assert.deepEqual(requests, []);
  assert.equal(storage.getItem(storageKey), null);
});
