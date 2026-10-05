import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

globalThis.window = new EventTarget();
globalThis.location = { origin: 'http://localhost:3111' };
const { createExtensionLiveController, createExtensionLiveApi, mergeLiveWindow, validateLiveDraft, LIVE_SAMPLE_RATE: RATE } = await import('../web/extension-live.js');
const { validatedWhisperWords } = await import('../web/whisper-alignment.js');
const empty = () => ({ throughFrame: 0, committedThroughFrame: 0, words: [], language: 'auto', modelRevision: '' });
const word = (text, start, end) => ({ text, timestamp: [start, end] });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ totalFrames = 50 * RATE, draft, clockStart = 100000 } = {}) {
  let clock = clockStart, busy = false, model = true;
  const record = { recordingId: 'recording-one', meetingId: 'meeting-one', totalFrames, status: 'receiving', liveTranscription: true, draft };
  const jobs = [], reads = [], writes = [], cancelled = [], timers = [], deadlines = [];
  let owner = null, generation = 0, expiresAt = 0, leaseFailure = null, draftFailure = null, releases = 0;
  const api = {
    async recordings() { return { protocolVersion: 1, recordings: [structuredClone(record)] }; },
    async lease(id, requestedOwner) {
      if (leaseFailure) throw leaseFailure;
      if (owner && requestedOwner !== owner && clock < expiresAt) throw Object.assign(new Error('Lease held'), { status: 409 });
      if (requestedOwner !== owner || clock >= expiresAt) generation++;
      owner = requestedOwner; expiresAt = clock + 60000;
      return { protocolVersion: 1, generation, expiresAt: expiresAt / 1000, totalFrames: record.totalFrames, draft: structuredClone(record.draft || null) };
    },
    async pcm(id, startFrame, frameCount) { reads.push({ startFrame, frameCount }); return new Float32Array(frameCount); },
    async draft(id, body) {
      assert.equal(body.generation, generation);
      assert.equal(body.ownerId, owner);
      assert.ok(clock < expiresAt);
      const { ownerId, generation: fence, ...saved } = body;
      writes.push(structuredClone(body)); record.draft = structuredClone(saved);
      if (draftFailure) { const error = draftFailure; draftFailure = null; throw error; }
      return { protocolVersion: 1 };
    },
  };
  const inference = {
    getInferenceState: () => ({ busy }),
    getLiveModelStatus: async () => ({ ready: model }),
    transcribeLiveWindow(audio, options) {
      const job = { audio, options };
      jobs.push(job);
      return new Promise((resolve, reject) => { job.resolve = words => resolve({ words, modelRevision: 'revision-one' }); job.reject = reject; });
    },
    cancelLiveInference(jobId) { cancelled.push(jobId); jobs.find(job => job.options.jobId === jobId)?.reject(new DOMException('cancelled', 'AbortError')); },
    releaseLiveInference() { releases++; },
  };
  const make = (ownerId, options = {}) => createExtensionLiveController({ api, inference, ownerId, now: () => clock, setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimer() {}, setDeadline: (callback, ms) => { deadlines.push({ callback, at: clock + ms, cleared: false }); return deadlines.length - 1; }, clearDeadline: id => { if (deadlines[id]) deadlines[id].cleared = true; }, ...options });
  return { record, api, inference, make, jobs, reads, writes, cancelled, timers, deadlines, advance: ms => { clock += ms; }, runDeadlines: () => { for (const deadline of [...deadlines]) if (!deadline.cleared && deadline.at <= clock) { deadline.cleared = true; deadline.callback(); } }, setBusy: value => { busy = value; }, setModel: value => { model = value; }, failLease: error => { leaseFailure = error; }, failDraft: error => { draftFailure = error; }, get releases() { return releases; } };
}

