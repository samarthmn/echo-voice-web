import { array } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessingHeartbeat } from '../../web/processing-heartbeat.ts';

const timers = () => {
  const callbacks = new Map<number, () => void>();
  let counter = 0;
  return {
    callbacks,
    schedule(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 10000);
      callbacks.set(++counter, callback);
      return counter;
    },
    unschedule(id: number | ReturnType<typeof setInterval>) {
      if (typeof id === 'number') callbacks.delete(id);
    },
  };
};

void test('server restart reconciliation claims only pending browser jobs and stops after terminal jobs', async () => {
  const clock = timers(),
    requests: unknown = [],
    restored: unknown = [];
  const heartbeat = createProcessingHeartbeat({
    ...clock,
    async request(ids) {
      array(requests).push(ids);
      return { restored: [...ids, 'abandoned-server-job'] };
    },
    onRestore: (ids) => array(restored).push(ids),
  });
  heartbeat.start('active');
  heartbeat.start('queued');
  assert.equal(clock.callbacks.size, 1);
  await heartbeat.pulse();
  assert.deepEqual(requests, [['active', 'queued']]);
  assert.deepEqual(restored, [['active', 'queued']]);
  heartbeat.stop('active');
  await heartbeat.pulse();
  assert.deepEqual(requests.at(-1), ['queued']);
  heartbeat.stop('queued');
  assert.equal(clock.callbacks.size, 0);
  await heartbeat.pulse();
  assert.equal(requests.length, 2);
});

void test('temporary server loss preserves pending workers and retries without overlapping requests', async () => {
  const clock = timers();
  let calls = 0,
    release: ((value: { restored?: string[] }) => void) | undefined;
  const heartbeat = createProcessingHeartbeat({
    ...clock,
    async request() {
      if (++calls === 1) throw new TypeError('Failed to fetch');
      return await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  heartbeat.start('active');
  await heartbeat.pulse();
  const retry = heartbeat.pulse();
  await heartbeat.pulse();
  assert.equal(calls, 2);
  defined(release)({ restored: ['active'] });
  await retry;
  assert.equal(clock.callbacks.size, 1);
  heartbeat.clear();
});

void test('cancel all aborts the heartbeat and a late response cannot announce restored jobs', async () => {
  const clock = timers();
  let release: ((value: { restored?: string[] }) => void) | undefined,
    signal: AbortSignal | undefined;
  const restored: unknown = [];
  const heartbeat = createProcessingHeartbeat({
    ...clock,
    request(_ids, current) {
      signal = current;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onRestore: (ids) => array(restored).push(ids),
  });
  heartbeat.start('active');
  const pending = heartbeat.pulse();
  heartbeat.clear();
  assert.equal(defined(signal).aborted, true);
  assert.equal(clock.callbacks.size, 0);
  defined(release)({ restored: ['active'] });
  await pending;
  assert.deepEqual(restored, []);
});

void test('large pending sets use bounded batches and rotate through every meeting', async () => {
  const clock = timers(),
    batches: string[][] = [];
  const heartbeat = createProcessingHeartbeat({
    ...clock,
    async request(ids) {
      batches.push(ids);
      return { restored: [] };
    },
  });
  for (let i = 0; i < 205; i++) heartbeat.start(String(i));
  await heartbeat.pulse();
  await heartbeat.pulse();
  await heartbeat.pulse();
  assert.deepEqual(
    batches.map((ids) => ids.length),
    [100, 100, 5],
  );
  assert.equal(new Set(batches.flat()).size, 205);
  heartbeat.clear();
});
