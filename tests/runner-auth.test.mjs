import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerSession, runnerInput, screenPoint } from '../web/runner-auth.js';

const id = '7c82d010-8656-4e85-a58a-b74622f5d6a9';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('screen coordinates follow resized and scrolled image bounds, including edge pixels', () => {
  assert.deepEqual(screenPoint(170, 245, { left: 10, top: 20, width: 320, height: 450 }), { x: 640, y: 450 });
  assert.deepEqual(screenPoint(20, 50, { left: -620, top: -400, width: 1280, height: 900 }), { x: 640, y: 450 });
  assert.deepEqual(screenPoint(330, 470, { left: 10, top: 20, width: 320, height: 450 }), { x: 1279, y: 899 });
  assert.throws(() => screenPoint(0, 0, { left: 10, top: 20, width: 320, height: 450 }));
  assert.throws(() => screenPoint(0, 0, { left: 0, top: 0, width: 0, height: 450 }));
});

test('input permits Unicode and navigation but strips unrelated fields and rejects unsafe keys/bounds', () => {
  assert.deepEqual(runnerInput({ type: 'text', text: 'हेलो 😄', email: 'ignored' }), { type: 'text', text: 'हेलो 😄' });
  assert.deepEqual(runnerInput({ type: 'key', key: 'Shift+Tab' }), { type: 'key', key: 'Shift+Tab' });
  assert.deepEqual(runnerInput({ type: 'scroll', deltaY: 9e4 }), { type: 'scroll', deltaY: 900 });
  for (const input of [{ type: 'key', key: 'Control+L' }, { type: 'text', text: 'x'.repeat(4097) }, { type: 'text', text: '😄'.repeat(1025) }, { type: 'text', text: '\n' }, { type: 'text', text: '\0' }, { type: 'click', x: 1280, y: 1 }, { type: 'scroll', deltaY: NaN }]) assert.throws(() => runnerInput(input));
});

test('inputs remain ordered without retries and Save waits for all pending input', async () => {
  const first = deferred(), calls = [];
  const session = createRunnerSession(id, { fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body) });
    if (calls.length === 1) await first.promise;
    return json({ state: path.endsWith('/finish') ? 'signed_in' : 'signing_in' });
  } });
  const typing = session.input({ type: 'text', text: 'secret' });
  const enter = session.input({ type: 'key', key: 'Enter' });
  const finish = session.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  first.resolve(); await Promise.all([typing, enter, finish]);
  assert.deepEqual(calls.map(call => call.path.split('/').at(-1)), ['input', 'input', 'finish']);
  assert.ok(calls.every(call => call.body.sessionId === id));
  session.dispose();
});

test('screenshot polling shares an in-flight request and validates image/hostname metadata', async () => {
  const pending = deferred(); let calls = 0;
  const session = createRunnerSession(id, { fetchImpl: async () => { calls++; await pending.promise; return new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg', 'X-Runner-Hostname': 'accounts.google.com' } }); } });
  const a = session.screen(), b = session.screen(); assert.equal(a, b); assert.equal(calls, 1);
  pending.resolve(); const screen = await a;
  assert.equal(screen.hostname, 'accounts.google.com'); assert.equal(await screen.blob.text(), 'jpeg');
  session.dispose();
});

test('cancel aborts screen and pending input, then sends exact session cancellation independently', async () => {
  const calls = [], session = createRunnerSession(id, { fetchImpl: (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/cancel')) return Promise.resolve(json({ state: 'signed_out' }));
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  } });
  const screen = session.screen().catch(error => error.name);
  const typing = session.input({ type: 'text', text: 'secret' }).catch(error => error.name);
  const queued = session.input({ type: 'key', key: 'Enter' }).catch(error => error.message);
  await new Promise(resolve => setImmediate(resolve));
  await session.cancel();
  assert.equal(await screen, 'AbortError'); assert.equal(await typing, 'AbortError'); assert.match(await queued, /closing/);
  const cancel = calls.at(-1); assert.match(cancel.path, /\/cancel$/); assert.deepEqual(JSON.parse(cancel.init.body), { sessionId: id }); assert.equal(cancel.init.signal.aborted, false);
  await assert.rejects(session.input({ type: 'key', key: 'Enter' }), /closing/);
});

test('failed cancellation can be retried without replaying credentials', async () => {
  let calls = 0;
  const session = createRunnerSession(id, { fetchImpl: async () => { if (++calls === 1) throw new Error('offline'); return json({ state: 'signed_out' }); } });
  await assert.rejects(session.cancel(), /offline/); await session.cancel(); assert.equal(calls, 2);
});

test('bounded requests time out and pagehide uses a keepalive exact-ID cancel', async () => {
  const calls = [];
  const session = createRunnerSession(id, { timeoutMs: 10, fetchImpl: (path, init) => {
    calls.push({ path, init });
    if (init.keepalive) return Promise.resolve(json({ state: 'signed_out' }));
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }));
  } });
  await assert.rejects(session.screen(), /too long/);
  session.pagehide(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).init.keepalive, true); assert.deepEqual(JSON.parse(calls.at(-1).init.body), { sessionId: id });
});

test('invalid session IDs cannot be sent to the runner', () => {
  for (const value of [undefined, '../other', 'secret', '']) assert.throws(() => createRunnerSession(value));
});

test('reserved identity can be cancelled before startup or screenshot completes', async () => {
  const calls = [];
  const session = createRunnerSession(id, { fetchImpl: async (path, init) => { calls.push({ path, body: JSON.parse(init.body) }); return json({ state: 'signed_out' }); } });
  await session.cancel();
  assert.equal(calls.length, 1); assert.match(calls[0].path, /\/cancel$/); assert.deepEqual(calls[0].body, { sessionId: id });
});

test('ended-screen errors retain HTTP status and session recovery reads status without credential data', async () => {
  const calls = [];
  const session = createRunnerSession(id, { fetchImpl: async (path, init) => {
    calls.push({ path, init });
    if (path.includes('/screen?')) return new Response(JSON.stringify({ error: 'Session ended.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    return json({ state: 'expired', detail: 'Sign in again.' });
  } });
  await assert.rejects(session.screen(), error => error.status === 409 && error.message === 'Session ended.');
  assert.equal((await session.status()).state, 'expired');
  assert.equal(calls[1].init.method, 'GET'); assert.equal(calls[1].init.body, undefined);
  session.dispose();
});

test('cancel and pagehide wait beyond ordinary requests but remain bounded at forty seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const session = createRunnerSession(id, { fetchImpl: (path, init) => {
    signals.push(init.signal);
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true }));
  } });
  const cancel = session.cancel();
  const rejection = assert.rejects(cancel, /too long/);
  context.mock.timers.tick(15_001);
  assert.equal(signals[0].aborted, false);
  context.mock.timers.tick(24_999);
  assert.equal(signals[0].aborted, true);
  await rejection;
  session.pagehide();
  context.mock.timers.tick(35_001);
  assert.equal(signals[1].aborted, false);
  context.mock.timers.tick(4_999);
  assert.equal(signals[1].aborted, true);
  await new Promise(resolve => setImmediate(resolve));
});