test('midpoint ownership replaces provisional overlaps and preserves repeated phrases', () => {
  const first = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('yes', 1, 1.5), word('yes', 16, 16.5), word('old tail', 18, 19)], modelRevision: 'r' });
  assert.deepEqual(first.words.map(word => word.provisional), [false, false, true]);
  assert.equal(first.committedThroughFrame, 17.5 * RATE);
  const second = mergeLiveWindow(first, { startFrame: 15 * RATE, frameCount: 20 * RATE, words: [word('yes', 1, 1.5), word('new tail', 3, 4), word('yes', 10, 10.5), word('yes', 11, 11.5)], modelRevision: 'r' });
  assert.deepEqual(second.words.map(word => word.text), ['yes', 'yes', 'new tail', 'yes', 'yes']);
  assert.equal(second.throughFrame, 35 * RATE);
  assert.equal(second.committedThroughFrame, 32.5 * RATE);
  assert.deepEqual(validateLiveDraft(second, 50 * RATE), second);
});

test('a word crossing the temporal boundary is owned by its midpoint', () => {
  const first = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('before', 17, 17.9), word('after', 17, 18.1)], modelRevision: 'r' });
  assert.deepEqual(first.words.map(word => word.provisional), [false, true]);
  const second = mergeLiveWindow(first, { startFrame: 15 * RATE, frameCount: 20 * RATE, words: [word('before', 2, 2.9), word('after revised', 2, 3.1)], modelRevision: 'r' });
  assert.deepEqual(second.words.map(word => word.text), ['before', 'after revised']);
});

test('words exactly on the commit boundary are committed once across overlap', () => {
  const first = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('boundary', 17, 18)], modelRevision: 'r' });
  assert.equal(first.words[0].provisional, false);
  const next = mergeLiveWindow(first, { startFrame: 15 * RATE, frameCount: 20 * RATE, words: [word('boundary', 2, 3), word('next', 4, 5)], modelRevision: 'r' });
  assert.deepEqual(next.words.map(word => word.text), ['boundary', 'next']);
});

test('malformed timestamps and saved cursors are rejected without fabricating words', () => {
  assert.throws(() => mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('bad', 3, 2)] }), /timestamps/);
  assert.throws(() => validateLiveDraft({ ...empty(), throughFrame: 99 }, 10), /cursor/);
  assert.throws(() => validateLiveDraft({ ...empty(), throughFrame: 20 * RATE, committedThroughFrame: 17.5 * RATE, words: [{ text: 'wrong ownership', startFrame: 0, endFrame: RATE, provisional: true }] }, 30 * RATE), /timestamps/);
});

test('scheduler uses 20 second windows, 15 second stride, one active and one prepared', async () => {
  const f = fixture(), controller = f.make('owner-one');
  await controller.start(); await flush();
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.reads, [{ startFrame: 0, frameCount: 20 * RATE }, { startFrame: 15 * RATE, frameCount: 20 * RATE }]);
  for (let i = 0; i < 5; i++) await controller.poll();
  assert.equal(f.reads.length, 2); assert.equal(f.jobs.length, 1);
  assert.equal(controller.getState()[0].status, 'catching-up');
  f.jobs[0].resolve([word('one', 1, 2), word('temporary', 19, 19.5)]); await flush();
  assert.equal(f.jobs.length, 2);
  assert.equal(f.writes[0].throughFrame, 20 * RATE);
  assert.equal(f.writes[0].generation, 1);
  assert.equal(f.reads.length, 3);
  f.jobs[1].resolve([word('replacement', 4, 4.5)]); await flush();
  assert.deepEqual(f.writes[1].words.map(word => word.text), ['one', 'replacement']);
  controller.stop(); await flush();
});

test('workspace recovery resumes from persisted overlap cursor with committed words intact', async () => {
  const draft = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('saved', 2, 3), word('tail', 18, 19)], modelRevision: 'r' });
  const f = fixture({ totalFrames: 35 * RATE, draft }), controller = f.make('owner-one');
  await controller.start(); await flush();
  assert.deepEqual(f.reads, [{ startFrame: 15 * RATE, frameCount: 20 * RATE }]);
  f.jobs[0].resolve([word('corrected', 3, 4)]); await flush();
  assert.deepEqual(f.record.draft.words.map(word => word.text), ['saved', 'corrected']);
  controller.stop();
});

