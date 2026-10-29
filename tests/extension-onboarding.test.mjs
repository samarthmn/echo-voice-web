import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import vm from 'node:vm';
const requestId = '11111111-1111-4111-8111-111111111111';
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fakeElement(hidden = false) {
  return {
    textContent: '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    hidden,
    open: true,
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
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
  };
}
function elements(hidden) {
  const map = new Map();
  return (id) => {
    if (!map.has(id)) map.set(id, fakeElement(hidden));
    return map.get(id);
  };
}
const page = {
  createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null,
};
test('setup has three steps — Connect, Meeting sites, Microphone — and no recovery phrase', async () => {
  const html = await readFile('extension/setup.html', 'utf8');
  const steps = [...html.matchAll(/<strong>(\d) · ([^<]+)<\/strong/g)].map((match) => match[2]);
  assert.deepEqual(steps, ['Connect to Echo', 'Meeting sites', 'Microphone']);
  assert.match(html, /<details id="advanced">/);
  assert.ok(html.indexOf('id="connect"') < html.indexOf('id="providers"'));
  assert.ok(html.indexOf('id="endpoint"') > html.indexOf('id="advanced"'));
  assert.match(html, /Record call audio only/);
  // The only phrase field is the migration unlock for pre-v3 recordings: hidden until such
  // recordings exist, and outside the setup steps.
  const legacy =
    /<div id="legacy-unlock" class="notice" hidden>[\s\S]*?<\/textarea[\s\S]*?<\/div>/.exec(html);
  assert.ok(legacy, 'legacy unlock starts hidden');
  assert.ok(html.indexOf('id="legacy-unlock"') > html.indexOf('id="microphone-step"'));
  assert.doesNotMatch(html.replace(legacy[0], ''), /phrase|pairing code|confirm-library/i);
  const popup = await readFile('extension/popup.html', 'utf8');
  assert.match(popup, /Recordings are saved in this browser until you connect/);
});
test('approval page never approves on load, renders labels as text, and tells the extension after Allow', async () => {
  const buildResult = await build({
    entryPoints: ['web/extension-connect.js'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  const element = elements(false);
  const calls = [];
  const messages = [];
  const context = {
    URLSearchParams,
    location: { hash: `#request=${requestId}&return=https://example.invalid` },
    document: { getElementById: element },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === '/js/extension-id.json')
        return { ok: true, json: async () => ({ id: 'poonbmodjfijfbfiopememgfijahgbag' }) };
      return {
        ok: true,
        json: async () => ({
          requestId,
          name: '<img src=x onerror=alert(1)>',
          origin: 'chrome-extension://poonbmodjfijfbfiopememgfijahgbag',
          status: options?.method === 'POST' ? 'approved' : 'pending',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        }),
      };
    },
    chrome: {
      runtime: {
        sendMessage: (id, message, callback) => {
          messages.push({ id, message });
          callback();
        },
      },
    },
    setInterval: () => {},
    Date,
  };
  vm.runInNewContext(buildResult.outputFiles[0].text, context);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(element('browser-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(
    element('connection-heading').textContent,
    'Allow this browser to send recordings to Echo?',
  );
  assert.equal(element('approval-actions').hidden, false);
  element('approve').listeners.click();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(calls[1].url, `/api/extensions/requests/${requestId}/approve`);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(element('connection-heading').textContent, 'Browser connected');
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { id: 'poonbmodjfijfbfiopememgfijahgbag', message: { type: 'ECHO_APPROVED', requestId } },
  ]);
});
test('popup checks actual host and microphone permission before enabling Start', async () => {
  const element = elements(false);
  let hostGranted = false;
  let interval;
  const result = await build({
    entryPoints: ['extension/src/popup.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'ui',
        setup(b) {
          b.onResolve({ filter: /^\.\/ui$/ }, () => ({ path: 'ui', namespace: 'mock' }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: `export const element=globalThis.element;export const request=async()=>({connection:{phase:'none',revoked:false},settings:{enabledProviders:['meet'],micGranted:true,rememberedConsent:[],liveTranscription:false},active:null,recordings:[]});export const renderRecordings=()=>{};export const lockedNotice=()=>{};export const showError=error=>{throw error};export const action=fn=>fn();export const duration=()=>'';`,
          }));
        },
      },
    ],
  });
  vm.runInNewContext(result.outputFiles[0].text, {
    URL,
    element,
    setInterval: (fn) => {
      interval = fn;
    },
    document: page,
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://meet.google.com/abc-defg-hij' }] },
      permissions: { contains: async () => hostGranted },
    },
    navigator: {
      permissions: { query: async () => ({ state: 'denied' }) },
      mediaDevices: { enumerateDevices: async () => [] },
    },
  });
  await settle();
  element('consent').checked = true;
  element('consent').listeners.change();
  assert.equal(element('start').disabled, true);
  hostGranted = true;
  interval();
  await settle();
  element('mic').checked = true;
  element('mic').listeners.change();
  assert.equal(
    element('start').disabled,
    true,
    'saved micGranted does not override revoked permission',
  );
  element('mic').checked = false;
  element('mic').listeners.change();
  assert.equal(element('start').disabled, false, 'not being connected never blocks Start');
});
test('setup submits Cancel immediately while a state refresh is still waiting', async () => {
  const element = elements(true);
  const calls = [];
  const intervals = new Map();
  let hold;
  let phase = 'waiting';
  const result = await build({
    entryPoints: ['extension/src/setup.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [
      {
        name: 'setup-ui',
        setup(b) {
          b.onResolve({ filter: /^\.\/(ui|storage)$/ }, (args) => ({
            path: args.path,
            namespace: 'mock',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: args.path.endsWith('/ui')
              ? 'export const element=globalThis.element;export const request=globalThis.request;export const showError=e=>{throw e};export const action=fn=>fn();export const renderRecordings=()=>{};export const lockedNotice=()=>{};'
              : 'export const recording=async()=>undefined;export async function* exportParts(){}',
          }));
        },
      },
    ],
  });
  const view = () => ({ phase, endpoint: 'http://127.0.0.1:3111', requestId, revoked: false });
  const context = {
    URL,
    URLSearchParams,
    location: { hash: '' },
    element,
    setInterval(callback, ms) {
      intervals.set(ms, callback);
    },
    window: { addEventListener() {} },
    document: page,
    navigator: { permissions: { query: async () => ({ state: 'denied' }) } },
    chrome: {
      storage: { local: { get: async () => ({}) } },
      permissions: { contains: async () => false },
    },
    request: async (message) => {
      calls.push(message.type);
      if (message.type === 'PAIR_CANCEL') {
        phase = 'none';
        return view();
      }
      if (message.type === 'CONNECTION_STATUS') return { status: phase };
      if (message.type === 'CONNECT_REQUEST') return undefined;
      if (hold) await hold;
      return {
        settings: { enabledProviders: [], micGranted: false },
        recordings: [],
        connection: view(),
      };
    },
  };
  vm.runInNewContext(result.outputFiles[0].text, context);
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(element('connection-title').textContent, 'Click Allow in the Echo tab');
  assert.equal(element('cancel-connect').hidden, false);
  let release;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  intervals.get(2000)();
  await settle();
  element('cancel-connect').listeners.click();
  await settle();
  assert.ok(calls.includes('PAIR_CANCEL'), 'Cancel must not wait for the held state request');
  release();
  hold = undefined;
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(element('connection-title').textContent, 'Connect to Echo');
});
