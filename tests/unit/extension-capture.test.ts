import type { Recording } from '../../extension/src/core.ts';
import { defined, object, text } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeStorage = `export async function allRecordings(){return [...journal.rows.values()]};export async function recording(id){const row=journal.rows.get(id);return row?{...row}:undefined};export async function markInterrupted(){journal.recovered=true;for(const row of journal.rows.values())if(['recording','paused'].includes(row.captureState)){row.captureState='interrupted';row.interrupted=true}};export async function createRecording(row){journal.rows.set(row.recordingId,row)};export async function updateRecording(id,patch){if(journal.failMetadata)throw Object.assign(new Error('metadata quota'),{name:'QuotaExceededError'});const row={...journal.rows.get(id),...patch};journal.rows.set(id,row);return row};export async function appendChunk(id,sequence,pcm){if(journal.hold)await journal.hold;if(journal.quotaAt===sequence)throw Object.assign(new Error('quota'),{name:'QuotaExceededError'});const row=journal.rows.get(id);if(row.chunkCount!==sequence||row.captureState!=='recording'||row.totalFrames+pcm.byteLength/2>journal.frameLimit)throw new Error('sequence');row.chunkCount++;row.totalFrames+=pcm.byteLength/2;journal.chunks.push({id,sequence,pcm});return {id,sequence,pcm}};export async function getChunk(){return undefined};export async function retainReceiptAndRemovePCM(){throw new Error('not expected')}`;
const built = await build({
  entryPoints: [path.join(project, 'extension/src/offscreen.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  plugins: [
    {
      name: 'mock-durable-storage',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/storage(?:\.ts)?$/ }, () => ({
          path: 'storage',
          namespace: 'fake',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
          contents: fakeStorage,
          loader: 'js',
        }));
      },
    },
  ],
});
const limitBuilt = await build({
  entryPoints: [path.join(project, 'extension/src/offscreen.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  plugins: [
    {
      name: 'bounded-capture-journal',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(storage|core)(?:\.ts)?$/ }, (args) => ({
          path: args.path.slice(2).replace(/\.ts$/, ''),
          namespace: 'bounded',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'bounded' }, async (args) => ({
          contents:
            args.path === 'storage'
              ? fakeStorage
              : (await readFile(path.join(project, 'extension/src/core.ts'), 'utf8')).replace(
                  'SAMPLE_RATE * 60 * 60 * 8',
                  '32000',
                ),
          loader: 'ts',
        }));
      },
    },
  ],
});
interface Track {
  stopped: boolean;
  listeners: Record<string, () => void>;
  stop(): void;
  addEventListener(name: string, callback: () => void): void;
}
interface Stream {
  getTracks(): Track[];
}
interface Source {
  stream: Stream;
  connections: { target: unknown; input: number | undefined }[];
  connect(target: unknown, output?: number, input?: number): void;
}
interface Control {
  type: string;
  requestId?: unknown;
  allowed?: boolean;
}
interface Notice {
  type: string;
  error?: string;
  retryAt?: number;
}
interface Reply {
  ok?: boolean;
  error?: string;
  value?: {
    active: null | { mic: string; micExcluded: boolean; recordingId: string };
    busy?: boolean;
    error?: string;
  };
}
function reply(value: unknown): Reply | undefined {
  if (value === undefined) return undefined;
  const r = object(value);
  if (r['ok'] !== undefined) assert.equal(typeof r['ok'], 'boolean');
  if (r['error'] !== undefined) text(r['error']);
  if (r['value'] !== undefined) {
    const v = object(r['value']);
    if (v['active'] !== null && v['active'] !== undefined) {
      const a = object(v['active']);
      text(a['mic']);
      text(a['recordingId']);
      if (a['micExcluded'] !== undefined) assert.equal(typeof a['micExcluded'], 'boolean');
    }
    if (v['busy'] !== undefined) assert.equal(typeof v['busy'], 'boolean');
    if (v['error'] !== undefined) text(v['error']);
  }
  return r as Reply;
}
function harness({
  denyMic = false,
  micErrorName = 'NotAllowedError',
  frameLimit = 460800000,
} = {}) {
  const journal = {
    frameLimit,
    resumeHold: null as Promise<void> | null,
    rows: new Map<string, Recording>(),
    chunks: [] as { id: string; sequence: number; pcm: ArrayBuffer }[],
    recovered: false,
    hold: null as Promise<void> | null,
    quotaAt: -1,
    failMetadata: false,
  };
  const calls: { video: boolean; audio: { deviceId: { exact: string } } }[] = [];
  const nodes: (Source | Worklet)[] = [];
  const streams: Stream[] = [];
  const notifications: Notice[] = [];
  const contexts: Context[] = [];
  const intervals: number[] = [];
  let listener: (
    data: Record<string, unknown>,
    sender: { id: string; url: string; tab?: { id: number } },
    respond: (value: unknown) => void,
  ) => unknown;
  class Context {
    constructor() {
      contexts.push(this);
    }
    listeners: Record<string, () => void> = {};
    destination = { kind: 'playback' };
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource(stream: Stream) {
      const node: Source = {
        stream,
        connections: [],
        connect(target: unknown, _output?: number, input?: number) {
          this.connections.push({ target, input });
        },
      };
      nodes.push(node);
      return node;
    }
    async resume() {
      if (journal.resumeHold) await journal.resumeHold;
    }
    async close() {
      this.state = 'closed';
    }
    addEventListener(name: string, callback: () => void) {
      this.listeners[name] = callback;
    }
  }
  class Worklet {
    pendingPCM: ArrayBuffer | null = null;
    messages: Control[] = [];
    disconnected = false;
    port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (data: Control) => {
        this.messages.push(data);
        if (['pause', 'stop'].includes(data.type)) {
          if (this.pendingPCM) {
            this.emit(this.pendingPCM);
            this.pendingPCM = null;
          }
          defined(this.port.onmessage)({ data: { type: 'flushed', requestId: data.requestId } });
        }
      },
    };
    constructor() {
      nodes.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    connect() {}
    emit(pcm: ArrayBuffer) {
      defined(this.port.onmessage)({ data: { type: 'pcm', pcm, frames: pcm.byteLength / 2 } });
    }
  }
  const chrome = {
    runtime: {
      id: 'synthetic',
      getURL: (path: unknown) => `chrome-extension://synthetic/${path}`,
      onMessage: {
        addListener: (value: typeof listener) => {
          listener = value;
        },
      },
      sendMessage: async (message: Notice) => {
        notifications.push(message);
        if (message.type === 'TRUSTED_LINK') return { ok: true, value: { state: 'none' } };
        return {};
      },
    },
  };
  const context = {
    chrome,
    journal,
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints: (typeof calls)[number]) => {
          calls.push(constraints);
          if (calls.length % 2 === 0 && denyMic)
            throw Object.assign(new Error('private-device-label must not be exposed'), {
              name: micErrorName,
            });
          const track = {
            stopped: false,
            listeners: {} as Record<string, () => void>,
            stop() {
              this.stopped = true;
            },
            addEventListener(name: string, callback: () => void) {
              this.listeners[name] = callback;
            },
          };
          const stream = { getTracks: () => [track] };
          streams.push(stream);
          return stream;
        },
      },
    },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    setInterval: () => {
      intervals.push(1);
      return 1;
    },
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
    ArrayBuffer,
    Number,
    Math,
    AbortSignal,
    Headers,
    Blob,
    URL,
    fetch: () => {
      throw new Error('no endpoint expected');
    },
  };
  vm.runInNewContext(
    defined((frameLimit === 32000 ? limitBuilt : built).outputFiles[0]).text,
    context,
  );
  const message = (
    data: { type: string } & Record<string, unknown>,
    sender: { id: string; url: string; tab?: { id: number } } = {
      id: 'synthetic',
      url: 'chrome-extension://synthetic/background.js',
    },
  ) =>
    new Promise<Reply | undefined>((resolve) => {
      const accepted = listener({ ...data, target: 'offscreen' }, sender, (value) =>
        resolve(reply(value)),
      );
      if (!accepted) resolve(undefined);
    });
  const start = (micEnabled = true, recordingId = 'synthetic-recording') =>
    message({
      type: 'START',
      streamId: 'synthetic-stream',
      micEnabled,
      micDeviceId: 'selected-microphone',
      recording: {
        recordingId,
        libraryId: null,
        title: 'Synthetic capture',
        provider: 'meet',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        consent: true,
        liveTranscription: false,
        sampleRate: 16000,
        channels: 1,
        createdAt: '2026-10-05T00:00:00Z',
      },
    });
  return {
    journal,
    intervals,
    calls,
    nodes,
    streams,
    notifications,
    contexts,
    message,
    start,
    worklet: () => nodes.find((node) => node instanceof Worklet),
  };
}
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}
test('offscreen asks the service worker for its connection and captures selected mic without feedback', async () => {
  const h = harness();
  assert.equal(defined(await h.start()).ok, true);
  assert.equal(h.journal.recovered, true);
  assert.equal(h.calls.length, 2);
  assert.equal(defined(h.calls[0]).video, false);
  assert.equal(defined(h.calls[1]).video, false);
  assert.equal(defined(h.calls[1]).audio.deviceId.exact, 'selected-microphone');
  const sources = h.nodes.filter((node): node is Source => 'stream' in node);
  assert.equal(defined(sources[0]).connections.length, 2);
  assert.equal(defined(sources[1]).connections.length, 1);
  assert.equal(defined(defined(sources[1]).connections[0]).target, h.worklet());
  assert.equal(defined(defined(sources[1]).connections[0]).input, 1);
  await h.message({ type: 'SYNC' });
  assert.ok(h.notifications.some((message) => message.type === 'TRUSTED_LINK'));
  assert.equal(
    await h.message(
      { type: 'START' },
      { id: 'synthetic', url: 'https://meet.google.com/abc-defg-hij', tab: { id: 1 } },
    ),
    undefined,
  );
  assert.equal(
    await h.message(
      { type: 'STATUS' },
      { id: 'different-extension', url: 'chrome-extension://synthetic/background.js' },
    ),
    undefined,
  );
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
  assert.ok(h.streams.every((stream) => defined(stream.getTracks()[0]).stopped));
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).interruption, undefined);
});
test('microphone denial requires explicit tab-only retry and never silently downgrades capture', async () => {
  const h = harness({ denyMic: true });
  const denied = await h.start();
  assert.equal(defined(denied).ok, false);
  assert.match(defined(defined(denied).error), /explicitly choose tab audio only/);
  assert.equal(h.journal.rows.size, 0);
  assert.equal(defined(defined(h.streams[0]).getTracks()[0]).stopped, true);
  const tabOnly = await h.start(false);
  assert.equal(defined(tabOnly).ok, true);
  assert.equal(h.calls.length, 3);
  const status = await h.message({ type: 'STATUS' });
  assert.equal(defined(defined(defined(status).value).active).mic, 'tab-only');
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
});
for (const [micErrorName, expected] of [
  ['NotAllowedError', /access was denied/],
  ['SecurityError', /access was denied/],
  ['NotFoundError', /selected microphone is unavailable/],
  ['OverconstrainedError', /selected microphone is unavailable/],
  ['NotReadableError', /could not be opened/],
  ['AbortError', /startup was interrupted/],
  ['UnexpectedError', /could not be started/],
] satisfies [string, RegExp][])
  test(`microphone ${micErrorName} gives actionable bounded failure without automatic fallback`, async () => {
    const h = harness({ denyMic: true, micErrorName });
    const result = await h.start();
    assert.equal(defined(result).ok, false);
    assert.match(defined(defined(result).error), expected);
    assert.match(defined(defined(result).error), /explicitly choose tab audio only/);
    assert.equal(defined(defined(result).error).includes('private-device-label'), false);
    assert.equal(h.journal.rows.size, 0);
    assert.equal(h.calls.length, 2);
    assert.equal(defined(defined(h.streams[0]).getTracks()[0]).stopped, true);
  });