test('lease grant owns the authoritative cursor when a stale GET predates another owner save', async () => {
  const first = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('first', 1, 2)], modelRevision: 'r' });
  const advanced = mergeLiveWindow(first, { startFrame: 15 * RATE, frameCount: 20 * RATE, words: [word('already committed second', 5, 6)], modelRevision: 'r' });
  const f = fixture({ draft: first });
  const snapshot = structuredClone(f.record), grant = f.api.lease;
  f.api.recordings = async () => ({ recordings: [snapshot] });
  f.api.lease = async (...args) => {
    // The previous owner saves while the older GET is in flight, before the
    // new owner receives its atomic grant.
    f.record.draft = structuredClone(advanced);
    return grant(...args);
  };
  const controller = f.make('new-owner'); await controller.start(); await flush();
  assert.equal(f.reads[0].startFrame, 30 * RATE);
  assert.equal(controller.getState()[0].draft.throughFrame, 35 * RATE);
  f.jobs[0].resolve([]); await flush();
  assert.deepEqual(f.writes[0].words.map(word => word.text), ['first', 'already committed second']);
  assert.equal(f.writes[0].throughFrame, 50 * RATE);
  controller.stop(); await flush();
});

test('a lease lacking the authoritative draft is refused before PCM or ASR', async () => {
  const f = fixture();
  f.api.lease = async () => ({ generation: 1, expiresAt: 160 });
  const controller = f.make('owner-one'); await controller.start(); await flush();
  assert.equal(controller.getState()[0].status, 'connection-error');
  assert.match(controller.getState()[0].error, /authoritative live cursor/);
  assert.equal(f.reads.length, 0); assert.equal(f.jobs.length, 0);
  controller.stop();
});

test('missing model never starts PCM or inference and displays a download action', async () => {
  const f = fixture(); f.setModel(false);
  const controller = f.make('owner-one'); await controller.start(); await flush();
  assert.equal(controller.getState()[0].status, 'model-missing'); assert.equal(f.reads.length, 0); assert.equal(f.jobs.length, 0);
  f.setModel(true); await controller.poll(); await flush(); assert.equal(f.jobs.length, 1);
  controller.stop(); await flush();
});

test('an idle earlier recording does not block another recording with a ready window', async () => {
  const f = fixture({ totalFrames: 10 * RATE });
  const ready = { ...f.record, recordingId: 'recording-two', totalFrames: 20 * RATE };
  f.api.recordings = async () => ({ recordings: [f.record, ready] });
  const grant = f.api.lease;
  f.api.lease = async (...args) => ({ ...await grant(...args), totalFrames: ready.totalFrames });
  const controller = f.make('owner-one'); await controller.start(); await flush();
  assert.equal(controller.getWorkState().lease.recordingId, 'recording-two');
  assert.equal(f.jobs.length, 1); controller.stop(); await flush();
});

test('a ready recording leased elsewhere backs off while the next ready recording processes', async () => {
  const f = fixture(), second = { ...f.record, recordingId: 'recording-two' };
  f.api.recordings = async () => ({ recordings: [structuredClone(f.record), second] });
  const leases = [], grant = f.api.lease;
  f.api.lease = async (id, ...args) => {
    leases.push(id);
    if (id === f.record.recordingId) throw Object.assign(new Error('Another owner holds first'), { status: 409 });
    return grant(id, ...args);
  };
  const controller = f.make('owner-one');
  await controller.start(); await flush();
  for (let i = 0; i < 3; i++) await controller.poll();
  assert.deepEqual(leases, ['recording-one', 'recording-two']);
  assert.equal(controller.getState().find(state => state.recordingId === 'recording-one').status, 'lease-held');
  assert.equal(controller.getWorkState().lease.recordingId, 'recording-two');
  assert.equal(f.jobs.length, 1); assert.equal(f.reads.length, 2);
  controller.stop(); await flush();
});

