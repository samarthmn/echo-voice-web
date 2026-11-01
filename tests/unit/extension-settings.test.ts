import type { TestElement } from '../helpers/elements.ts';
import { connectedLink } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import type { SettingsApi } from '../helpers/extension-test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fixture, bundle, endpoint, library } from '../helpers/extension-test-helpers.ts';
const contents = `import * as settings from './extension/src/settings';import * as secrets from './extension/src/device-secrets';globalThis.api={...settings,...secrets};`;
async function harness(local = {}) {
  const h = fixture<SettingsApi>();
  Object.assign(h.local, structuredClone(local));
  let uuidCalls = 0;
  h.context.crypto = {
    subtle: h.context.crypto.subtle,
    getRandomValues: h.context.crypto.getRandomValues.bind(h.context.crypto),
    randomUUID: () => `installation-${++uuidCalls}`,
  };
  h.uuidCalls = () => uuidCalls;
  const set = h.context.chrome.storage.local.set;
  h.writes = 0;
  h.context.chrome.storage.local.set = async (patch: unknown) => {
    if (h.failNext) {
      h.failNext = false;
      throw new Error('write failed');
    }
    h.writes++;
    return set(object(patch));
  };
  h.api = await bundle(h, contents);
  return h;
}
const pair = { libraryId: library, endpoint, credential: 'existing-credential' };
const preferences = { enabledProviders: ['zoom'], micGranted: true, micDeviceId: 'selected' };
void test('concurrent first reads create one durable installation identity and an empty link', async () => {
  const h = await harness();
  const rows = await Promise.all([h.api.settings(), h.api.settings(), h.api.settings()]);
  assert.equal(new Set(rows.map((row: { installationId: unknown }) => row.installationId)).size, 1);
  assert.equal(h.uuidCalls(), 1);
  assert.equal((await h.api.readLink()).state, 'none');
  assert.equal(defined(h.meta.get('credential-device-key')).extractable, false);
});
void test('pairing v1 plaintext pairs migrate to a sealed connected link; obsolete state is removed', async () => {
  const h = await harness({
    settings: {
      installationId: 'existing',
      endpoint: 'http://localhost:3999',
      activeLibraryId: library,
      pairs: { [library]: pair, other: { ...pair, libraryId: 'other' } },
      ...preferences,
    },
    pairingAttempt: { encrypted: {} },
    pairingCancellation: 'request',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await h.api.settings())) as unknown, {
    installationId: 'existing',
    ...preferences,
    rememberedConsent: [],
    liveTranscription: false,
  });
  assert.deepEqual({ ...(await h.api.readLink()) }, { state: 'connected', ...pair });
  assert.deepEqual(Object.keys(h.local).sort(), ['link', 'settings']);
  assert.ok(!JSON.stringify(h.local).includes('existing-credential'));
  const writes = h.writes;
  await h.api.settings();
  await h.api.readLink();
  assert.equal(h.writes, writes, 'a migrated profile is read without rewriting it');
});
void test('device-sealed v1 pairs migrate; a missing active pair becomes an empty link', async () => {
  const sealed = await harness();
  const encryptedPairs = await sealed.api.sealSecret({ [library]: pair }, 'settings-pairs');
  const h = await harness({
    settings: {
      installationId: 'existing',
      activeLibraryId: library,
      encryptedPairs,
      ...preferences,
    },
  });
  h.meta.set('credential-device-key', defined(sealed.meta.get('credential-device-key')));
  assert.equal(connectedLink(await h.api.readLink()).credential, 'existing-credential');
  assert.equal(object(h.local['settings'])['encryptedPairs'], undefined);
  const none = await harness({
    settings: { installationId: 'existing', activeLibraryId: null, pairs: { [library]: pair } },
  });
  assert.deepEqual({ ...(await none.api.readLink()) }, { state: 'none' });
});
void test('queued provider updates derive their lists from the latest saved state and recover after a failed write', async () => {
  const h = await harness();
  await Promise.all(
    (['meet', 'zoom'] as const).map((provider) =>
      h.api.saveSettings((current: { enabledProviders: ('meet' | 'zoom' | 'teams')[] }) => ({
        enabledProviders: [...current.enabledProviders, provider],
      })),
    ),
  );
  assert.deepEqual(object(h.local['settings'])['enabledProviders'], ['meet', 'zoom']);
  h.failNext = true;
  await assert.rejects(h.api.saveSettings({ micGranted: true }), /write failed/);
  await h.api.saveSettings({ micDeviceId: 'selected' });
  assert.equal(object(h.local['settings'])['micDeviceId'], 'selected');
  assert.deepEqual(object(h.local['settings'])['enabledProviders'], ['meet', 'zoom']);
});
void test('saving a link clears the revoked flag; revoking only matches the current credential', async () => {
  const h = await harness();
  await h.api.saveLink({ state: 'connected', ...pair });
  await h.api.revokeCredential('stale-credential', endpoint);
  assert.equal((await h.api.readLink()).state, 'connected');
  await h.api.revokeCredential(pair.credential, endpoint);
  assert.equal((await h.api.readLink()).state, 'none');
  assert.equal(await h.api.wasRevoked(), true);
  await h.api.saveLink({ state: 'none' });
  assert.equal(await h.api.wasRevoked(), false);
  await assert.rejects(
    h.api.saveLink({ state: 'connected', ...pair, endpoint: 'https://example.invalid' }),
  );
});
void test('an open popup refreshes provider status without resetting an explicit microphone choice', async () => {
  const elements = new Map<string, TestElement>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        value: '',
        checked: false,
        hidden: false,
        className: '',
        append() {},
        replaceChildren() {},
        setAttribute() {},
        addEventListener() {},
      });
    return defined(elements.get(id));
  };
  let enabled: string[] = [];
  let interval: (() => void) | undefined;
  const ui = `export const element=globalThis.element; export async function request(){return {connection:{phase:'none',revoked:false},settings:{enabledProviders:globalThis.providers(),micGranted:false,rememberedConsent:[],liveTranscription:false},active:null,recordings:[]}}; export const renderRecordings=()=>{}; export const showError=error=>{throw error}; export const action=async fn=>fn(); export const duration=()=>'';`;
  const result = await build({
    entryPoints: ['extension/src/popup.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'popup-state',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/ui(?:\.ts)?$/ }, () => ({
            path: 'ui',
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: ui }));
        },
      },
    ],
  });
  const context = {
    URL,
    element,
    providers: () => enabled,
    setInterval: (callback: () => void) => {
      interval = callback;
    },
    document: { createElement: () => ({}), getElementById: () => null },
    chrome: {
      permissions: { contains: async () => true },
      tabs: {
        query: async () => [
          { id: 1, url: 'https://meet.google.com/abc-defg-hij', title: 'Meeting' },
        ],
      },
    },
    navigator: {
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: { enumerateDevices: async () => [] },
    },
  };
  vm.runInNewContext(defined(result.outputFiles[0]).text, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element('meeting').textContent, /Not enabled/);
  element('mic').checked = false;
  enabled = ['meet'];
  defined(interval)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element('meeting').textContent, /Enabled/);
  assert.equal(element('mic').checked, false);
});
void test('overlapping first popup refreshes cannot re-enable a microphone explicitly excluded by the user', async () => {
  const elements = new Map<string, TestElement>();
  const element = (id: string) => {
    if (!elements.has(id))
      elements.set(id, {
        textContent: '',
        value: '',
        checked: false,
        hidden: false,
        className: '',
        listeners: {},
        append() {},
        replaceChildren() {},
        setAttribute() {},
        addEventListener(name: string, callback: () => unknown) {
          defined(this.listeners)[name] = callback;
        },
      });
    return defined(elements.get(id));
  };
  let interval: (() => void) | undefined;
  const queries: ((arg0: { id: number; url: string; title: string }[]) => void)[] = [];
  const ui = `export const element=globalThis.element; export async function request(){return {connection:{phase:'none',revoked:false},settings:{enabledProviders:['meet'],micGranted:true,rememberedConsent:[],liveTranscription:false},active:null,recordings:[]}}; export const renderRecordings=()=>{}; export const showError=error=>{throw error}; export const action=async fn=>fn(); export const duration=()=>'';`;
  const result = await build({
    entryPoints: ['extension/src/popup.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'popup-delayed-init',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/ui(?:\.ts)?$/ }, () => ({
            path: 'ui',
            namespace: 'mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: ui }));
        },
      },
    ],
  });
  vm.runInNewContext(defined(result.outputFiles[0]).text, {
    URL,
    element,
    setInterval: (callback: () => void) => {
      interval = callback;
    },
    document: { createElement: () => ({}), getElementById: () => null },
    chrome: {
      permissions: { contains: async () => true },
      tabs: { query: () => new Promise((resolve) => queries.push(resolve)) },
    },
    navigator: {
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: { enumerateDevices: async () => [] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  defined(interval)();
  await new Promise((resolve) => setImmediate(resolve));
  defined(queries[0])([{ id: 1, url: 'https://meet.google.com/abc-defg-hij', title: 'Meeting' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('mic').checked, true);
  element('mic').checked = false;
  defined(defined(element('mic').listeners)['change'])();
  for (const resolve of queries.slice(1))
    resolve([{ id: 1, url: 'https://meet.google.com/abc-defg-hij', title: 'Meeting' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('mic').checked, false);
  assert.equal(element('start').textContent, 'Record call audio only');
  assert.equal(queries.length, 1);
});
