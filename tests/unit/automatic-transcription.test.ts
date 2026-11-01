import type * as BridgeModule from '../../web/bridge.ts';
import { moduleExports, text } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { TRANSCRIPTION_CANCELLED } from '../../web/automatic-transcription.ts';
const turbo = 'onnx-community/whisper-large-v3-turbo';
const meeting = (id: string) => ({
  id,
  status: 'saved',
  speechModel: turbo,
  transcripts: [],
  tracks: [{ id: 'audio', bytes: 32000 }],
});
const built = await build({
  entryPoints: ['web/bridge.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'bridge',
  plugins: [
    {
      name: 'browser-services',
      setup(b) {
        b.onResolve(
          {
            filter:
              /^\.\/(theme|inference|notes|files|recorder|accessibility|extension-workspace|extension-live)\.ts$/,
          },
          () => ({ path: 'side-effects', namespace: 'mock' }),
        );
        b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          contents: 'export const installExtensionLive=()=>{};',
        }));
      },
    },
  ],
});
type Row = ReturnType<typeof meeting> & { autoTranscribeSuppressed?: boolean; error?: string };
function harness(
  rows: Map<string, Row>,
  transcribe: (...args: unknown[]) => Promise<void> = async () => {},
) {
  const window = Object.assign(new EventTarget(), {
    echoInference: {
      getDownloadedModels: async () => [turbo],
      transcribeMeeting: async (..._args: unknown[]) => {},
      suppressAutomaticTranscription: async (_ids: string[]) => {},
    },
  });
  const calls: unknown[][] = [];
  window.echoInference = {
    getDownloadedModels: async () => [turbo],
    transcribeMeeting: async (...args: unknown[]) => {
      calls.push(args);
      return transcribe(...args);
    },
    suppressAutomaticTranscription: async (ids: string[]) => {
      for (const id of ids) defined(rows.get(id)).autoTranscribeSuppressed = true;
    },
  };
  const context = {
    window,
    CustomEvent,
    Event,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (path: string) =>
      Response.json(
        path === '/api/settings'
          ? { autoTranscribe: true, speechModel: turbo }
          : rows.get(decodeURIComponent(defined(path.split('/').at(-1)))),
      ),
  };
  vm.runInNewContext(defined(built.outputFiles[0]).text, context);
  return {
    api: moduleExports<typeof BridgeModule>(Reflect.get(context, 'bridge'), [
      'autoTranscribeMeeting',
    ]),
    window,
    calls,
  };
}
void test('a completed import cancelled previously stays suppressed across fresh workspace controllers', async () => {
  for (const cancelled of [
    { ...meeting('cancelled'), autoTranscribeSuppressed: true },
    { ...meeting('legacy'), error: TRANSCRIPTION_CANCELLED },
  ]) {
    const rows = new Map([[cancelled.id, cancelled]]);
    for (let reload = 0; reload < 2; reload++) {
      const h = harness(rows);
      await h.api.autoTranscribeMeeting(structuredClone(cancelled));
      assert.equal(h.calls.length, 0);
    }
  }
});
void test('automatic queue rechecks durable cancellation instead of trusting an old import event', async () => {
  const original = meeting('stale');
  const rows = new Map([['stale', { ...original, autoTranscribeSuppressed: true }]]);
  const h = harness(rows);
  await h.api.autoTranscribeMeeting(original);
  assert.equal(h.calls.length, 0);
});
void test('new eligible imports still process once and are marked automatic', async () => {
  const row = meeting('new');
  const h = harness(new Map([['new', row]]));
  await h.api.autoTranscribeMeeting(row);
  await h.api.autoTranscribeMeeting(row);
  assert.equal(h.calls.length, 1);
  assert.equal(object(defined(h.calls[0])[3])['automatic'], true);
});
void test('unsupported saved model is rejected before download guidance or inference', async () => {
  const row = { ...meeting('unsupported'), speechModel: 'unsupported/custom-model' };
  const h = harness(new Map([[row.id, row]]));
  const skipped: unknown[] = [];
  let downloadChecks = 0;
  h.window.addEventListener('echo-auto-transcription-skipped', (event) => {
    assert.ok(event instanceof CustomEvent);
    skipped.push(event.detail as unknown);
  });
  h.window.echoInference.getDownloadedModels = async () => {
    downloadChecks++;
    return [turbo];
  };
  await h.api.autoTranscribeMeeting(row);
  assert.equal(downloadChecks, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(object(skipped[0])['reason'], 'processing-unavailable');
  assert.match(text(object(skipped[0])['message']), /Choose one of the supported speech models/);
});
void test('retired speech selections still resolve to Turbo for automatic transcription', async () => {
  const row = { ...meeting('retired'), speechModel: 'onnx-community/whisper-tiny.en' };
  const h = harness(new Map([[row.id, row]]));
  await h.api.autoTranscribeMeeting(row);
  assert.equal(h.calls.length, 1);
  assert.equal(defined(h.calls[0])[1], turbo);
});
void test('a generic previous processing error does not permanently suppress automatic processing', async () => {
  const row = { ...meeting('retryable'), error: 'The local server was temporarily unavailable.' };
  const h = harness(new Map([[row.id, row]]));
  await h.api.autoTranscribeMeeting(row);
  assert.equal(h.calls.length, 1);
});
void test('Cancel all suppresses queued automatic jobs before they start and remains durable on reload', async () => {
  const first = meeting('one'),
    second = meeting('two');
  const rows = new Map([
    ['one', first],
    ['two', second],
  ]);
  let release: (() => void) | undefined;
  const h = harness(
    rows,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const one = h.api.autoTranscribeMeeting(first);
  const two = h.api.autoTranscribeMeeting(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  h.window.dispatchEvent(
    new CustomEvent('echo-transcription-cancelled', { detail: { meetingIds: ['one'] } }),
  );
  defined(release)();
  await one;
  await two;
  assert.equal(h.calls.length, 1);
  const reloaded = harness(rows);
  await reloaded.api.autoTranscribeMeeting(second);
  assert.equal(reloaded.calls.length, 0);
});