test('recording-specific conflict backoff suppresses retries until its bounded deadline', async () => {
  const f = fixture(), leases = [];
  f.api.lease = async id => { leases.push(id); throw Object.assign(new Error('held'), { status: 409 }); };
  const controller = f.make('owner-one'); await controller.start();
  for (let i = 0; i < 3; i++) await controller.poll();
  assert.deepEqual(leases, ['recording-one']);
  f.advance(10000); await controller.poll();
  assert.deepEqual(leases, ['recording-one', 'recording-one']);
  controller.stop();
});

test('leases renew every ten seconds without changing the active generation', async () => {
  const f = fixture(), controller = f.make('owner-one'); await controller.start(); await flush();
  assert.deepEqual(f.timers.map(timer => timer.ms), [1000, 10000, 500]);
  const first = controller.getWorkState().lease;
  f.advance(10000); await controller.renewLease();
  assert.equal(controller.getWorkState().lease.generation, first.generation);
  assert.equal(controller.getWorkState().lease.expiresAt, first.expiresAt + 10000);
  f.jobs[0].resolve([]); await flush(); assert.equal(f.writes[0].generation, first.generation);
  controller.stop(); await flush();
});

test('a second tab cannot process until lease expiry and stale first-tab results cannot save', async () => {
  const f = fixture(), first = f.make('owner-one'), second = f.make('owner-two');
  await first.start(); await flush(); await second.start(); await flush();
  assert.equal(second.getState()[0].status, 'lease-held'); assert.equal(f.jobs.length, 1);
  f.advance(60001); await second.poll(); await flush();
  assert.equal(f.jobs.length, 2); assert.equal(second.getWorkState().lease.generation, 2);
  f.jobs[0].resolve([word('stale', 1, 2)]); await flush(); assert.equal(f.writes.length, 0);
  f.jobs[1].resolve([word('new owner', 1, 2)]); await flush(); assert.equal(f.writes[0].generation, 2);
  first.stop(); second.stop(); await flush();
});

test('renewal failure cancels only live work and preserves the persisted draft', async () => {
  const f = fixture(), controller = f.make('owner-one'); await controller.start(); await flush();
  const jobId = f.jobs[0].options.jobId;
  f.failLease(Object.assign(new Error('fenced'), { status: 409 })); await controller.renewLease(); await flush();
  assert.deepEqual(f.cancelled, [jobId]); assert.equal(controller.getState()[0].status, 'lease-held');
  assert.equal(f.writes.length, 0); assert.equal(controller.getWorkState().prepared, null);
  controller.stop();
});

test('independent watchdog releases expired ASR and prepared PCM while GET and renewal hang', async () => {
  const f = fixture({ clockStart: 1000000 }), controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start(); await flush();
  assert.equal(controller.getWorkState().lease.expiresAt, 1060000);
  const signals = [];
  f.api.recordings = signal => { signals.push(signal); return new Promise(() => {}); };
  f.api.lease = (id, owner, signal) => { signals.push(signal); return new Promise(() => {}); };
  const pendingGet = controller.poll(), pendingRenew = controller.renewLease();
  await flush(); assert.equal(signals.length, 2);
  const job = controller.getWorkState().active;
  f.advance(70001);
  f.timers.find(timer => timer.ms === 500).callback();
  await Promise.all([pendingGet, pendingRenew]); await flush();
  assert.deepEqual(f.cancelled, [job]);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(controller.getState()[0].status, 'lease-held');
  await controller.renewLease(); controller.stop();
});

test('lease expiry deadline cancels processing independently of poll and renewal guards', async () => {
  const f = fixture({ clockStart: 1000000 }), controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start(); await flush();
  f.api.recordings = () => new Promise(() => {});
  f.api.lease = () => new Promise(() => {});
  const pendingGet = controller.poll(), pendingRenew = controller.renewLease(); await flush();
  f.advance(60001); f.runDeadlines();
  await Promise.all([pendingGet, pendingRenew]); await flush();
  assert.equal(f.cancelled.length, 1);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.equal(f.writes.length, 0); controller.stop();
});

