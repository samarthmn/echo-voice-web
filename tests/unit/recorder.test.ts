import { object, text, form } from '../helpers/assertions.ts';
import type { Meeting } from '../../web/types/domain.ts';
import { array } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import { installGlobal } from '../helpers/assertions.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecorderController } from '../../web/recorder.ts';

let now = 0;
let current: Recorder;
let constraints: { audio: { deviceId: unknown } };
class Track extends EventTarget {
  enabled = true;
  readyState = 'live';
  stop() {
    this.readyState = 'ended';
  }
}
class Recorder extends EventTarget {
  stream: unknown;
  timeslice: unknown;
  static isTypeSupported(type: string | string[]) {
    return type.includes('webm');
  }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  constructor(stream: unknown) {
    super();
    this.stream = stream;
    current = this;
  }
  start(timeslice: unknown) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  chunk(text: BlobPart) {
    const event = Object.assign(new Event('dataavailable'), {
      data: new Blob([text], { type: this.mimeType }),
    });
    this.dispatchEvent(event);
  }
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.chunk('final');
      this.dispatchEvent(new Event('stop'));
    }, 0);
  }
}
function environment() {
  now = 0;
  const window = Object.assign(new EventTarget(), { isSecureContext: true });
  installGlobal('window', window);
  installGlobal('MediaRecorder', Recorder);
  installGlobal('cancelAnimationFrame', () => {});
  installGlobal('performance', { now: () => now });
  const track = new Track();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (options: typeof constraints) => {
          constraints = options;
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
  });
  return track;
}
const meeting: Meeting = {
  id: 'meeting-1',
  consent: true,
  gaps: [],
  status: 'saved',
  tracks: [],
  transcripts: [],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('captures only after explicit start, serializes chunks, excludes paused duration, and logs mute gaps', async () => {
  const track = environment();
  const calls: Record<string, unknown>[] = [];
  let pending = 0;
  const controller = createRecorderController({
    request: async (_path, options) => {
      if (options.method === 'POST') {
        assert.equal(pending++, 0);
        await tick();
        pending--;
        calls.push({
          sequence: form(options.body).get('sequence'),
          trackId: form(options.body).get('trackId'),
        });
        return {};
      }
      const body = object(JSON.parse(text(options.body)) as unknown);
      if (body['status'] === 'recording') return { ...meeting, ...body };
      calls.push(body);
      return { ...meeting, ...body };
    },
  });
  assert.equal(controller.state.status, 'idle');
  await controller.start({ meeting, deviceId: 'specific-mic', startMuted: true });
  assert.deepEqual(constraints.audio.deviceId, { exact: 'specific-mic' });
  assert.equal(current.timeslice, 5000);
  assert.equal(track.enabled, false);
  now = 1000;
  controller.toggleMute();
  assert.equal(track.enabled, true);
  current.chunk('first');
  controller.pause();
  now = 61000;
  controller.resume();
  now = 63000;
  const save = controller.stop();
  assert.equal(controller.state.status, 'saving');
  assert.equal(controller.stop(), save);
  const result = await save;
  assert.equal(result.duration, 3);
  assert.equal(result.status, 'saved');
  assert.deepEqual(result.gaps, [{ start: 0, end: 1, reason: 'Microphone muted' }]);
  assert.deepEqual(
    calls.slice(0, 2).map((x) => x['sequence']),
    ['0', '1'],
  );
  assert.equal(defined(calls[0])['trackId'], defined(calls[1])['trackId']);
  assert.equal(controller.state.status, 'idle');
  assert.equal(track.readyState, 'ended');
  controller.dispose();
});

test('failed audio upload stops capture and retains the failing and final chunks for retry', async () => {
  const track = environment();
  let failing = true;
  const sequences: unknown = [];
  const controller = createRecorderController({
    request: async (_path, options) => {
      if (options.method === 'POST') {
        array(sequences).push(form(options.body).get('sequence'));
        if (failing) {
          const e = new Error('disk full');
          Object.assign(e, { status: 507 });
          throw e;
        }
        return {};
      }
      return { ...meeting, ...object(JSON.parse(text(options.body)) as unknown) };
    },
  });
  await controller.start({ meeting });
  now = 5000;
  current.chunk('first');
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(controller.state.status, 'error');
  assert.equal(track.readyState, 'ended');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  failing = false;
  const result = await controller.retry();
  assert.deepEqual(sequences, ['0', '0', '0', '0', '1']);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.duration, 5);
  controller.dispose();
});

test('a failed final metadata save can be retried without reuploading acknowledged audio', async () => {
  environment();
  let patches = 0,
    uploads = 0;
  const controller = createRecorderController({
    request: async (_path, options) => {
      if (options.method === 'POST') {
        uploads++;
        return {};
      }
      if (object(JSON.parse(text(options.body)) as unknown)['status'] === 'recording')
        return meeting;
      if (++patches === 1) throw new Error('temporary failure');
      return { ...meeting, ...object(JSON.parse(text(options.body)) as unknown) };
    },
  });
  await controller.start({ meeting });
  now = 3000;
  await assert.rejects(controller.stop(), /temporary failure/);
  assert.equal(controller.state.status, 'error');
  await controller.retry();
  assert.equal(uploads, 1);
  assert.equal(patches, 2);
  controller.dispose();
});

test('a disconnected microphone saves the final chunk as interrupted', async () => {
  const track = environment();
  let result: (Pick<Meeting, 'id'> & Partial<Meeting>) | undefined;
  const controller = createRecorderController({
    request: async (_path, options) =>
      options.method === 'POST'
        ? {}
        : { ...meeting, ...object(JSON.parse(text(options.body)) as unknown) },
  });
  await controller.start({ meeting, onSaved: (value) => (result = value) });
  now = 2000;
  track.dispatchEvent(new Event('ended'));
  await tick();
  assert.equal(defined(result).status, 'interrupted');
  assert.match(defined(controller.state.error), /disconnected/);
  controller.dispose();
});

test('device errors are actionable and do not prevent a later start', async () => {
  environment();
  let requests = 0;
  const original = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => {
    requests++;
    throw new DOMException('missing', 'OverconstrainedError');
  };
  const controller = createRecorderController({
    request: async (_path, options) =>
      options.method === 'POST'
        ? {}
        : { ...meeting, ...object(JSON.parse(text(options.body)) as unknown) },
  });
  assert.equal(requests, 0);
  await assert.rejects(
    controller.start({ meeting, deviceId: 'missing' }),
    /selected microphone is unavailable/,
  );
  assert.equal(requests, 1);
  navigator.mediaDevices.getUserMedia = original;
  await controller.start({ meeting });
  await controller.stop();
  controller.dispose();
});

test('server status is recorded before capture and failed setup releases the microphone', async () => {
  const track = environment();
  const controller = createRecorderController({
    request: async (_path, options) => {
      assert.equal(current.state, 'inactive');
      assert.deepEqual(object(JSON.parse(text(options.body)) as unknown), {
        status: 'recording',
        error: '',
      });
      throw new Error('Local server unavailable');
    },
  });
  await assert.rejects(controller.start({ meeting }), /Local server unavailable/);
  assert.equal(track.readyState, 'ended');
  assert.equal(current.state, 'inactive');
  assert.equal(controller.state.status, 'error');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, false);
  controller.dispose();
});
