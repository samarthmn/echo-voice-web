import { moduleExports, defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = transformSync(readFileSync(new URL('../../web/theme.ts', import.meta.url), 'utf8'), {
  loader: 'ts',
  format: 'iife',
}).code;
function appearance(storage: {
  getItem: () => unknown;
  setItem: (key: string, value: string) => void;
}) {
  const listeners: Record<string, (event?: { key: string | null }) => void> = {};
  const media = {
    matches: false,
    addEventListener: (_type: string, handler: () => void) => {
      listeners['media'] = handler;
    },
  };
  const context = {
    localStorage: storage,
    document: { documentElement: { dataset: {} }, querySelector: () => null },
    matchMedia: () => media,
    CustomEvent: class {
      type: unknown;
      detail: unknown;
      constructor(type: unknown, detail: unknown) {
        this.type = type;
        this.detail = detail;
      }
    },
    window: {
      dispatchEvent() {},
      addEventListener: (type: string, handler: (event?: { key: string | null }) => void) => {
        listeners[type] = handler;
      },
    },
  };
  runInNewContext(source, context);
  return {
    api: moduleExports<Window['echoTheme']>(Reflect.get(context.window, 'echoTheme'), [
      'current',
      'set',
    ]),
    media,
    listeners,
  };
}
test('manual appearance survives operating-system changes when storage is unavailable', () => {
  const { api, media, listeners } = appearance({
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
  });
  assert.equal(api.current(), 'light');
  api.set('dark');
  media.matches = true;
  defined(listeners['media'])();
  media.matches = false;
  defined(listeners['media'])();
  assert.equal(api.current(), 'dark');
});
test('appearance follows the system until saved and synchronizes cross-tab resets', () => {
  let saved: string | null = null;
  const { api, media, listeners } = appearance({
    getItem: () => saved,
    setItem: (_: unknown, value: string) => {
      saved = value;
    },
  });
  media.matches = true;
  defined(listeners['media'])();
  assert.equal(api.current(), 'dark');
  api.set('light');
  defined(listeners['media'])();
  assert.equal(api.current(), 'light');
  saved = 'dark';
  defined(listeners['storage'])({ key: 'echo-theme' });
  assert.equal(api.current(), 'dark');
  saved = null;
  media.matches = false;
  defined(listeners['storage'])({ key: null });
  assert.equal(api.current(), 'light');
  media.matches = true;
  defined(listeners['media'])();
  assert.equal(api.current(), 'dark');
});