test('a renewal reply delivered after local expiry cannot revive the expired ASR operation', async () => {
  const f = fixture({ clockStart: 1000000 }), controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start(); await flush();
  let reply;
  f.api.lease = () => new Promise(resolve => { reply = resolve; });
  const pendingRenew = controller.renewLease(); await flush();
  f.advance(60001);
  // Deliver the server's extended expiry before the overdue timer callbacks.
  reply({ generation: 1, expiresAt: 1120, totalFrames: f.record.totalFrames, draft: null });
  await pendingRenew; await flush();
  assert.equal(f.cancelled.length, 1);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.equal(controller.getState()[0].status, 'lease-held'); controller.stop();
});

test('network deadlines settle uncooperative GET and renewal and allow subsequent recovery', async () => {
  const f = fixture(), controller = f.make('owner-one'); await controller.start(); await flush();
  const list = f.api.recordings, grant = f.api.lease, signals = [];
  let deliverStale;
  f.api.recordings = signal => { signals.push(signal); return new Promise(resolve => { deliverStale = resolve; }); };
  f.api.lease = (id, owner, signal) => { signals.push(signal); return new Promise(() => {}); };
  const pendingGet = controller.poll(), pendingRenew = controller.renewLease(); await flush();
  f.advance(8001); f.runDeadlines();
  await Promise.all([pendingGet, pendingRenew]); await flush();
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(controller.getState()[0].status, 'connection-error');
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  f.api.recordings = list; f.api.lease = grant;
  await controller.poll(); await flush(); assert.equal(f.jobs.length, 2);
  const active = controller.getWorkState().active;
  deliverStale({ recordings: [] }); await flush();
  assert.equal(controller.getWorkState().active, active);
  assert.equal(controller.getState().length, 1);
  controller.stop(); await flush();
});

test('final processing preempts active and prepared work; failure retains draft for recovery', async () => {
  const draft = mergeLiveWindow(empty(), { startFrame: 0, frameCount: 20 * RATE, words: [word('keep this', 1, 2)], modelRevision: 'r' });
  const f = fixture({ draft }), controller = f.make('owner-one'); await controller.start(); await flush();
  f.setBusy(true); controller.preempt(); await flush();
  assert.equal(controller.getState()[0].status, 'processing-busy');
  assert.equal(controller.getWorkState().active, null); assert.equal(controller.getWorkState().prepared, null);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.record.draft, draft);
  await controller.poll(); await flush(); assert.equal(f.jobs.length, 1);
  f.setBusy(false); await controller.poll(); await flush(); assert.equal(f.jobs.length, 2);
  assert.equal(f.reads.at(-2).startFrame, 15 * RATE);
  controller.stop(); await flush(); assert.equal(controller.getState()[0].status, 'paused-open-echo');
});

test('ambiguous draft acknowledgement reloads the durable cursor before retrying', async () => {
  const f = fixture(), controller = f.make('owner-one'); await controller.start(); await flush();
  f.failDraft(new Error('connection lost after durable save'));
  f.jobs[0].resolve([word('durable', 1, 2)]); await flush();
  assert.equal(controller.getState()[0].status, 'connection-error');
  assert.equal(f.record.draft.throughFrame, 20 * RATE);
  await controller.poll(); await flush();
  assert.equal(f.jobs.length, 2); assert.equal(f.jobs[1].audio.length, 20 * RATE);
  assert.equal(f.reads.at(-2).startFrame, 15 * RATE);
  f.jobs[1].resolve([word('next', 5, 6)]); await flush();
  assert.deepEqual(f.record.draft.words.map(word => word.text), ['durable', 'next']);
  controller.stop(); await flush();
});

test('completion preempts live inference while keeping the saved draft visible', async () => {
  const f = fixture(), controller = f.make('owner-one'); await controller.start(); await flush();
  f.record.status = 'complete'; await controller.poll(); await flush();
  assert.equal(controller.getState()[0].status, 'complete'); assert.equal(controller.getWorkState().active, null);
  assert.equal(f.writes.length, 0); controller.stop();
});

