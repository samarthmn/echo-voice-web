import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, rmdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { writeAssetManifest } from '../scripts/asset-manifest.mjs';

test('fingerprints change with WASM bytes independently of JavaScript and are included in packaged assets', async () => {
  const scratchRoot = resolve('tmp');
  await mkdir(scratchRoot, { recursive: true });
  const fixture = await mkdtemp(join(scratchRoot, 'asset-manifest-test-'));
  try {
    await mkdir(join(fixture, 'assets'));
    await mkdir(join(fixture, 'js'));
    await writeFile(join(fixture, 'assets/echo_app.js'), 'export default function init() {}');
    await writeFile(join(fixture, 'assets/echo_app_bg.wasm'), 'first WASM build');
    await writeFile(join(fixture, 'js/bridge.js'), 'window.echo = {};');
    const first = await writeAssetManifest(fixture);
    assert.match(first['/assets/echo_app_bg.wasm'], /^[a-f0-9]{64}$/);
    await writeFile(join(fixture, 'assets/echo_app_bg.wasm'), 'second WASM build');
    const second = await writeAssetManifest(fixture);
    assert.notEqual(second['/assets/echo_app_bg.wasm'], first['/assets/echo_app_bg.wasm']);
    assert.equal(second['/assets/echo_app.js'], first['/assets/echo_app.js']);
    assert.deepEqual(JSON.parse(await readFile(join(fixture, 'js/asset-manifest.json'), 'utf8')), second);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rmdir(scratchRoot).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
});

test('public roots with trailing separators preserve full nested asset URL names', async () => {
  const scratchRoot = resolve('tmp');
  await mkdir(scratchRoot, { recursive: true });
  const fixture = await mkdtemp(join(scratchRoot, 'asset-manifest-trailing-separator-'));
  try {
    await mkdir(join(fixture, 'assets'));
    await writeFile(join(fixture, 'assets/echo_app_bg.wasm'), 'same WASM bytes');
    await writeFile(join(fixture, 'theme.css'), ':root { color: black; }');
    const plain = await writeAssetManifest(fixture);
    const trailing = await writeAssetManifest(fixture + sep);
    assert.deepEqual(trailing, plain);
    assert.deepEqual(Object.keys(trailing).sort(), ['/assets/echo_app_bg.wasm', '/theme.css']);
    assert.deepEqual(JSON.parse(await readFile(join(fixture, 'js/asset-manifest.json'), 'utf8')), trailing);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rmdir(scratchRoot).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
});

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const loaderSource = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const runLoader = new (Object.getPrototypeOf(async function () {}).constructor)(
  'fetch', 'window', 'document', 'loadModule', loaderSource.replaceAll('import(', 'loadModule('),
);

test('the real HTML loader waits for the bridge and independently versions wrapper, WASM, and styles', async () => {
  const versions = Object.fromEntries([
    ['/js/bridge.js', '1'], ['/assets/echo_app.js', '2'],
    ['/assets/echo_app_bg.wasm', '3'], ['/theme.css', '4'],
  ].map(([path, digit]) => [path, digit.repeat(64)]));
  const calls = [];
  const window = {};
  const main = { replaceChildren() { calls.push('clear'); } };
  const stylesheet = { href: 'http://localhost:3000/theme.css' };
  await runLoader(async (path, options) => {
    assert.equal(path, '/js/asset-manifest.json');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => versions };
  }, window, { querySelectorAll: () => [stylesheet], getElementById: () => main }, async path => {
    calls.push(path);
    if (path.startsWith('/js/bridge.js')) return {};
    return { default: async options => { calls.push(options.module_or_path); } };
  });
  assert.equal(window.echoAssetVersions, versions);
  assert.equal(stylesheet.href, `/theme.css?v=${'4'.repeat(64)}`);
  assert.deepEqual(calls, [
    `/js/bridge.js?v=${'1'.repeat(64)}`, `/assets/echo_app.js?v=${'2'.repeat(64)}`,
    'clear', `/assets/echo_app_bg.wasm?v=${'3'.repeat(64)}`,
  ]);
});

test('the HTML loader exposes a retry screen if a required fingerprint is missing', async () => {
  const main = {};
  await runLoader(async () => ({ ok: true, json: async () => ({}) }), {},
    { querySelectorAll: () => [], getElementById: () => main },
    async () => { assert.fail('Unversioned assets must never be imported.'); });
  assert.match(main.innerHTML, /Echo couldn’t start/);
});