test('microphone disconnection excludes its input while preserving healthy tab capture', async () => {
  const h = harness();
  await h.start();
  defined(defined(defined(h.streams[1]).getTracks()[0]).listeners['ended'])();
  await h.message({
    type: 'GATE',
    recordingId: 'synthetic-recording',
    gateRevision: 1,
    allowed: true,
    ttlMs: 2000,
    expiresAt: Date.now() + 2000,
    state: 'unmuted',
  });
  const status = await h.message({ type: 'STATUS' });
  assert.match(defined(defined(defined(status).value).active).mic, /microphone disconnected/);
  assert.equal(defined(defined(h.worklet()).messages.at(-1)).allowed, false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).captureState, 'recording');
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).totalFrames, 16000);
  assert.equal(defined(defined(h.streams[0]).getTracks()[0]).stopped, false);
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
});
test('offscreen rejects old and recording-mismatched gates after a newer mute', async () => {
  const h = harness();
  await h.start();
  const future = Date.now() + 2000;
  await h.message({
    type: 'GATE',
    recordingId: 'synthetic-recording',
    gateRevision: 2,
    allowed: false,
    ttlMs: 2000,
    expiresAt: future,
    state: 'muted',
  });
  await h.message({
    type: 'GATE',
    recordingId: 'synthetic-recording',
    gateRevision: 1,
    allowed: true,
    ttlMs: 2000,
    expiresAt: future,
    state: 'unmuted',
  });
  await h.message({
    type: 'GATE',
    recordingId: 'another-recording',
    gateRevision: 3,
    allowed: true,
    ttlMs: 2000,
    expiresAt: future,
    state: 'unmuted',
  });
  assert.match(
    defined(defined(defined(await h.message({ type: 'STATUS' })).value).active).mic,
    /muted/,
  );
  assert.equal(defined(defined(h.worklet()).messages.at(-1)).allowed, false);
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
});
test('pause flushes durable PCM before state change, resumes with timeline gap, then stops tracks', async () => {
  const h = harness();
  await h.start(false);
  const worklet = h.worklet();
  defined(worklet).emit(new ArrayBuffer(32000));
  defined(worklet).pendingPCM = new ArrayBuffer(2000);
  const pause = await h.message({
    type: 'CONTROL',
    recordingId: 'synthetic-recording',
    action: 'pause',
  });
  assert.equal(defined(pause).ok, true);
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).captureState, 'paused');
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).totalFrames, 17000);
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'pause' });
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).chunkCount, 2);
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'resume' });
  const resumed = h.journal.rows.get('synthetic-recording');
  assert.equal(defined(resumed).captureState, 'recording');
  assert.equal(defined(resumed).gaps.length, 1);
  assert.equal(defined(defined(resumed).gaps[0]).atFrame, 17000);
  assert.ok(defined(defined(resumed).gaps[0]).pauseMs >= 0);
  defined(worklet).emit(new ArrayBuffer(32000));
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).totalFrames, 33000);
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).captureState, 'stopped');
  assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
});
test('quota failure stops capture and preserves already committed prefix', async () => {
  const h = harness();
  await h.start(false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  h.journal.quotaAt = 1;
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  const row = h.journal.rows.get('synthetic-recording');
  assert.equal(defined(row).captureState, 'interrupted');
  assert.equal(defined(row).totalFrames, 16000);
  assert.equal(defined(row).chunkCount, 1);
  assert.match(defined(defined(row).error), /Storage quota was reached/);
  assert.equal(defined(defined(row).interruption).reason, 'local-storage');
  assert.equal(defined(defined(row).interruption).atFrame, 16000);
  assert.equal(defined(row).transferState, 'attention');
  assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
});
test('a failed interruption metadata write still reports inactive capture and retained recovery audio', async () => {
  const h = harness();
  await h.start(false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  h.journal.quotaAt = 1;
  h.journal.failMetadata = true;
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  const status = await h.message({ type: 'STATUS' });
  assert.equal(defined(defined(status).value).active, null);
  assert.match(defined(defined(defined(status).value).error), /Storage quota was reached/);
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).captureState, 'recording');
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).chunkCount, 1);
  assert.equal(h.journal.chunks.length, 1);
});
test('persistence backlog beyond five seconds interrupts and retains only durable prefix', async () => {
  const h = harness();
  await h.start(false);
  let release: (() => void) | undefined;
  h.journal.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  for (let i = 0; i < 5; i++) defined(h.worklet()).emit(new ArrayBuffer(32000));
  defined(release)();
  await settle();
  const row = h.journal.rows.get('synthetic-recording');
  assert.equal(defined(row).captureState, 'interrupted');
  assert.equal(defined(row).chunkCount, 1);
  assert.equal(defined(row).totalFrames, 16000);
  assert.match(defined(defined(row).error), /five seconds/);
  assert.ok(h.streams.every((stream) => defined(stream.getTracks()[0]).stopped));
  assert.equal(defined(defined(row).interruption).reason, 'save-backlog');
});
test('captured tab track ending flushes partial audio and records its fixed reason', async () => {
  const h = harness();
  await h.start(false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  defined(h.worklet()).pendingPCM = new ArrayBuffer(2000);
  defined(defined(defined(h.streams[0]).getTracks()[0]).listeners['ended'])();
  await settle();
  const row = h.journal.rows.get('synthetic-recording');
  assert.equal(defined(row).captureState, 'interrupted');
  assert.equal(defined(row).totalFrames, 17000);
  assert.equal(defined(defined(row).interruption).reason, 'tab-track-ended');
  assert.equal(defined(defined(row).interruption).atFrame, 17000);
  assert.match(defined(defined(row).interruption).at, /^\d{4}-/);
});
test('AudioContext suspension retains a distinct diagnostic without flushing unsafe capture', async () => {
  const h = harness();
  await h.start(false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  defined(h.contexts[0]).state = 'suspended';
  defined(defined(h.contexts[0]).listeners['statechange'])();
  await settle();
  assert.equal(
    defined(defined(h.journal.rows.get('synthetic-recording')).interruption).reason,
    'audio-suspended',
  );
  assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
});
test('only fixed interruption reasons are accepted from control messages', async () => {
  const h = harness();
  await h.start(false);
  await h.message({
    type: 'CONTROL',
    recordingId: 'synthetic-recording',
    action: 'stop',
    interrupted: true,
    interruptionReason: 'https://private.invalid/meeting-title',
  });
  assert.equal(
    defined(defined(h.journal.rows.get('synthetic-recording')).interruption).reason,
    'capture-failed',
  );
});
test('active microphone exclusion only narrows the provider gate and never adds a missing stream', async () => {
  const h = harness();
  await h.start();
  const id = 'synthetic-recording';
  let revision = 0;
  const gate = (allowed: boolean) =>
    h.message({
      type: 'GATE',
      recordingId: id,
      gateRevision: ++revision,
      allowed,
      ttlMs: 2000,
      expiresAt: Date.now() + 2000,
      state: allowed ? 'unmuted' : 'muted',
    });
  await gate(true);
  await h.message({ type: 'MIC_EXCLUSION', recordingId: id, excluded: true });
  await gate(true);
  assert.equal(defined(defined(h.worklet()).messages.at(-1)).allowed, false);
  assert.equal(
    defined(defined(defined(await h.message({ type: 'STATUS' })).value).active).micExcluded,
    true,
  );
  assert.match(
    defined(defined(defined(await h.message({ type: 'STATUS' })).value).active).mic,
    /by you/,
  );
  await h.message({ type: 'MIC_EXCLUSION', recordingId: id, excluded: false });
  await gate(false);
  assert.equal(defined(defined(h.worklet()).messages.at(-1)).allowed, false);
  await gate(true);
  assert.equal(defined(defined(h.worklet()).messages.at(-1)).allowed, true);
  assert.equal(h.calls.length, 2);
  await h.message({ type: 'CONTROL', recordingId: id, action: 'stop' });
  const tabOnly = harness();
  await tabOnly.start(false);
  const denied = await tabOnly.message({ type: 'MIC_EXCLUSION', recordingId: id, excluded: false });
  assert.equal(defined(denied).ok, false);
  assert.match(defined(defined(denied).error), /no available microphone/);
  assert.equal(tabOnly.calls.length, 1);
  await tabOnly.message({ type: 'CONTROL', recordingId: id, action: 'stop' });
});

test('tab-ending Stop waits for a held Pause flush and finalizes the same recording', async () => {
  const h = harness();
  await h.start(false);
  let release: (() => void) | undefined;
  h.journal.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  const pause = h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'pause' });
  await settle();
  defined(defined(defined(h.streams[0]).getTracks()[0]).listeners['ended'])();
  const stop = h.message({
    type: 'CONTROL',
    recordingId: 'synthetic-recording',
    action: 'stop',
    interrupted: true,
    interruptionReason: 'tab-closed',
  });
  await settle();
  defined(release)();
  assert.equal(defined(await pause).ok, true);
  assert.equal(defined(await stop).ok, true);
  await settle();
  const row = h.journal.rows.get('synthetic-recording');
  assert.equal(defined(row).captureState, 'interrupted');
  assert.equal(defined(row).totalFrames, 16000);
  assert.equal(defined(defined(row).interruption).reason, 'tab-track-ended');
  assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
  assert.ok(h.streams.every((stream) => defined(stream.getTracks()[0]).stopped));
});
test('Stop during startup waits for capture, and an old queued Stop cannot affect a newer recording', async () => {
  const h = harness();
  let release: (() => void) | undefined;
  h.journal.resumeHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = h.start(false);
  await settle();
  const stop = h.message({
    type: 'CONTROL',
    recordingId: 'synthetic-recording',
    action: 'stop',
    interrupted: true,
    interruptionReason: 'document-changed',
  });
  await settle();
  defined(release)();
  assert.equal(defined(await start).ok, true);
  assert.equal(defined(await stop).ok, true);
  assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
  let releaseNew: (() => void) | undefined;
  h.journal.resumeHold = new Promise<void>((resolve) => {
    releaseNew = resolve;
  });
  const newer = h.start(false, 'newer-recording');
  await settle();
  const stale = h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
  await settle();
  defined(releaseNew)();
  assert.equal(defined(await newer).ok, true);
  assert.equal(defined(await stale).ok, true);
  assert.equal(
    defined(defined(defined(await h.message({ type: 'STATUS' })).value).active).recordingId,
    'newer-recording',
  );
  assert.equal(defined(h.journal.rows.get('newer-recording')).captureState, 'recording');
  await h.message({ type: 'CONTROL', recordingId: 'newer-recording', action: 'stop' });
});
for (const partialPause of [false, true])
  test(`recording frame cap finalizes cleanly with ${partialPause ? 'a partial pause chunk' : 'aligned chunks and post-cap buffered PCM'}`, async () => {
    const h = harness({ frameLimit: 32000 });
    await h.start(false);
    defined(h.worklet()).emit(new ArrayBuffer(32000));
    await settle();
    if (partialPause) {
      defined(h.worklet()).pendingPCM = new ArrayBuffer(1000);
      await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'pause' });
      await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'resume' });
    }
    defined(h.worklet()).pendingPCM = new ArrayBuffer(2000);
    defined(h.worklet()).emit(new ArrayBuffer(32000));
    await settle();
    const row = h.journal.rows.get('synthetic-recording');
    assert.equal(defined(row).totalFrames, 32000);
    assert.equal(defined(row).captureState, 'stopped');
    assert.equal(defined(row).interrupted, false);
    assert.equal(defined(row).interruption, undefined);
    assert.equal(defined(row).error, undefined);
    assert.equal(
      h.journal.chunks.reduce((total, chunk) => total + chunk.pcm.byteLength / 2, 0),
      32000,
    );
    assert.equal(defined(row).chunkCount, partialPause ? 3 : 2);
    assert.equal(defined(defined(await h.message({ type: 'STATUS' })).value).active, null);
    assert.ok(h.streams.every((stream) => defined(stream.getTracks()[0]).stopped));
  });