test('API enforces bounded same-origin PCM and protocol version without redirects', async () => {
  const calls = [];
  const api = createExtensionLiveApi(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/pcm?') ? new Response(new Uint8Array([0, 128, 255, 127])) : Response.json({ protocolVersion: 1, recordings: [] });
  });
  assert.deepEqual(await api.recordings(), { protocolVersion: 1, recordings: [] });
  const pcm = await api.pcm('recording/a', 0, 2);
  assert.deepEqual(Array.from(pcm), [-1, 32767 / 32768]);
  assert.ok(calls[1].url.startsWith('/api/extensions/recordings/recording%2Fa/pcm'));
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.credentials === 'same-origin'));
  await assert.rejects(api.pcm('one', 0, 20 * RATE + 1), /range/);
  await assert.rejects(createExtensionLiveApi(async () => Response.json({ protocolVersion: 2 })).recordings(), /unsupported/);
  await assert.rejects(createExtensionLiveApi(async () => new Response(new Uint8Array(1))).pcm('one', 0, 2), /length/);
});

test('actual live worker stays warm, loads no speaker models, and validates word alignment', async () => {
  const source = (await readFile(new URL('../web/inference-worker.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  const messages = [], operations = [], handlers = [];
  const model = { sessions: { decoder_model_merged: { outputNames: ['cross_attentions.0'] } } };
  let output = { text: 'hello', chunks: [word('hello', 1, 2)] };
  const transcriber = Object.assign(async (audio, options) => { operations.push({ operation: 'ASR', options }); return output; }, { model, dispose: async () => { operations.push({ operation: 'dispose' }); } });
  const context = {
    env: { backends: { onnx: { wasm: {} } } }, fetch: async () => { throw new Error('Unexpected network use'); }, navigator: {}, crossOriginIsolated: false,
    caches: { open: async () => ({ match: async () => undefined }) }, URL, Response,
    self: { addEventListener: (type, handler) => handlers.push(handler), postMessage: value => messages.push(value) },
    pipeline: async (task, checkpoint, options) => { operations.push({ operation: 'load', options }); return transcriber; },
    assertModel() {}, speechModelConfig: () => ({ checkpoint: 'turbo', revision: 'pinned', name: 'Turbo' }), assertWordTimestampSupport() {}, DEFAULT_SPEECH_MODEL: 'turbo',
    SPEAKER_MODELS: {}, MODEL_CACHE: 'files', MODEL_MANIFEST_CACHE: 'manifest', modelManifestUrl() {},
    wasmThreadCount: () => 1, correctWhisperAlignment() {}, validatedWhisperWords,
    AutoModelForAudioFrameClassification: { from_pretrained: () => { throw new Error('Speaker model must not load'); } },
    AutoModelForXVector: {}, AutoProcessor: {}, diarize: () => { throw new Error('Speaker recognition must not run'); }, speakerPassages() {},
    speechFailureMessage: error => error.message, traceSpeechChunks: () => { throw new Error('Warm worker tracing must not accumulate'); },
  };
  vm.runInNewContext(source, context);
  await handlers[0]({ data: { id: 'first', type: 'transcribe-live', modelId: 'turbo', audio: new Float32Array(20 * RATE) } });
  await handlers[0]({ data: { id: 'second', type: 'transcribe-live', modelId: 'turbo', audio: new Float32Array(20 * RATE) } });
  assert.equal(operations.filter(value => value.operation === 'load').length, 1);
  assert.equal(operations.filter(value => value.operation === 'dispose').length, 0);
  assert.equal(operations.find(value => value.operation === 'load').options.local_files_only, true);
  const results = messages.filter(message => message.type === 'result');
  assert.equal(results.length, 2); assert.deepEqual(results[1].result.words, [word('hello', 1, 2)]);
  assert.equal(results[1].result.modelRevision, 'pinned');
  output = { text: 'bad', chunks: [word('bad', 2, 1)] };
  await handlers[0]({ data: { id: 'invalid', type: 'transcribe-live', modelId: 'turbo', audio: new Float32Array(20 * RATE) } });
  assert.equal(messages.at(-1).type, 'error');
  assert.match(messages.at(-1).error, /invalid word timestamps/);
  assert.equal(operations.filter(value => value.operation === 'dispose').length, 1);
});
