import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const id = '00000000-0000-4000-8000-000000000001';
const library = '00000000-0000-4000-8000-000000000002';
const endpoint = 'http://127.0.0.1:3111';
const fakeSettings =
  'export async function readLink(){return structuredClone(link)};export async function connectedPair(){return link.state==="connected"?{endpoint:link.endpoint,libraryId:link.libraryId,credential:link.credential}:undefined};export async function saveLink(next){link=structuredClone(next)};export async function wasRevoked(){return revoked};export async function revokeCredential(){link={state:"none"};revoked=true}';
const fakeModules = {
  settings: fakeSettings,
  storage: 'export async function recording(id){return records.get(id)}',
  protocol:
    'export class ProtocolError extends Error{constructor(message,status=0){super(message);this.status=status}};globalThis.PE=ProtocolError;export async function jsonRequest(...args){return wire(...args)}',
};
const built = await build({
  entryPoints: ['extension/src/connection.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'api',
  plugins: [
    {
      name: 'trusted-controls',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(settings|storage|protocol)$/ }, (args) => ({
          path: args.path.slice(2),
          namespace: 'mock',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: fakeModules[args.path],
        }));
      },
    },
  ],
});
const companion = {
  libraryId: library,
  installationId: id,
  appVersion: '0.1.0',
  storageProtectionVersion: 1,
  recordingReceiptVersion: 1,
};
function harness() {
  const context = {
    structuredClone,
    AbortSignal,
    Map,
    Set,
    Array,
    Number,
    Promise,
    link: { state: 'connected', endpoint, libraryId: library, credential: 'synthetic-secret' },
    revoked: false,
    records: new Map([
      [
        id,
        {
          recordingId: id,
          libraryId: library,
          liveTranscription: true,
          chunkCount: 1,
          totalFrames: 16000,
        },
      ],
    ]),
    wire: async () => companion,
  };
  vm.runInNewContext(built.outputFiles[0].text, context);
  return {
    context,
    api: context.api,
    error: (status) => new context.PE('synthetic unavailable', status),
  };
}
test('connection status distinguishes connected, echo-offline and revoked without exposing credentials', async () => {
  const h = harness();
  h.context.wire = async (_endpoint, path, options, credential) => {
    assert.equal(path, '/connection');
    assert.ok(options.signal);
    assert.equal(credential, 'synthetic-secret');
    return companion;
  };
  assert.deepEqual({ ...(await h.api.connectionStatus()) }, { status: 'connected', endpoint });
  h.context.wire = async () => {
    throw h.error(0);
  };
  assert.equal((await h.api.connectionStatus()).status, 'echo-offline');
  h.context.wire = async () => {
    throw h.error(401);
  };
  const revoked = await h.api.connectionStatus();
  assert.equal(revoked.status, 'revoked');
  assert.equal(JSON.stringify(revoked).includes('synthetic-secret'), false);
});
test('waiting, none and revoked links report locally without contacting Echo', async () => {
  const h = harness();
  h.context.wire = async () => {
    throw new Error('no request expected');
  };
  h.context.link = { state: 'waiting', endpoint, requestId: id, claimSecret: 'a', expiresAt: 1 };
  assert.equal((await h.api.connectionStatus()).status, 'waiting');
  h.context.link = { state: 'none' };
  assert.equal((await h.api.connectionStatus()).status, 'none');
  h.context.revoked = true;
  assert.equal((await h.api.connectionStatus()).status, 'revoked');
});
test('an older or mismatched companion is never reported connected; local capture is untouched', async () => {
  const h = harness();
  h.context.wire = async () => ({ libraryId: library, installationId: id });
  assert.equal((await h.api.connectionStatus()).status, 'echo-offline');
  h.context.wire = async () => ({ ...companion, libraryId: id });
  assert.equal((await h.api.connectionStatus()).status, 'echo-offline');
  assert.equal(h.context.records.size, 1);
});
test('protected prerelease companions may carry build metadata', async () => {
  for (const appVersion of ['0.1.0-rc.1+build.7', '0.1.0+build.7', '0.1.0-rc.1']) {
    const h = harness();
    h.context.wire = async () => ({ ...companion, appVersion });
    assert.equal((await h.api.connectionStatus()).status, 'connected', appVersion);
  }
});
test('disconnect keeps the connection and audio when Echo cannot confirm revocation', async () => {
  const h = harness();
  h.context.wire = async () => {
    throw h.error(0);
  };
  await assert.rejects(h.api.disconnect(), /Open Echo to disconnect/);
  assert.equal(h.context.link.credential, 'synthetic-secret');
  assert.equal(h.context.records.size, 1);
});
test('a confirmed local disconnect forgets an unreachable Echo and keeps local audio', async () => {
  const h = harness();
  h.context.wire = async () => {
    throw h.error(0);
  };
  await h.api.disconnect(true);
  assert.equal(h.context.link.state, 'none');
  assert.equal(h.context.records.size, 1);
});
test('successful or previously revoked disconnect clears the link and preserves local audio', async () => {
  for (const alreadyRevoked of [false, true]) {
    const h = harness();
    h.context.wire = async (_endpoint, path, options) => {
      assert.equal(path, '/connection');
      assert.equal(options.method, 'DELETE');
      if (alreadyRevoked) throw h.error(401);
      return {};
    };
    await h.api.disconnect();
    assert.equal(h.context.link.state, 'none');
    assert.equal(h.context.records.size, 1);
  }
});
test('a status check that races a disconnect reports the new local state', async () => {
  const h = harness();
  h.context.wire = async () => {
    h.context.link = { state: 'none' };
    return companion;
  };
  assert.equal((await h.api.connectionStatus()).status, 'none');
});
test('live preview is scoped, Unicode bounded, and excludes draft/credentials/controls', async () => {
  const h = harness();
  h.context.wire = async (_endpoint, path) => {
    assert.equal(path, `/recordings/${id}/live`);
    return {
      recordingId: id,
      libraryId: library,
      status: 'live',
      preview: '🎙'.repeat(800),
      backlogSeconds: 2,
      provisional: true,
      draft: { words: ['private'] },
      credential: 'synthetic-secret',
      controls: [{ action: 'stop' }],
    };
  };
  const result = await h.api.livePreview(id);
  assert.equal(Array.from(result.preview).length, 600);
  assert.equal(result.provisional, true);
  assert.equal(result.draft, undefined);
  assert.equal(result.credential, undefined);
  assert.equal(result.controls, undefined);
  h.context.wire = async () => ({
    recordingId: id,
    libraryId: 'wrong-library',
    status: 'live',
    preview: 'private',
    backlogSeconds: 0,
    provisional: false,
  });
  assert.equal((await h.api.livePreview(id)).status, 'unavailable');
  assert.equal((await h.api.livePreview(id)).preview, '');
});
test('live preview preserves optional-off behavior and reports offline, pending ingest and revocation', async () => {
  const h = harness();
  for (const [code, status] of [
    [0, 'unavailable'],
    [404, 'waiting-audio'],
    [401, 'revoked'],
    [410, 'deleted'],
  ]) {
    h.context.wire = async () => {
      throw h.error(code);
    };
    assert.equal((await h.api.livePreview(id)).status, status);
  }
  h.context.records.get(id).liveTranscription = false;
  h.context.wire = async () => {
    throw new Error('optional off must not fetch');
  };
  assert.equal((await h.api.livePreview(id)).status, 'disabled');
  await assert.rejects(h.api.livePreview('../connection'), /Invalid recording/);
});
test('connection actions remain serialized across pairing/disconnect and recover from errors', async () => {
  const h = harness();
  const order = [];
  await Promise.all([
    h.api.connectionAction(async () => {
      order.push('first-start');
      await Promise.resolve();
      order.push('first-end');
    }),
    h.api.connectionAction(async () => {
      order.push('second');
    }),
  ]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  await assert.rejects(
    h.api.connectionAction(async () => {
      throw new Error('failed');
    }),
  );
  assert.equal(await h.api.connectionAction(async () => 42), 42);
});
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
function fakeElements(hidden) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        className: '',
        checked: false,
        disabled: false,
        hidden,
        value: '',
        listeners: {},
        append(...children) {
          this.textContent += children.filter((child) => typeof child === 'string').join('');
        },
        replaceChildren() {
          this.textContent = '';
        },
        contains() {
          return false;
        },
        setAttribute() {},
        addEventListener(name, callback) {
          this.listeners[name] = callback;
        },
      });
    return elements.get(id);
  };
  const document = {
    createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }),
    getElementById: () => null,
  };
  return { element, document };
}
async function load(entry, context, fakeUI, fakeStorage) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'page-under-test',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(ui|storage)$/ }, (args) => ({
            path: args.path.slice(2),
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path === 'ui' ? fakeUI : fakeStorage,
          }));
        },
      },
    ],
  });
  vm.runInNewContext(result.outputFiles[0].text, context);
  await settle();
}
const connected = { phase: 'connected', endpoint, revoked: false };
test('popup polls bounded live/connection status separately and renders exclusion without stopping capture', async () => {
  const { element, document } = fakeElements(false);
  const intervals = new Map();
  const calls = [];
  const context = {
    URL,
    element,
    document,
    navigator: {
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: { enumerateDevices: async () => [] },
    },
    chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 7, url: 'https://meet.google.com/abc-defg-hij' }] },
    },
    connection: 'echo-offline',
    view: connected,
    live: {
      recordingId: id,
      status: 'paused-open-echo',
      preview: 'Short draft',
      backlogSeconds: 4,
      provisional: true,
    },
    active: {
      recordingId: id,
      mic: 'Excluded · muted',
      micCaptured: true,
      micAvailable: true,
      micExcluded: false,
    },
    setInterval(callback, ms) {
      intervals.set(ms, callback);
    },
  };
  context.request = async (message) => {
    calls.push(message);
    if (message.type === 'CONNECTION_STATUS') return { status: context.connection };
    if (message.type === 'LIVE_PREVIEW') return context.live;
    if (message.type === 'MIC_EXCLUSION') {
      context.active.micExcluded = message.excluded;
      return {};
    }
    return {
      connection: context.view,
      settings: {
        enabledProviders: ['meet'],
        micGranted: true,
        rememberedConsent: [],
        liveTranscription: false,
      },
      active: context.active,
      recordings: [{ recordingId: id, liveTranscription: true, totalFrames: 16000 }],
    };
  };
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=e=>{throw e};export const action=async fn=>fn();export const renderRecordings=()=>{};export const lockedNotice=()=>{};export const duration=()=>"00:01"';
  await load('extension/src/popup.ts', context, fakeUI, '');
  intervals.get(5000)();
  await settle();
  assert.match(element('connection').textContent, /Echo is offline/);
  assert.equal(element('connection-card').hidden, true);
  assert.match(element('live-status').textContent, /paused · open Echo/);
  assert.equal(element('live-preview').textContent, 'Short draft');
  assert.equal(element('live-panel').hidden, false);
  assert.equal(element('mic-exclusion-field').hidden, false);
  element('mic-exclusion').checked = true;
  element('mic-exclusion').listeners.change();
  await settle();
  assert.ok(
    calls.some(
      (message) =>
        message.type === 'MIC_EXCLUSION' && message.recordingId === id && message.excluded,
    ),
  );
  assert.equal(
    calls.some((message) => message.type === 'CONTROL'),
    false,
  );
  context.view = { phase: 'none', revoked: true };
  context.live = {
    ...context.live,
    status: 'final-transcript-needed',
    preview: '',
    provisional: false,
  };
  intervals.get(1000)();
  intervals.get(5000)();
  await settle();
  assert.match(element('connection').textContent, /Echo disconnected this browser/);
  assert.equal(element('connection-card').hidden, false);
  assert.equal(element('connect').textContent, 'Connect again');
  assert.equal(element('active-panel').hidden, false);
  assert.match(element('live-status').textContent, /open Echo to create final transcript/);
  assert.equal(element('live-provisional').hidden, true);
});
test('popup connect shows waiting, then the not-found message with Retry, never blocking Start', async () => {
  const { element, document } = fakeElements(false);
  const intervals = new Map();
  let found = true;
  const context = {
    URL,
    element,
    document,
    navigator: {
      permissions: { query: async () => ({ state: 'denied' }) },
      mediaDevices: { enumerateDevices: async () => [] },
    },
    chrome: {
      permissions: { contains: async () => true },
      tabs: { query: async () => [{ id: 7, url: 'https://meet.google.com/abc-defg-hij' }] },
    },
    setInterval(callback, ms) {
      intervals.set(ms, callback);
    },
    view: { phase: 'none', revoked: false },
  };
  context.request = async (message) => {
    if (message.type === 'PAIR_BEGIN') {
      if (!found)
        throw new Error("Echo isn't running on this Mac — start it with ./scripts/start.sh");
      context.view = { phase: 'waiting', endpoint, requestId: id, revoked: false };
      return context.view;
    }
    if (message.type === 'PAIR_CANCEL') {
      context.view = { phase: 'none', notice: 'Connection cancelled.', revoked: false };
      return context.view;
    }
    if (message.type === 'CONNECTION_STATUS') return { status: context.view.phase };
    return {
      connection: context.view,
      settings: {
        enabledProviders: ['meet'],
        micGranted: false,
        rememberedConsent: [],
        liveTranscription: false,
      },
      active: null,
      recordings: [],
    };
  };
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=e=>{throw e};export const action=async fn=>fn();export const renderRecordings=()=>{};export const lockedNotice=()=>{};export const duration=()=>"00:01"';
  await load('extension/src/popup.ts', context, fakeUI, '');
  assert.equal(element('connection-title').textContent, 'Connect to Echo');
  assert.match(element('connection-detail').textContent, /saved in this browser until you connect/);
  element('consent').checked = true;
  element('consent').listeners.change();
  assert.equal(element('start').disabled, false);
  element('connect').listeners.click();
  await settle();
  assert.equal(element('connection-title').textContent, 'Click Allow in the Echo tab');
  assert.equal(element('connect').hidden, true);
  assert.equal(element('show-echo').hidden, false);
  assert.equal(element('start').disabled, false);
  element('cancel-connect').listeners.click();
  await settle();
  assert.equal(element('connection-detail').textContent, 'Connection cancelled.');
  found = false;
  element('connect').listeners.click();
  await settle();
  assert.match(element('connection-detail').textContent, /isn't running on this Mac/);
  assert.equal(element('connect').textContent, 'Retry');
});
test('setup disconnect warns about pending audio, honors cancel and keeps the link when Echo is offline', async () => {
  const { element, document } = fakeElements(true);
  let confirm = false;
  let forget = false;
  let warning = '';
  let offline = true;
  let paired = true;
  const calls = [];
  const errors = [];
  const context = {
    URL,
    URLSearchParams,
    location: { hash: '' },
    element,
    document,
    navigator: { permissions: { query: async () => ({ state: 'denied' }) } },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      permissions: { contains: async () => false },
    },
    window: {
      confirm(message) {
        if (/did not respond/.test(message)) return forget;
        warning = message;
        return confirm;
      },
      addEventListener() {},
    },
    console: { warn() {} },
    setInterval() {},
  };
  context.request = async (message) => {
    calls.push(message);
    if (message.type === 'CONNECTION_STATUS') return { status: paired ? 'echo-offline' : 'none' };
    if (message.type === 'DISCONNECT') {
      if (message.forgetLocally) {
        paired = false;
        return {};
      }
      if (offline)
        throw new Error('Open Echo to disconnect this browser. Recordings stay saved here.');
      paired = false;
      return {};
    }
    return {
      connection: paired ? connected : { phase: 'none', revoked: false },
      settings: { enabledProviders: [], micGranted: false },
      recordings: [{ recordingId: id, libraryId: library, chunkCount: 1 }],
      active: null,
    };
  };
  context.showError = (error) => errors.push(error.message);
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=globalThis.showError;export async function action(fn){try{await fn()}catch(error){showError(error)}};export const renderRecordings=()=>{};export const lockedNotice=()=>{}';
  await load(
    'extension/src/setup.ts',
    context,
    fakeUI,
    'export async function* exportParts(){};export async function recording(){}',
  );
  assert.match(element('connection').textContent, /Echo is offline/);
  element('disconnect').listeners.click();
  assert.match(warning, /1 recording still need to upload/);
  assert.match(warning, /stay saved in this browser/);
  assert.equal(
    calls.some((message) => message.type === 'DISCONNECT'),
    false,
  );
  confirm = true;
  element('disconnect').listeners.click();
  await settle();
  assert.match(errors.at(-1), /Open Echo to disconnect/);
  assert.equal(element('disconnect').hidden, false);
  assert.equal(element('status').textContent, '');
  assert.equal(
    calls.some((message) => message.forgetLocally),
    false,
    'declining the local-only forget keeps the link',
  );
  forget = true;
  element('disconnect').listeners.click();
  await settle();
  assert.ok(calls.some((message) => message.type === 'DISCONNECT' && message.forgetLocally));
  assert.match(element('status').textContent, /Disconnected/);
  paired = true;
  element('status').textContent = '';
  offline = false;
  element('disconnect').listeners.click();
  await settle();
  assert.equal(element('disconnect').hidden, true);
  assert.match(element('status').textContent, /Disconnected/);
  assert.match(element('connection').textContent, /Not connected/);
});
test('AudioWorklet exclusion persists across provider gates and inclusion requires a new positive gate', async () => {
  const result = await build({
    entryPoints: ['extension/src/worklet.ts'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  let Processor;
  const sent = [];
  class Base {
    port = { onmessage: null, postMessage: (message) => sent.push(message) };
  }
  const context = {
    AudioWorkletProcessor: Base,
    registerProcessor: (_name, type) => {
      Processor = type;
    },
    sampleRate: 16000,
    currentTime: 0,
    Date: { now: () => 1000 },
    Float32Array,
    Int16Array,
    ArrayBuffer,
    DataView,
    Number,
    Math,
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  const processor = new Processor({ processorOptions: { recordingId: id } });
  let revision = 0;
  let exclusionRevision = 0;
  const message = (data) => processor.port.onmessage({ data });
  const gate = (allowed) =>
    message({
      type: 'gate',
      recordingId: id,
      gateRevision: ++revision,
      allowed,
      ttlMs: 2000,
      expiresAt: 3000,
    });
  const exclude = (excluded) =>
    message({
      type: 'exclude-mic',
      recordingId: id,
      exclusionRevision: ++exclusionRevision,
      excluded,
    });
  const pcm = () => {
    processor.process(
      [[new Float32Array(128)], [new Float32Array(128).fill(1)]],
      [[new Float32Array(128)]],
    );
    message({ type: 'pause', requestId: 'flush' });
    const chunk = sent.splice(0).find((item) => item.type === 'pcm');
    message({ type: 'resume' });
    return [...new Int16Array(chunk.pcm)].slice(1);
  };
  gate(true);
  assert.ok(pcm().some((value) => value > 0));
  exclude(true);
  gate(true);
  assert.ok(pcm().every((value) => value === 0));
  exclude(false);
  assert.ok(pcm().every((value) => value === 0));
  gate(false);
  assert.ok(pcm().every((value) => value === 0));
  gate(true);
  assert.ok(pcm().some((value) => value > 0));
  message({
    type: 'exclude-mic',
    recordingId: 'different-recording',
    exclusionRevision: 999,
    excluded: true,
  });
  gate(true);
  assert.ok(pcm().some((value) => value > 0));
  message({ type: 'exclude-mic', recordingId: id, exclusionRevision: 1, excluded: true });
  gate(true);
  assert.ok(pcm().some((value) => value > 0));
});
test('a local deletion winning a pending transfer status update does not abort other recordings; storage failures still propagate', async () => {
  const fakeStorage =
    'export async function allRecordings(){return [...records.values()]};export async function recording(id){return records.get(id)};export async function updateRecording(id,patch){if(deleteOnUpdate===id){records.delete(id);deleteOnUpdate=null}if(storageFailure)throw new Error("disk write failed");const row=records.get(id);if(!row)throw new Error("Recording not found");const next={...row,...patch};records.set(id,next);return next};export async function getChunk(){return {frames:1,pcm:new ArrayBuffer(2),sha256:"a".repeat(64)}};export async function retainReceiptAndRemovePCM(id,receipt){records.set(id,{...records.get(id),receipt})}';
  const result = await build({
    entryPoints: ['extension/src/protocol.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'api',
    plugins: [
      {
        name: 'transfer-delete-race',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(storage|settings)$/ }, (args) => ({
            path: args.path.slice(2),
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path === 'storage' ? fakeStorage : fakeSettings,
          }));
        },
      },
    ],
  });
  const newer = {
    recordingId: 'deleted',
    libraryId: library,
    chunkCount: 1,
    totalFrames: 1,
    captureState: 'stopped',
    createdAt: '2026-01-01',
    gaps: [],
  };
  const older = { ...newer, recordingId: 'remaining', createdAt: '2025-01-01' };
  let uploaded = false;
  let complete = false;
  const context = {
    URL,
    Headers,
    Response,
    AbortSignal,
    Date,
    Promise,
    Map,
    ArrayBuffer,
    records: new Map([
      [newer.recordingId, newer],
      [older.recordingId, older],
    ]),
    deleteOnUpdate: newer.recordingId,
    storageFailure: false,
    structuredClone,
    link: { state: 'connected', endpoint, libraryId: library, credential: 'synthetic' },
    navigator: { locks: { request: async (_name, _options, work) => work() } },
    fetch: async (url) => {
      if (url.includes('/chunks/')) uploaded = true;
      if (url.endsWith('/complete')) complete = true;
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          appVersion: '0.1.0',
          storageProtectionVersion: 1,
          recordingReceiptVersion: 1,
          recordingId: older.recordingId,
          libraryId: library,
          meetingId: id,
          status: complete ? 'complete' : 'receiving',
          nextSequence: uploaded ? 1 : 0,
          totalFrames: uploaded ? 1 : 0,
        }),
      );
    },
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  await context.api.transferPending(
    async () => {},
    () => {},
  );
  assert.ok(context.records.get(older.recordingId).receipt);
  assert.equal(context.records.has(newer.recordingId), false);
  context.records.set(newer.recordingId, newer);
  context.storageFailure = true;
  await assert.rejects(
    context.api.transferPending(
      async () => {},
      () => {},
    ),
    /disk write failed/,
  );
});
