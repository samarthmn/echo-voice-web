import type * as ConnectionModule from '../../extension/src/connection.ts';
import type * as ProtocolModule from '../../extension/src/protocol.ts';
import { bytes } from '../helpers/assertions.ts';
import type { TestElement } from '../helpers/elements.ts';
import { connectedLink } from '../helpers/assertions.ts';
import { moduleExports, object } from '../helpers/assertions.ts';
import type { Link } from '../../extension/src/settings.ts';
import type { WorkletConstructor } from '../helpers/worklet.ts';
import { text } from '../helpers/assertions.ts';
import { array } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const id = '00000000-0000-4000-8000-000000000001';
const library = '00000000-0000-4000-8000-000000000002';
const endpoint = 'http://127.0.0.1:3111';
const fakeSettings =
  'export async function readLink(){return structuredClone(link)};export async function connectedPair(){return link.state==="connected"?{endpoint:link.endpoint,libraryId:link.libraryId,credential:link.credential}:undefined};export async function saveLink(next){link=structuredClone(next)};export async function wasRevoked(){return revoked};export async function revokeCredential(){link={state:"none"};revoked=true}';
const fakeModules: Record<string, string> = {
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
        builder.onResolve({ filter: /^\.\/(settings|storage|protocol)(?:\.ts)?$/ }, (args) => ({
          path: args.path.slice(2).replace(/\.ts$/, ''),
          namespace: 'mock',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: defined(fakeModules[args.path]),
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
    link: {
      state: 'connected',
      endpoint,
      libraryId: library,
      credential: 'synthetic-secret',
    } as Link,
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
    wire: (async () => companion) as (
      endpoint: unknown,
      path: unknown,
      options: { signal?: AbortSignal; method?: string },
      credential?: unknown,
    ) => Promise<unknown>,
  };
  vm.runInNewContext(defined(built.outputFiles[0]).text, context);
  return {
    context,
    api: moduleExports<typeof ConnectionModule>(Reflect.get(context, 'api'), [
      'connectionAction',
      'connectionStatus',
      'disconnect',
      'livePreview',
    ]),
    error: (status: number) =>
      new (moduleExports<Pick<typeof ProtocolModule, 'ProtocolError'>>(
        { ProtocolError: Reflect.get(context, 'PE') as unknown },
        ['ProtocolError'],
      ).ProtocolError)('synthetic unavailable', status),
  };
}
void test('connection status distinguishes connected, echo-offline and revoked without exposing credentials', async () => {
  const h = harness();
  h.context.wire = async (
    _endpoint: unknown,
    path: unknown,
    options: { signal?: AbortSignal },
    credential: unknown,
  ) => {
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
void test('waiting, none and revoked links report locally without contacting Echo', async () => {
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
void test('an older or mismatched companion is never reported connected; local capture is untouched', async () => {
  const h = harness();
  h.context.wire = async () => ({ libraryId: library, installationId: id });
  assert.equal((await h.api.connectionStatus()).status, 'echo-offline');
  h.context.wire = async () => ({ ...companion, libraryId: id });
  assert.equal((await h.api.connectionStatus()).status, 'echo-offline');
  assert.equal(h.context.records.size, 1);
});
void test('protected prerelease companions may carry build metadata', async () => {
  for (const appVersion of ['0.1.0-rc.1+build.7', '0.1.0+build.7', '0.1.0-rc.1']) {
    const h = harness();
    h.context.wire = async () => ({ ...companion, appVersion });
    assert.equal((await h.api.connectionStatus()).status, 'connected', appVersion);
  }
});
void test('disconnect keeps the connection and audio when Echo cannot confirm revocation', async () => {
  const h = harness();
  h.context.wire = async () => {
    throw h.error(0);
  };
  await assert.rejects(h.api.disconnect(), /Open Echo to disconnect/);
  assert.equal(connectedLink(h.context.link).credential, 'synthetic-secret');
  assert.equal(h.context.records.size, 1);
});
void test('a confirmed local disconnect forgets an unreachable Echo and keeps local audio', async () => {
  const h = harness();
  h.context.wire = async () => {
    throw h.error(0);
  };
  await h.api.disconnect(true);
  assert.equal(h.context.link.state, 'none');
  assert.equal(h.context.records.size, 1);
});
void test('successful or previously revoked disconnect clears the link and preserves local audio', async () => {
  for (const alreadyRevoked of [false, true]) {
    const h = harness();
    h.context.wire = async (_endpoint: unknown, path: unknown, options: { method?: string }) => {
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
void test('a status check that races a disconnect reports the new local state', async () => {
  const h = harness();
  h.context.wire = async () => {
    h.context.link = { state: 'none' };
    return companion;
  };
  assert.equal((await h.api.connectionStatus()).status, 'none');
});
void test('live preview is scoped, Unicode bounded, and excludes draft/credentials/controls', async () => {
  const h = harness();
  h.context.wire = async (_endpoint: unknown, path: unknown) => {
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
  assert.equal(object(result)['draft'], undefined);
  assert.equal(object(result)['credential'], undefined);
  assert.equal(object(result)['controls'], undefined);
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
void test('live preview preserves optional-off behavior and reports offline, pending ingest and revocation', async () => {
  const h = harness();
  for (const [code, status] of [
    [0, 'unavailable'],
    [404, 'waiting-audio'],
    [401, 'revoked'],
    [410, 'deleted'],
  ] satisfies [number, string][]) {
    h.context.wire = async () => {
      throw h.error(defined(code));
    };
    assert.equal((await h.api.livePreview(id)).status, status);
  }
  defined(h.context.records.get(id)).liveTranscription = false;
  h.context.wire = async () => {
    throw new Error('optional off must not fetch');
  };
  assert.equal((await h.api.livePreview(id)).status, 'disabled');
  await assert.rejects(h.api.livePreview('../connection'), /Invalid recording/);
});
void test('connection actions remain serialized across pairing/disconnect and recover from errors', async () => {
  const h = harness();
  const order: unknown = [];
  await Promise.all([
    h.api.connectionAction(async () => {
      array(order).push('first-start');
      await Promise.resolve();
      array(order).push('first-end');
    }),
    h.api.connectionAction(async () => {
      array(order).push('second');
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
function fakeElements(hidden: boolean) {
  const elements = new Map<string, TestElement>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        className: '',
        checked: false,
        disabled: false,
        hidden,
        value: '',
        listeners: {},
        append(...children: unknown[]) {
          this.textContent += children.filter((child) => typeof child === 'string').join('');
        },
        replaceChildren() {
          this.textContent = '';
        },
        contains() {
          return false;
        },
        setAttribute() {},
        addEventListener(name: string, callback: () => unknown) {
          defined(this.listeners)[name] = callback;
        },
      });
    return defined(elements.get(id));
  };
  const document = {
    createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }),
    getElementById: () => null,
  };
  return { element, document };
}
async function load(
  entry: string,
  context: number | vm.Context | undefined,
  fakeUI: string | Uint8Array,
  fakeStorage: string | Uint8Array,
) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'page-under-test',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(ui|storage)(?:\.ts)?$/ }, (args) => ({
            path: args.path.slice(2).replace(/\.ts$/, ''),
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path === 'ui' ? fakeUI : fakeStorage,
          }));
        },
      },
    ],
  });
  vm.runInNewContext(defined(result.outputFiles[0]).text, context);
  await settle();
}
const connected: {
  phase: string;
  endpoint?: string;
  revoked: boolean;
  requestId?: string;
  notice?: string;
} = { phase: 'connected', endpoint, revoked: false };
void test('popup polls bounded live/connection status separately and renders exclusion without stopping capture', async () => {
  const { element, document } = fakeElements(false);
  const intervals = new Map<number, () => void>();
  const calls: unknown[] = [];
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
    setInterval(callback: () => void, ms: number) {
      intervals.set(ms, callback);
    },
  };
  Object.assign(context, {
    request: async (message: { type: string; excluded: boolean }) => {
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
    },
  });
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=e=>{throw e};export const action=async fn=>fn();export const renderRecordings=()=>{};export const duration=()=>"00:01"';
  await load('extension/src/popup.ts', context, fakeUI, '');
  defined(defined(intervals.get(5000)))();
  await settle();
  assert.match(element('connection').textContent, /Echo is offline/);
  assert.equal(element('connection-card').hidden, true);
  assert.match(element('live-status').textContent, /paused · open Echo/);
  assert.equal(element('live-preview').textContent, 'Short draft');
  assert.equal(element('live-panel').hidden, false);
  assert.equal(element('mic-exclusion-field').hidden, false);
  element('mic-exclusion').checked = true;
  defined(defined(element('mic-exclusion').listeners)['change'])();
  await settle();
  assert.ok(
    calls.some(
      (message) =>
        object(message)['type'] === 'MIC_EXCLUSION' &&
        object(message)['recordingId'] === id &&
        object(message)['excluded'],
    ),
  );
  assert.equal(
    calls.some((message) => object(message)['type'] === 'CONTROL'),
    false,
  );
  context.view = { phase: 'none', revoked: true };
  context.live = {
    ...context.live,
    status: 'final-transcript-needed',
    preview: '',
    provisional: false,
  };
  defined(defined(intervals.get(1000)))();
  defined(defined(intervals.get(5000)))();
  await settle();
  assert.match(element('connection').textContent, /Echo disconnected this browser/);
  assert.equal(element('connection-card').hidden, false);
  assert.equal(element('connect').textContent, 'Connect again');
  assert.equal(element('active-panel').hidden, false);
  assert.match(element('live-status').textContent, /open Echo to create final transcript/);
  assert.equal(element('live-provisional').hidden, true);
});
void test('popup connect shows waiting, then the not-found message with Retry, never blocking Start', async () => {
  const { element, document } = fakeElements(false);
  const intervals = new Map<number, () => void>();
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
    setInterval(callback: () => void, ms: number) {
      intervals.set(ms, callback);
    },
    view: { phase: 'none', revoked: false } as typeof connected,
  };
  Object.assign(context, {
    request: async (message: { type: string }) => {
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
    },
  });
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=e=>{throw e};export const action=async fn=>fn();export const renderRecordings=()=>{};export const duration=()=>"00:01"';
  await load('extension/src/popup.ts', context, fakeUI, '');
  assert.equal(element('connection-title').textContent, 'Connect to Echo');
  assert.match(element('connection-detail').textContent, /saved in this browser until you connect/);
  element('consent').checked = true;
  defined(defined(element('consent').listeners)['change'])();
  assert.equal(element('start').disabled, false);
  defined(defined(element('connect').listeners)['click'])();
  await settle();
  assert.equal(element('connection-title').textContent, 'Click Allow in the Echo tab');
  assert.equal(element('connect').hidden, true);
  assert.equal(element('show-echo').hidden, false);
  assert.equal(element('start').disabled, false);
  defined(defined(element('cancel-connect').listeners)['click'])();
  await settle();
  assert.equal(element('connection-detail').textContent, 'Connection cancelled.');
  found = false;
  defined(defined(element('connect').listeners)['click'])();
  await settle();
  assert.match(element('connection-detail').textContent, /isn't running on this Mac/);
  assert.equal(element('connect').textContent, 'Retry');
});
void test('setup disconnect warns about pending audio, honors cancel and keeps the link when Echo is offline', async () => {
  const { element, document } = fakeElements(true);
  let confirm = false;
  let forget = false;
  let warning = '';
  let offline = true;
  let paired = true;
  let pending: { id: string; endpoint: string; previous: string } | undefined = {
    id: 'request',
    endpoint: 'http://localhost:3222',
    previous: endpoint,
  };
  const calls: unknown[] = [];
  const errors: string[] = [];
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
      confirm(message: string) {
        if (message.includes('did not respond')) return forget;
        warning = message;
        return confirm;
      },
      addEventListener() {},
    },
    console: { warn() {} },
    setInterval() {},
  };
  Object.assign(context, {
    request: async (message: { type: string; id: unknown; forgetLocally: unknown }) => {
      calls.push(message);
      if (message.type === 'CONNECTION_STATUS') return { status: paired ? 'echo-offline' : 'none' };
      if (message.type === 'CONNECT_REQUEST') return pending;
      if (message.type === 'CONNECT_CONFIRM') {
        assert.equal(message.id, defined(pending).id);
        pending = undefined;
        return {};
      }
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
    },
  });
  Object.assign(context, {
    showError: (error: { message: unknown }) => errors.push(text(error.message)),
  });
  const fakeUI =
    'export const element=globalThis.element;export const request=globalThis.request;export const showError=globalThis.showError;export async function action(fn){try{await fn()}catch(error){showError(error)}};export const renderRecordings=()=>{}';
  await load(
    'extension/src/setup.ts',
    context,
    fakeUI,
    'export async function* exportParts(){};export async function recording(){}',
  );
  assert.match(element('connection').textContent, /Echo is offline/);
  assert.equal(
    element('connect-confirmation-title').textContent,
    'Connect this browser to Echo at localhost:3222?',
  );
  assert.equal(
    element('connect-replacement').textContent,
    'This replaces your connection to 127.0.0.1:3111.',
  );
  defined(defined(element('confirm-connect').listeners)['click'])();
  await settle();
  assert.ok(calls.some((message) => object(message)['type'] === 'CONNECT_CONFIRM'));
  defined(defined(element('disconnect').listeners)['click'])();
  assert.match(warning, /1 recording still need to upload/);
  assert.match(warning, /stay saved in this browser/);
  assert.equal(
    calls.some((message) => object(message)['type'] === 'DISCONNECT'),
    false,
  );
  confirm = true;
  defined(defined(element('disconnect').listeners)['click'])();
  await settle();
  assert.match(defined(errors.at(-1)), /Open Echo to disconnect/);
  assert.equal(element('disconnect').hidden, false);
  assert.equal(element('status').textContent, '');
  assert.equal(
    calls.some((message) => object(message)['forgetLocally']),
    false,
    'declining the local-only forget keeps the link',
  );
  forget = true;
  defined(defined(element('disconnect').listeners)['click'])();
  await settle();
  assert.ok(
    calls.some(
      (message) => object(message)['type'] === 'DISCONNECT' && object(message)['forgetLocally'],
    ),
  );
  assert.match(element('status').textContent, /Disconnected/);
  paired = true;
  element('status').textContent = '';
  offline = false;
  defined(defined(element('disconnect').listeners)['click'])();
  await settle();
  assert.equal(element('disconnect').hidden, true);
  assert.match(element('status').textContent, /Disconnected/);
  assert.match(element('connection').textContent, /Not connected/);
});
void test('AudioWorklet exclusion persists across provider gates and inclusion requires a new positive gate', async () => {
  const result = await build({
    entryPoints: ['extension/src/worklet.ts'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  let Processor: WorkletConstructor | undefined;
  const sent: unknown[] = [];
  class Base {
    port = { onmessage: null, postMessage: (message: unknown) => sent.push(message) };
  }
  const context = {
    AudioWorkletProcessor: Base,
    registerProcessor: (_name: string, type: WorkletConstructor) => {
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
  vm.runInNewContext(defined(result.outputFiles[0]).text, context);
  const processor = new (defined(Processor))({ processorOptions: { recordingId: id } });
  let revision = 0;
  let exclusionRevision = 0;
  const message = (data: {
    type: string;
    recordingId?: string;
    gateRevision?: number;
    allowed?: unknown;
    ttlMs?: number;
    expiresAt?: number;
    exclusionRevision?: number;
    excluded?: unknown;
    requestId?: string;
  }) => {
    processor.port.onmessage({ data });
  };
  const gate = (allowed: boolean) => {
    message({
      type: 'gate',
      recordingId: id,
      gateRevision: ++revision,
      allowed,
      ttlMs: 2000,
      expiresAt: 3000,
    });
  };
  const exclude = (excluded: boolean) => {
    message({
      type: 'exclude-mic',
      recordingId: id,
      exclusionRevision: ++exclusionRevision,
      excluded,
    });
  };
  const pcm = () => {
    processor.process(
      [[new Float32Array(128)], [new Float32Array(128).fill(1)]],
      [[new Float32Array(128)]],
    );
    message({ type: 'pause', requestId: 'flush' });
    const chunk = sent.splice(0).find((item) => object(item)['type'] === 'pcm');
    message({ type: 'resume' });
    return [...new Int16Array(bytes(object(chunk)['pcm']))].slice(1);
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
void test('a local deletion winning a pending transfer status update does not abort other recordings; storage failures still propagate', async () => {
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
          builder.onResolve({ filter: /^\.\/(storage|settings)(?:\.ts)?$/ }, (args) => ({
            path: args.path.slice(2).replace(/\.ts$/, ''),
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path === 'storage' ? fakeStorage : fakeSettings,
          }));
        },
      },
    ],
  });
  const newer: {
    recordingId: string;
    libraryId: string;
    chunkCount: number;
    totalFrames: number;
    captureState: string;
    createdAt: string;
    gaps: unknown[];
    receipt?: unknown;
  } = {
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
    navigator: {
      locks: { request: async (_name: unknown, _options: unknown, work: () => unknown) => work() },
    },
    fetch: async (url: string) => {
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
  vm.runInNewContext(defined(result.outputFiles[0]).text, context);
  await moduleExports<typeof ProtocolModule>(Reflect.get(context, 'api'), [
    'transferPending',
  ]).transferPending(
    async () => {},
    () => {},
  );
  assert.ok(defined(context.records.get(older.recordingId)).receipt);
  assert.equal(context.records.has(newer.recordingId), false);
  context.records.set(newer.recordingId, newer);
  context.storageFailure = true;
  await assert.rejects(
    moduleExports<typeof ProtocolModule>(Reflect.get(context, 'api'), [
      'transferPending',
    ]).transferPending(
      async () => {},
      () => {},
    ),
    /disk write failed/,
  );
});
