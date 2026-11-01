import type * as PairingModule from '../../extension/src/pairing.ts';
import type * as DiscoveryModule from '../../extension/src/discovery.ts';
import type * as SettingsModule from '../../extension/src/settings.ts';
import type * as ConnectionModule from '../../extension/src/connection.ts';
import type * as ExternalMessagesModule from '../../extension/src/external-messages.ts';
import type * as ProtocolModule from '../../extension/src/protocol.ts';
import type * as DeviceSecretsModule from '../../extension/src/device-secrets.ts';
import type * as StorageModule from '../../extension/src/storage.ts';
import type { Recording } from '../../extension/src/core.ts';
import type { Ciphertext } from '../../extension/src/encryption.ts';
export type PairingApi = Omit<
  typeof PairingModule &
    typeof DiscoveryModule &
    typeof SettingsModule &
    typeof ConnectionModule &
    Pick<typeof ExternalMessagesModule, 'externalMessage'> &
    Pick<typeof ProtocolModule, 'jsonRequest'>,
  'jsonRequest'
> & {
  jsonRequest(...args: Parameters<typeof ProtocolModule.jsonRequest>): Promise<unknown>;
};
export type SettingsApi = typeof SettingsModule & typeof DeviceSecretsModule;
export type StorageApi = typeof StorageModule;
type FetchOptions = RequestInit & { signal?: AbortSignal | null | undefined };
export type FixtureFetch = (url: string, options: FetchOptions) => Promise<Response>;
interface Area {
  setAccessLevel: () => Promise<void>;
  get: (keys?: string | string[]) => Promise<Record<string, unknown>>;
  set: (patch: Record<string, unknown>) => Promise<unknown>;
  remove: (keys: string | string[]) => Promise<void>;
}
interface FixtureContext extends Record<string, unknown> {
  crypto: {
    subtle: typeof webcrypto.subtle;
    getRandomValues: typeof webcrypto.getRandomValues;
    randomUUID: () => string;
  };
  chrome: {
    storage: { local: Area; session: Area };
    runtime: { getURL: (path: string) => string; getManifest: () => { version: string } };
    tabs: {
      query: () => Promise<Tab[]>;
      create: (tab: Tab) => Promise<Tab>;
      update: () => Promise<void>;
      get: (id: number) => Promise<Tab | undefined>;
      remove: (id: number) => Promise<number>;
    };
    windows: { update: () => Promise<void> };
  };
  api?: unknown;
}
interface Tab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
}
export interface Fixture<Api = PairingApi> {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  meta: Map<string, CryptoKey>;
  calls: [string, FetchOptions][];
  tabs: Tab[];
  removed: number[];
  now: number;
  context: FixtureContext;
  fetch: FixtureFetch;
  api: Api;
  approved?: boolean;
  loseClaim?: boolean;
  uuidCalls: () => number;
  writes: number;
  failNext?: boolean;
  data: ReturnType<typeof memoryDatabase>;
}
interface StoredRow {
  recordingId?: string;
  sequence?: number;
  key?: string;
  version?: number;
  metadata?: Ciphertext;
  keyWrap?: Ciphertext;
  pcm?: ArrayBuffer;
  value?: number;
}
interface MemoryRequest {
  result?: unknown;
  onsuccess?: (event?: { target: MemoryRequest }) => void;
  onerror?: () => void;
  error?: Error;
}
interface MemoryTransaction {
  abort(): void;
  objectStore(name: string): unknown;
  onabort?: () => void;
  onerror?: () => void;
  oncomplete?: () => void;
  error?: Error;
}
import vm from 'node:vm';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
export const library = '22222222-2222-4222-8222-222222222222';
export const endpoint = 'http://127.0.0.1:3111';
export const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function locks() {
  const queue = new Map<string, Promise<unknown>>();
  return {
    request(id: string, _options: unknown, work: () => unknown) {
      const next = (queue.get(id) ?? Promise.resolve()).then(work);
      queue.set(
        id,
        next.catch(() => {}),
      );
      return next;
    },
  };
}
export function fixture<Api = PairingApi>(): Fixture<Api> {
  // VM callbacks are installed below before the fixture is returned.
  class State implements Fixture<Api> {
    local: Record<string, unknown> = {};
    session: Record<string, unknown> = {};
    meta = new Map<string, CryptoKey>();
    calls: [string, FetchOptions][] = [];
    tabs: Tab[] = [];
    removed: number[] = [];
    now = Date.now();
    context!: FixtureContext;
    fetch!: FixtureFetch;
    api!: Api;
    uuidCalls!: () => number;
    writes!: number;
    data!: ReturnType<typeof memoryDatabase>;
    approved?: boolean;
    loseClaim?: boolean;
    failNext?: boolean;
  }
  const h = new State();
  const area = (store: Record<string, unknown>) => ({
    setAccessLevel: async () => {},
    get: async (keys?: string | string[]) =>
      Object.fromEntries(
        (typeof keys === 'string' ? [keys] : (keys ?? Object.keys(store))).map((key) => [
          key,
          structuredClone(store[key]),
        ]),
      ),
    set: async (patch: Record<string, unknown>) => Object.assign(store, structuredClone(patch)),
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) Reflect.deleteProperty(store, key);
    },
  });
  h.context = {
    URL,
    Headers,
    Response,
    AbortSignal,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob,
    btoa,
    atob,
    structuredClone,
    crypto: webcrypto,
    navigator: { locks: locks() },
    Date: class extends Date {
      static override now() {
        return h.now;
      }
    },
    deviceMeta: h.meta,
    chrome: {
      storage: { local: area(h.local), session: area(h.session) },
      runtime: {
        getURL: (path) => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' + path,
        getManifest: () => ({ version: '1.0.0' }),
      },
      tabs: {
        query: async () => h.tabs,
        create: async (tab: Tab) => {
          const value = { ...tab, id: h.tabs.length + 1 };
          h.tabs.push(value);
          return value;
        },
        update: async () => {},
        get: async (id: number) => h.tabs.find((tab) => tab.id === id),
        remove: async (id: number) => h.removed.push(id),
      },
      windows: { update: async () => {} },
    },
    fetch: (...args: Parameters<FixtureFetch>) => {
      h.calls.push(args);
      return h.fetch(...args);
    },
  };
  h.fetch = async (url) =>
    url.endsWith('/hello')
      ? reply({ service: 'echo-voice', protocolVersion: 2, libraryId: library })
      : reply({});
  return h;
}
export async function bundle<Api>(
  h: Fixture<Api>,
  contents: string,
  mocks: { db?: string } = {},
): Promise<Api> {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'fixture',
        setup(b) {
          b.onResolve({ filter: /^\.\/vault-db(?:\.ts)?$/ }, () => ({
            path: 'vault-db',
            namespace: 'fixture',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export async function readMeta(key){return deviceMeta.get(key)};export async function writeMeta(key,value){deviceMeta.set(key,value)};export const storageLock=(id,work)=>navigator.locks.request(id,{mode:'exclusive'},work);export const database=async()=>globalThis.db;export const result=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});export const committed=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error??Error('aborted'))});${mocks.db ?? ''}`,
          }));
        },
      },
    ],
  });
  vm.runInNewContext(result.outputFiles[0]?.text ?? '', h.context);
  const api: unknown = h.context.api;
  if (
    !api ||
    typeof api !== 'object' ||
    !Object.values(api).every((value: unknown) => typeof value === 'function')
  )
    throw new Error('Invalid bundled fixture exports.');
  return api as Api;
}
export const pairingBundle = `import * as pairing from './extension/src/pairing';import * as discovery from './extension/src/discovery';import * as settings from './extension/src/settings';import * as connection from './extension/src/connection';import {externalMessage} from './extension/src/external-messages';import {jsonRequest} from './extension/src/protocol';globalThis.api={...pairing,...discovery,...settings,...connection,externalMessage,jsonRequest};`;
// Minimal asynchronous IDB shim. Transactions commit cloned stores together;
// requests/cursors run before completion, and aborted writes never publish.
export function memoryDatabase(h: Fixture<unknown>) {
  const data: Record<string, Map<string, StoredRow>> = {
    recordings: new Map(),
    chunks: new Map(),
    meta: new Map(),
  };
  const keyFor = (name: string, value: StoredRow) =>
    name === 'chunks'
      ? JSON.stringify([value.recordingId, value.sequence])
      : (value.key ?? value.recordingId ?? '');
  const keyOf = (key: unknown) => (Array.isArray(key) ? JSON.stringify(key) : String(key));
  const db = {
    transaction(input: string | string[], mode: string) {
      const names = Array.isArray(input) ? input : [input];
      const local: Record<string, Map<string, StoredRow>> = Object.fromEntries(
        names.map((name) => [name, structuredClone(data[name] ?? new Map<string, StoredRow>())]),
      );
      let aborted = false;
      const tx: MemoryTransaction = {
        abort() {
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name: string) {
          const request = (value?: unknown) => {
            const req: MemoryRequest = { result: structuredClone(value) };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          };
          return {
            get: (key: unknown) => request(requiredStore(local, name).get(keyOf(key))),
            getAll: () => request([...requiredStore(local, name).values()]),
            put: (value: StoredRow) => {
              requiredStore(local, name).set(keyFor(name, value), structuredClone(value));
              return request(keyFor(name, value));
            },
            add(value: StoredRow) {
              if (requiredStore(local, name).has(keyFor(name, value))) throw Error('duplicate key');
              requiredStore(local, name).set(keyFor(name, value), structuredClone(value));
              return request(keyFor(name, value));
            },
            delete: (key: unknown) => {
              requiredStore(local, name).delete(keyOf(key));
              return request();
            },
            index: () => ({
              openCursor(id: string) {
                const entries = [...requiredStore(local, name).entries()].filter(
                  ([, row]) => row.recordingId === id,
                );
                const req: MemoryRequest = {};
                let index = 0;
                const next = () => {
                  queueMicrotask(() => {
                    const entry = entries[index++];
                    req.result = entry
                      ? {
                          delete: () => requiredStore(local, name).delete(entry[0]),
                          continue: next,
                        }
                      : null;
                    req.onsuccess?.({ target: req });
                  });
                };
                next();
                return req;
              },
            }),
          };
        },
      };
      setTimeout(() => {
        if (aborted) return;
        if (mode === 'readwrite') for (const name of names) data[name] = requiredStore(local, name);
        tx.oncomplete?.();
      }, 0);
      return tx;
    },
  };
  h.context['db'] = db;
  h.context['IDBKeyRange'] = { only: (id: unknown) => id };
  return data;
}
export const sampleRow = (recordingId: string = crypto.randomUUID()): Recording => ({
  recordingId,
  title: 'Private title',
  provider: 'meet',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  consent: true,
  liveTranscription: false,
  sampleRate: 16000,
  channels: 1,
  createdAt: new Date().toISOString(),
  libraryId: null,
  chunkCount: 0,
  totalFrames: 0,
  captureState: 'recording',
  transferState: 'saved-local',
  gaps: [],
  interrupted: false,
});

function requiredStore(
  stores: Record<string, Map<string, StoredRow>>,
  name: string,
): Map<string, StoredRow> {
  const store = stores[name];
  if (!store) throw new Error(`Unknown fixture store: ${name}`);
  return store;
}
