import type * as LibraryActionsModule from '../../extension/src/library-actions.ts';
import type * as ProtocolModule from '../../extension/src/protocol.ts';
import type * as StorageModule from '../../extension/src/storage.ts';
import { moduleExports } from '../helpers/assertions.ts';
import { text } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const id = '11111111-1111-4111-8111-111111111111';
const oldLibrary = '22222222-2222-4222-8222-222222222222';
const newLibrary = '33333333-3333-4333-8333-333333333333';
const meeting = '44444444-4444-4444-8444-444444444444';
interface Row {
  recordingId: string;
  libraryId: string;
  captureState: string;
  totalFrames: number;
  chunkCount: number;
  receipt: { libraryId: string; meetingId: string } | undefined;
}
const row = (): Row => ({
  recordingId: id,
  libraryId: oldLibrary,
  captureState: 'stopped',
  totalFrames: 16000,
  chunkCount: 1,
  receipt: undefined,
});
const oldPair = () => ({
  libraryId: oldLibrary,
  endpoint: 'http://localhost:3001',
  credential: '',
});
function locks() {
  const queues = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, options: { mode: unknown }, work: () => Promise<T>): Promise<T> {
      assert.equal(options.mode, 'exclusive');
      const task = (queues.get(name) ?? Promise.resolve()).then(work);
      queues.set(
        name,
        task.catch(() => {}),
      );
      return task;
    },
  };
}
const actionsBuild = await build({
  entryPoints: ['extension/src/library-actions.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'api',
  plugins: [
    {
      name: 'library-mocks',
      setup(b) {
        b.onResolve({ filter: /^\.\/(settings|storage)(?:\.ts)?$/ }, (args) => ({
          path: args.path.replace(/\.ts$/, ''),
          namespace: 'mock',
        }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: args.path.endsWith('settings')
            ? 'export const connectedPair=async()=>globalThis.pair;'
            : 'export const recording=async id=>globalThis.rows.get(id);export const deleteRecording=async id=>{globalThis.deleted.push(id);globalThis.rows.delete(id)};',
        }));
      },
    },
  ],
});
function actionsHarness() {
  const context = {
    URL,
    navigator: { locks: locks() },
    pair: oldPair(),
    rows: new Map([[id, row()]]),
    deleted: [] as string[],
    opened: [] as { url: string }[],
    chrome: { tabs: { create: async (value: { url: string }) => context.opened.push(value) } },
  };
  vm.runInNewContext(defined(actionsBuild.outputFiles[0]).text, context);
  return Object.assign(context, {
    api: moduleExports<typeof LibraryActionsModule>(Reflect.get(context, 'api'), [
      'openEcho',
      'echoURL',
      'deleteLocalRecording',
    ]),
  });
}
void test('receipt opens only its original library, never another connected library', async () => {
  const h = actionsHarness();
  defined(h.rows.get(id)).receipt = { libraryId: oldLibrary, meetingId: meeting };
  await h.api.openEcho(id);
  const url = new URL(defined(h.opened[0]).url);
  assert.equal(url.origin, 'http://localhost:3001');
  assert.equal(url.searchParams.get('library'), oldLibrary);
  assert.equal(url.searchParams.get('meeting'), meeting);
  h.pair = { libraryId: newLibrary, endpoint: 'http://localhost:3999', credential: '' };
  await assert.rejects(h.api.openEcho(id), /different Echo library/);
  assert.equal(h.opened.length, 1);
});
void test('Echo links reject unsafe endpoints and malformed or cross-library receipts', () => {
  const h = actionsHarness();
  const value = { ...row(), receipt: { libraryId: oldLibrary, meetingId: meeting } };
  h.pair.endpoint = 'https://example.invalid';
  assert.throws(() => h.api.echoURL(h.pair, value), /exact local Echo address/);
  h.pair.endpoint = 'http://localhost:3001';
  value.receipt.meetingId = '../settings';
  assert.throws(() => h.api.echoURL(h.pair, value), /invalid Echo receipt/);
  value.receipt.meetingId = meeting;
  value.libraryId = newLibrary;
  assert.throws(() => h.api.echoURL(h.pair, value), /invalid Echo receipt/);
});
void test('local deletion requires explicit confirmation and rejects the active recording', async () => {
  const h = actionsHarness();
  await assert.rejects(h.api.deleteLocalRecording(id, false), /Confirm deletion/);
  await assert.rejects(h.api.deleteLocalRecording(id, true, id), /Stop this recording/);
  assert.equal(h.deleted.length, 0);
  await h.api.deleteLocalRecording(id, true);
  assert.deepEqual(h.deleted, [id]);
  assert.equal(h.opened.length, 0);
});
void test('delete waits for an in-flight transfer holding the same cross-context lock', async () => {
  const h = actionsHarness();
  let release: (() => void) | undefined;
  const transfer = h.navigator.locks.request(
    `echo-recording:${id}`,
    { mode: 'exclusive' },
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const deletion = h.api.deleteLocalRecording(id, true);
  await Promise.resolve();
  assert.equal(h.deleted.length, 0);
  defined(release)();
  await transfer;
  await deletion;
  assert.deepEqual(h.deleted, [id]);
});
void test('a queued transfer re-reads the journal after deletion and cannot recreate or upload the row', async () => {
  const result = await build({
    entryPoints: ['extension/src/protocol.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'protocol',
    plugins: [
      {
        name: 'transfer-journal',
        setup(b) {
          b.onResolve({ filter: /^\.\/(storage|settings)(?:\.ts)?$/ }, (args) => ({
            path: args.path.replace(/\.ts$/, ''),
            namespace: 'mock',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path.endsWith('settings')
              ? 'export const connectedPair=async()=>undefined;export const revokeCredential=async()=>{};'
              : 'export const recording=async id=>globalThis.rows.get(id);export const allRecordings=async()=>[];export const getChunk=async()=>{throw Error("unexpected chunk")};export const updateRecording=async()=>{throw Error("unexpected update")};export const retainReceiptAndRemovePCM=async()=>{throw Error("unexpected receipt")};',
          }));
        },
      },
    ],
  });
  const context = {
    navigator: { locks: locks() },
    rows: new Map([[id, row()]]),
    fetch: () => {
      throw Error('unexpected network');
    },
  };
  vm.runInNewContext(defined(result.outputFiles[0]).text, context);
  let release: (() => void) | undefined;
  const deletion = context.navigator.locks.request(
    `echo-recording:${id}`,
    { mode: 'exclusive' },
    () =>
      new Promise<void>((resolve) => {
        release = () => {
          context.rows.delete(id);
          resolve();
        };
      }),
  );
  await Promise.resolve();
  const transfer = moduleExports<typeof ProtocolModule>(Reflect.get(context, 'protocol'), [
    'transferOne',
  ]).transferOne(row(), oldPair(), async () => {});
  defined(release)();
  await deletion;
  await transfer;
  assert.equal(context.rows.size, 0);
});

const storageBuild = await build({
  entryPoints: ['extension/src/storage.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'journal',
});
function journalHarness(
  initialRow: {
    recordingId: string;
    libraryId: string;
    captureState: string;
    totalFrames: number;
    chunkCount: number;
    receipt: { libraryId: string; meetingId: string } | undefined;
  },
  pendingBytes = 32000,
) {
  interface Stored {
    recordingId?: string;
    sequence?: number;
    pcm?: ArrayBuffer;
    key?: string;
    value?: number;
    libraryId?: string;
    captureState?: string;
    totalFrames?: number;
    chunkCount?: number;
    receipt?: { libraryId: string; meetingId: string } | undefined;
  }
  interface Request<T = unknown> {
    result: T;
    onsuccess?: (event?: unknown) => void;
  }
  interface Cursor {
    delete(): unknown;
    continue(): void;
  }
  interface Tx {
    abort(): void;
    objectStore(name: string): {
      get(key: string): Request;
      put(value: Stored): unknown;
      delete(key: string): unknown;
      index(): { openCursor(target: unknown): Request<Cursor | null> };
    };
    onabort?: () => void;
    oncomplete?: () => void;
  }
  const data: {
    recordings: Map<string, Stored>;
    chunks: Map<string, Stored>;
    meta: Map<string, Stored>;
  } = {
    recordings: new Map([[id, structuredClone(initialRow)]]),
    chunks: new Map([['chunk', { recordingId: id, sequence: 0, pcm: new ArrayBuffer(32000) }]]),
    meta: new Map([['pendingBytes', { key: 'pendingBytes', value: pendingBytes }]]),
  };
  let strict = false;
  const db = {
    transaction(names: (keyof typeof data)[], _mode: unknown, options?: { durability: string }) {
      strict = options?.durability === 'strict';
      const local: Record<string, Map<string, Stored>> = Object.fromEntries(
        Object.entries(data).map(([name, map]) => [name, structuredClone(map)]),
      );
      let aborted = false;
      const request = (value: unknown) => {
        const req: Request = { result: structuredClone(value) };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      };
      const tx: Tx = {
        abort() {
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name: string) {
          return {
            get: (key: string) => request(defined(local[name]).get(key)),
            put: (value: Stored) =>
              defined(local[name]).set(
                text(value.key ?? value.recordingId),
                structuredClone(value),
              ),
            delete: (key: string) => defined(local[name]).delete(key),
            index() {
              return {
                openCursor(target: unknown) {
                  const req: Request<Cursor | null> = { result: null };
                  const entries = [...defined(local['chunks']).entries()].filter(
                    ([, value]) => value.recordingId === target,
                  );
                  let index = 0;
                  const next = () => {
                    queueMicrotask(() => {
                      const entry = entries[index++];
                      req.result = entry
                        ? {
                            delete: () => defined(local['chunks']).delete(entry[0]),
                            continue: next,
                          }
                        : null;
                      req.onsuccess?.({ target: req });
                    });
                  };
                  next();
                  return req;
                },
              };
            },
          };
        },
      };
      setTimeout(() => {
        if (!aborted) {
          for (const name of names) data[name] = defined(local[name]);
          tx.oncomplete?.();
        }
      }, 0);
      return tx;
    },
  };
  const context = {
    TextEncoder,
    TextDecoder,
    navigator: { locks: locks() },
    URL,
    Uint8Array,
    ArrayBuffer,
    Blob,
    IDBKeyRange: { only: (value: unknown) => value },
    indexedDB: {
      open() {
        const req: Request<typeof db> = { result: db };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    },
  };
  vm.runInNewContext(defined(storageBuild.outputFiles[0]).text, context);
  return {
    api: moduleExports<typeof StorageModule>(Reflect.get(context, 'journal'), ['deleteRecording']),
    data,
    strict: () => strict,
  };
}
void test('atomic local audio deletion removes chunks and releases pending byte budget', async () => {
  const h = journalHarness(row());
  await h.api.deleteRecording(id);
  assert.equal(h.strict(), true);
  assert.equal(h.data.recordings.size, 0);
  assert.equal(h.data.chunks.size, 0);
  assert.equal(defined(h.data.meta.get('pendingBytes')).value, 0);
});
void test('receipt removal leaves other recordings’ pending byte budget unchanged', async () => {
  const h = journalHarness({ ...row(), receipt: { libraryId: oldLibrary, meetingId: meeting } });
  h.data.chunks.clear();
  await h.api.deleteRecording(id);
  assert.equal(defined(h.data.meta.get('pendingBytes')).value, 32000);
  assert.equal(h.data.recordings.size, 0);
});
void test('recording and paused rows abort local deletion without mutating chunks or budget', async () => {
  for (const captureState of ['recording', 'paused']) {
    const h = journalHarness({ ...row(), captureState });
    await assert.rejects(h.api.deleteRecording(id), /Stop this recording/);
    assert.equal(h.data.recordings.size, 1);
    assert.equal(h.data.chunks.size, 1);
    assert.equal(defined(h.data.meta.get('pendingBytes')).value, 32000);
  }
});
