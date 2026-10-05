import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmThreadCount } from '../web/runtime-options.js';

test('WASM remains single threaded when the document is not isolated', () => {
  for (const cores of [2, 8, 32]) assert.equal(wasmThreadCount(false, cores), 1);
});

test('isolated WASM uses at most four threads and leaves half the reported cores available', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [4, 2], [6, 3], [8, 4], [32, 4]]) {
    assert.equal(wasmThreadCount(true, cores), expected);
  }
});

test('unknown or invalid hardware concurrency safely uses one thread', () => {
  for (const cores of [undefined, null, '8', NaN, Infinity, -4]) assert.equal(wasmThreadCount(true, cores), 1);
});
