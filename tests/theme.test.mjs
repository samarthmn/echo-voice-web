import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8').replace(/export function /g, 'function ');
function appearance(storage) {
  const listeners = {};
  const media = { matches: false, addEventListener: (type, handler) => { listeners.media = handler; } };
  const context = {
    localStorage: storage,
    document: { documentElement: { dataset: {} }, querySelector: () => null },
    matchMedia: () => media,
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } },
    window: { dispatchEvent() {}, addEventListener: (type, handler) => { listeners[type] = handler; } },
  };
  runInNewContext(source, context);
  return { api: context.window.echoTheme, media, listeners };
}
test('manual appearance survives operating-system changes when storage is unavailable', () => {
  const { api, media, listeners } = appearance({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  assert.equal(api.current(), 'light');
  api.set('dark');
  media.matches = true; listeners.media();
  media.matches = false; listeners.media();
  assert.equal(api.current(), 'dark');
});
test('appearance follows the system until saved and synchronizes cross-tab resets', () => {
  let saved = null;
  const { api, media, listeners } = appearance({ getItem: () => saved, setItem: (_, value) => { saved = value; } });
  media.matches = true; listeners.media();
  assert.equal(api.current(), 'dark');
  api.set('light'); listeners.media();
  assert.equal(api.current(), 'light');
  saved = 'dark'; listeners.storage({ key: 'echo-theme' });
  assert.equal(api.current(), 'dark');
  saved = null; media.matches = false; listeners.storage({ key: null });
  assert.equal(api.current(), 'light');
  media.matches = true; listeners.media();
  assert.equal(api.current(), 'dark');
});
