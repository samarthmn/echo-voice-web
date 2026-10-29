import vm from 'node:vm';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
export const library = '22222222-2222-4222-8222-222222222222';
export const endpoint = 'http://127.0.0.1:3111';
export const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
export function locks() {
  const queue = new Map();
  return {
    request(id, _options, work) {
      const next = (queue.get(id) ?? Promise.resolve()).then(work);
      queue.set(
        id,
        next.catch(() => {}),
      );
      return next;
    },
  };
}
export function fixture() {
  const h = {
    local: {},
    session: {},
    meta: new Map(),
    calls: [],
    tabs: [],
    removed: [],
    now: Date.now(),
  };
  const area = (store) => ({
    setAccessLevel: async () => {},
    get: async (keys) =>
      Object.fromEntries(
        (typeof keys === 'string' ? [keys] : (keys ?? Object.keys(store))).map((key) => [
          key,
          structuredClone(store[key]),
        ]),
      ),
    set: async (patch) => Object.assign(store, structuredClone(patch)),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
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
      static now() {
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
        create: async (tab) => {
          const value = { ...tab, id: h.tabs.length + 1 };
          h.tabs.push(value);
          return value;
        },
        update: async () => {},
        get: async (id) => h.tabs.find((tab) => tab.id === id),
        remove: async (id) => h.removed.push(id),
      },
      windows: { update: async () => {} },
    },
    fetch: (...args) => {
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
export async function bundle(h, contents, mocks = {}) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'fixture',
        setup(b) {
          b.onResolve({ filter: /^\.\/vault-db$/ }, () => ({
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
  vm.runInNewContext(result.outputFiles[0].text, h.context);
  return h.context.api;
}
export const pairingBundle = `import * as pairing from './extension/src/pairing';import * as discovery from './extension/src/discovery';import * as settings from './extension/src/settings';import * as connection from './extension/src/connection';import {externalMessage} from './extension/src/external-messages';import {jsonRequest} from './extension/src/protocol';globalThis.api={...pairing,...discovery,...settings,...connection,externalMessage,jsonRequest};`;
// Minimal asynchronous IDB shim. Transactions commit cloned stores together;
// requests/cursors run before completion, and aborted writes never publish.
export function memoryDatabase(h) {
  const data = { recordings: new Map(), chunks: new Map(), meta: new Map() };
  const keyFor = (name, value) =>
    name === 'chunks'
      ? JSON.stringify([value.recordingId, value.sequence])
      : (value.key ?? value.recordingId);
  const keyOf = (key) => (Array.isArray(key) ? JSON.stringify(key) : key);
  const db = {
    transaction(names, mode) {
      names = Array.isArray(names) ? names : [names];
      const local = Object.fromEntries(names.map((name) => [name, structuredClone(data[name])]));
      let aborted = false;
      const tx = {
        abort() {
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name) {
          const request = (value) => {
            const req = { result: structuredClone(value) };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          };
          return {
            get: (key) => request(local[name].get(keyOf(key))),
            getAll: () => request([...local[name].values()]),
            put: (value) => {
              local[name].set(keyFor(name, value), structuredClone(value));
              return request(keyFor(name, value));
            },
            add(value) {
              if (local[name].has(keyFor(name, value))) throw Error('duplicate key');
              local[name].set(keyFor(name, value), structuredClone(value));
              return request(keyFor(name, value));
            },
            delete: (key) => {
              local[name].delete(keyOf(key));
              return request();
            },
            index: () => ({
              openCursor(id) {
                const entries = [...local[name].entries()].filter(
                  ([, row]) => row.recordingId === id,
                );
                const req = {};
                let index = 0;
                const next = () =>
                  queueMicrotask(() => {
                    const entry = entries[index++];
                    req.result = entry
                      ? { delete: () => local[name].delete(entry[0]), continue: next }
                      : null;
                    req.onsuccess?.({ target: req });
                  });
                next();
                return req;
              },
            }),
          };
        },
      };
      setTimeout(() => {
        if (aborted) return;
        if (mode === 'readwrite') for (const name of names) data[name] = local[name];
        tx.oncomplete?.();
      }, 0);
      return tx;
    },
  };
  h.context.db = db;
  h.context.IDBKeyRange = { only: (id) => id };
  return data;
}
export const sampleRow = (recordingId = crypto.randomUUID()) => ({
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