test('a reported recorder failure clears on the next start, which retries recovery and records', async () => {
  const h = harness();
  await h.start(false);
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  h.journal.quotaAt = 1;
  h.journal.failMetadata = true;
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  assert.ok(
    h.notifications.some(
      (message) =>
        message.type === 'CAPTURE_STATUS' &&
        typeof message.error === 'string' &&
        /Storage quota/.test(message.error),
    ),
    'the failure reaches the worker for the popup',
  );
  h.journal.failMetadata = false;
  h.journal.quotaAt = -1;
  const again = await h.start(false, 'second-recording');
  assert.equal(defined(again).ok, true, defined(again).error);
  const status = await h.message({ type: 'STATUS' });
  assert.equal(defined(defined(status).value).error, undefined);
  assert.equal(defined(defined(defined(status).value).active).recordingId, 'second-recording');
  assert.equal(defined(h.journal.rows.get('synthetic-recording')).captureState, 'interrupted');
  await h.message({ type: 'CONTROL', recordingId: 'second-recording', action: 'stop' });
});
test('uploads follow committed audio instead of polling, and settle only when not recording', async () => {
  const h = harness();
  const idle = () =>
    h.notifications.some((message) => message.type === 'UPLOADS_SETTLED' && !message.retryAt);
  // The first pass runs from a zero-delay timer after recovery.
  for (let i = 0; i < 20 && !idle(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.intervals.length, 0, 'the offscreen document never polls');
  assert.ok(idle(), 'an idle document tells the worker it may close');
  await h.start(false);
  h.notifications.length = 0;
  defined(h.worklet()).emit(new ArrayBuffer(32000));
  await settle();
  assert.equal(
    defined(defined(await h.message({ type: 'STATUS' })).value).busy,
    true,
    'an upload is scheduled',
  );
  await h.message({ type: 'SYNC', failures: 3 });
  assert.ok(h.notifications.some((message) => message.type === 'TRUSTED_LINK'));
  assert.equal(
    h.notifications.some((message) => message.type === 'UPLOADS_SETTLED'),
    false,
    'a recording document schedules its own uploads',
  );
  await h.message({ type: 'CONTROL', recordingId: 'synthetic-recording', action: 'stop' });
});
