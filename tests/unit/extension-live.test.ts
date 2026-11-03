import type { LiveDraft, ExtensionRecording, Word, LeaseGrant } from '../../web/types/domain.ts';
import type { LiveOptions } from '../../web/types/worker.ts';
import { defined, object as recordFields, text, numeric } from '../helpers/assertions.ts';
import { installGlobal } from '../helpers/assertions.ts';
import { transformSync } from 'esbuild';
import { workerRequest, record, errorInfo } from '../../web/guards.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

installGlobal('window', new EventTarget());
installGlobal('location', { origin: 'http://localhost:3111' });
const {
  createExtensionLiveController,
  createExtensionLiveApi,
  mergeLiveWindow,
  validateLiveDraft,
  liveStatusReport,
  LIVE_SAMPLE_RATE: RATE,
} = await import('../../web/extension-live.ts');
const { validatedWhisperWords } = await import('../../web/whisper-alignment.ts');
const empty = () => ({
  throughFrame: 0,
  committedThroughFrame: 0,
  words: [],
  language: 'auto',
  modelRevision: '',
});
const word = (text: string, start: number, end: number): Word => ({
  text,
  timestamp: [start, end],
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};
function fixture({
  totalFrames = 50 * RATE,
  draft,
  clockStart = 100000,
}: { totalFrames?: number; draft?: LiveDraft; clockStart?: number } = {}) {
  let clock = clockStart,
    busy = false,
    model = true;
  const record: Omit<ExtensionRecording, 'draft'> & { draft: LiveDraft | undefined } = {
    recordingId: 'recording-one',
    meetingId: 'meeting-one',
    totalFrames,
    status: 'receiving',
    liveTranscription: true,
    draft,
  };
  interface Job {
    audio: Float32Array;
    options: LiveOptions;
    resolve?: (words: Word[]) => void;
    reject?: (reason: unknown) => void;
  }
  const jobs: Job[] = [],
    reads: { startFrame: number; frameCount: number }[] = [],
    writes: (LiveDraft & { generation: number; ownerId: string })[] = [],
    cancelled: string[] = [],
    timers: { callback: () => void; ms: number }[] = [],
    deadlines: { callback: () => void; at: number; cleared: boolean }[] = [];
  let owner: string | null = null,
    generation = 0,
    expiresAt = 0,
    leaseFailure: unknown = null,
    draftFailure: unknown = null,
    releases = 0;
  const api: Omit<ReturnType<typeof createExtensionLiveApi>, 'lease' | 'status'> & {
    lease: (
      id: string,
      owner: string,
      signal?: AbortSignal,
    ) => Promise<Partial<LeaseGrant> & Pick<LeaseGrant, 'generation' | 'expiresAt'>>;
    status?: (id: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
  } = {
    async recordings() {
      return { protocolVersion: 1, recordings: [structuredClone(record)] };
    },
    async lease(_id: string, requestedOwner: string) {
      if (leaseFailure) throw leaseFailure;
      if (owner && requestedOwner !== owner && clock < expiresAt)
        throw Object.assign(new Error('Lease held'), { status: 409 });
      if (requestedOwner !== owner || clock >= expiresAt) generation++;
      owner = requestedOwner;
      expiresAt = clock + 60000;
      return {
        protocolVersion: 1,
        generation,
        expiresAt: expiresAt / 1000,
        totalFrames: record.totalFrames,
        draft: structuredClone(record.draft ?? null),
      };
    },
    async pcm(_id: string, startFrame: number, frameCount: number) {
      reads.push({ startFrame, frameCount });
      return new Float32Array(frameCount);
    },
    async draft(_id: string, value: unknown) {
      const raw = recordFields(value);
      const saved = validateLiveDraft(value, record.totalFrames);
      const body = {
        ...saved,
        ownerId: text(raw['ownerId']),
        generation: numeric(raw['generation']),
      };
      assert.equal(body.generation, generation);
      assert.equal(body.ownerId, owner);
      assert.ok(clock < expiresAt);
      writes.push(structuredClone(body));
      record.draft = structuredClone(saved);
      if (draftFailure) {
        const error = draftFailure;
        draftFailure = null;
        throw error;
      }
      return { protocolVersion: 1 };
    },
  };
  const inference = {
    getInferenceState: () => ({ busy }),
    getLiveModelStatus: async () => ({ ready: model }),
    transcribeLiveWindow(audio: Float32Array, options: LiveOptions = {}) {
      const job: Job = { audio, options };
      jobs.push(job);
      return new Promise<{ words: Word[]; modelRevision: string }>((resolve, reject) => {
        job.resolve = (words: Word[]) => {
          resolve({ words, modelRevision: 'revision-one' });
        };
        job.reject = reject;
      });
    },
    cancelLiveInference(jobId: string) {
      cancelled.push(jobId);
      jobs
        .find((job) => job.options.jobId === jobId)
        ?.reject?.(new DOMException('cancelled', 'AbortError'));
    },
    releaseLiveInference() {
      releases++;
    },
  };
  const make = (
    ownerId: string,
    options: Partial<NonNullable<Parameters<typeof createExtensionLiveController>[0]>> = {},
  ) =>
    createExtensionLiveController({
      api,
      inference,
      ownerId,
      now: () => clock,
      setTimer: (callback: () => void, ms: number) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimer() {},
      setDeadline: (callback: () => void, ms: number) => {
        deadlines.push({ callback, at: clock + ms, cleared: false });
        return deadlines.length - 1;
      },
      clearDeadline: (id) => {
        if (typeof id === 'number' && deadlines[id]) deadlines[id].cleared = true;
      },
      ...options,
    });
  return {
    record,
    api,
    inference,
    make,
    jobs,
    reads,
    writes,
    cancelled,
    timers,
    deadlines,
    advance: (ms: number) => {
      clock += ms;
    },
    runDeadlines: () => {
      for (const deadline of [...deadlines])
        if (!deadline.cleared && deadline.at <= clock) {
          deadline.cleared = true;
          deadline.callback();
        }
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
    setModel: (value: boolean) => {
      model = value;
    },
    failLease: (error: unknown) => {
      leaseFailure = error;
    },
    failDraft: (error: unknown) => {
      draftFailure = error;
    },
    get releases() {
      return releases;
    },
  };
}

void test('midpoint ownership replaces provisional overlaps and preserves repeated phrases', () => {
  const first = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('yes', 1, 1.5), word('yes', 16, 16.5), word('old tail', 18, 19)],
    modelRevision: 'r',
  });
  assert.deepEqual(
    first.words.map((word) => word.provisional),
    [false, false, true],
  );
  assert.equal(first.committedThroughFrame, 17.5 * RATE);
  const second = mergeLiveWindow(first, {
    startFrame: 15 * RATE,
    frameCount: 20 * RATE,
    words: [
      word('yes', 1, 1.5),
      word('new tail', 3, 4),
      word('yes', 10, 10.5),
      word('yes', 11, 11.5),
    ],
    modelRevision: 'r',
  });
  assert.deepEqual(
    second.words.map((word) => word.text),
    ['yes', 'yes', 'new tail', 'yes', 'yes'],
  );
  assert.equal(second.throughFrame, 35 * RATE);
  assert.equal(second.committedThroughFrame, 32.5 * RATE);
  assert.deepEqual(validateLiveDraft(second, 50 * RATE), second);
});

void test('a word crossing the temporal boundary is owned by its midpoint', () => {
  const first = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('before', 17, 17.9), word('after', 17, 18.1)],
    modelRevision: 'r',
  });
  assert.deepEqual(
    first.words.map((word) => word.provisional),
    [false, true],
  );
  const second = mergeLiveWindow(first, {
    startFrame: 15 * RATE,
    frameCount: 20 * RATE,
    words: [word('before', 2, 2.9), word('after revised', 2, 3.1)],
    modelRevision: 'r',
  });
  assert.deepEqual(
    second.words.map((word) => word.text),
    ['before', 'after revised'],
  );
});

void test('words exactly on the commit boundary are committed once across overlap', () => {
  const first = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('boundary', 17, 18)],
    modelRevision: 'r',
  });
  assert.equal(defined(first.words[0]).provisional, false);
  const next = mergeLiveWindow(first, {
    startFrame: 15 * RATE,
    frameCount: 20 * RATE,
    words: [word('boundary', 2, 3), word('next', 4, 5)],
    modelRevision: 'r',
  });
  assert.deepEqual(
    next.words.map((word) => word.text),
    ['boundary', 'next'],
  );
});

void test('malformed timestamps and saved cursors are rejected without fabricating words', () => {
  assert.throws(
    () =>
      mergeLiveWindow(empty(), {
        startFrame: 0,
        frameCount: 20 * RATE,
        words: [word('bad', 3, 2)],
        modelRevision: '',
      }),
    /timestamps/,
  );
  assert.throws(() => validateLiveDraft({ ...empty(), throughFrame: 99 }, 10), /cursor/);
  assert.throws(
    () =>
      validateLiveDraft(
        {
          ...empty(),
          throughFrame: 20 * RATE,
          committedThroughFrame: 17.5 * RATE,
          words: [{ text: 'wrong ownership', startFrame: 0, endFrame: RATE, provisional: true }],
        },
        30 * RATE,
      ),
    /timestamps/,
  );
});

void test('scheduler uses 20 second windows, 15 second stride, one active and one prepared', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.reads, [
    { startFrame: 0, frameCount: 20 * RATE },
    { startFrame: 15 * RATE, frameCount: 20 * RATE },
  ]);
  for (let i = 0; i < 5; i++) await controller.poll();
  assert.equal(f.reads.length, 2);
  assert.equal(f.jobs.length, 1);
  assert.equal(defined(controller.getState()[0]).status, 'catching-up');
  defined(defined(f.jobs[0]).resolve)([word('one', 1, 2), word('temporary', 19, 19.5)]);
  await flush();
  assert.equal(f.jobs.length, 2);
  assert.equal(defined(f.writes[0]).throughFrame, 20 * RATE);
  assert.equal(defined(f.writes[0]).generation, 1);
  assert.equal(f.reads.length, 3);
  defined(defined(f.jobs[1]).resolve)([word('replacement', 4, 4.5)]);
  await flush();
  assert.deepEqual(
    defined(f.writes[1]).words.map((word: { text: unknown }) => word.text),
    ['one', 'replacement'],
  );
  controller.stop();
  await flush();
});

void test('workspace recovery resumes from persisted overlap cursor with committed words intact', async () => {
  const draft = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('saved', 2, 3), word('tail', 18, 19)],
    modelRevision: 'r',
  });
  const f = fixture({ totalFrames: 35 * RATE, draft }),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.deepEqual(f.reads, [{ startFrame: 15 * RATE, frameCount: 20 * RATE }]);
  defined(defined(f.jobs[0]).resolve)([word('corrected', 3, 4)]);
  await flush();
  assert.deepEqual(
    defined(f.record.draft).words.map((word: { text: unknown }) => word.text),
    ['saved', 'corrected'],
  );
  controller.stop();
});

void test('lease grant owns the authoritative cursor when a stale GET predates another owner save', async () => {
  const first = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('first', 1, 2)],
    modelRevision: 'r',
  });
  const advanced = mergeLiveWindow(first, {
    startFrame: 15 * RATE,
    frameCount: 20 * RATE,
    words: [word('already committed second', 5, 6)],
    modelRevision: 'r',
  });
  const f = fixture({ draft: first });
  const snapshot = structuredClone(f.record),
    grant = f.api.lease;
  f.api.recordings = async () => ({ recordings: [snapshot] });
  f.api.lease = async (...args) => {
    // The previous owner saves while the older GET is in flight, before the
    // new owner receives its atomic grant.
    f.record.draft = structuredClone(advanced);
    return grant(...args);
  };
  const controller = f.make('new-owner');
  await controller.start();
  await flush();
  assert.equal(defined(f.reads[0]).startFrame, 30 * RATE);
  assert.equal(defined(defined(controller.getState()[0]).draft).throughFrame, 35 * RATE);
  defined(defined(f.jobs[0]).resolve)([]);
  await flush();
  assert.deepEqual(
    defined(f.writes[0]).words.map((word: { text: unknown }) => word.text),
    ['first', 'already committed second'],
  );
  assert.equal(defined(f.writes[0]).throughFrame, 50 * RATE);
  controller.stop();
  await flush();
});

void test('a lease lacking the authoritative draft is refused before PCM or ASR', async () => {
  const f = fixture();
  f.api.lease = async () => ({ generation: 1, expiresAt: 160 });
  const controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'connection-error');
  assert.match(defined(defined(controller.getState()[0]).error), /authoritative live cursor/);
  assert.equal(f.reads.length, 0);
  assert.equal(f.jobs.length, 0);
  controller.stop();
});

void test('missing model never starts PCM or inference and displays a download action', async () => {
  const f = fixture();
  f.setModel(false);
  const controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'model-missing');
  assert.equal(f.reads.length, 0);
  assert.equal(f.jobs.length, 0);
  f.setModel(true);
  await controller.poll();
  await flush();
  assert.equal(f.jobs.length, 1);
  controller.stop();
  await flush();
});

void test('an idle earlier recording does not block another recording with a ready window', async () => {
  const f = fixture({ totalFrames: 10 * RATE });
  const ready = { ...f.record, recordingId: 'recording-two', totalFrames: 20 * RATE };
  f.api.recordings = async () => ({ recordings: [f.record, ready] });
  const grant = f.api.lease;
  f.api.lease = async (...args) => ({ ...(await grant(...args)), totalFrames: ready.totalFrames });
  const controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.equal(defined(controller.getWorkState().lease).recordingId, 'recording-two');
  assert.equal(f.jobs.length, 1);
  controller.stop();
  await flush();
});

void test('a ready recording leased elsewhere backs off while the next ready recording processes', async () => {
  const f = fixture(),
    second = { ...f.record, recordingId: 'recording-two' };
  f.api.recordings = async () => ({ recordings: [structuredClone(f.record), second] });
  const leases: string[] = [],
    grant = f.api.lease;
  f.api.lease = async (id, ...args) => {
    leases.push(id);
    if (id === f.record.recordingId)
      throw Object.assign(new Error('Another owner holds first'), { status: 409 });
    return grant(id, ...args);
  };
  const controller = f.make('owner-one');
  await controller.start();
  await flush();
  for (let i = 0; i < 3; i++) await controller.poll();
  assert.deepEqual(leases, ['recording-one', 'recording-two']);
  assert.equal(
    defined(controller.getState().find((state) => state.recordingId === 'recording-one')).status,
    'lease-held',
  );
  assert.equal(defined(controller.getWorkState().lease).recordingId, 'recording-two');
  assert.equal(f.jobs.length, 1);
  assert.equal(f.reads.length, 2);
  controller.stop();
  await flush();
});

void test('recording-specific conflict backoff suppresses retries until its bounded deadline', async () => {
  const f = fixture(),
    leases: string[] = [];
  f.api.lease = async (id) => {
    leases.push(id);
    throw Object.assign(new Error('held'), { status: 409 });
  };
  const controller = f.make('owner-one');
  await controller.start();
  for (let i = 0; i < 3; i++) await controller.poll();
  assert.deepEqual(leases, ['recording-one']);
  f.advance(10000);
  await controller.poll();
  assert.deepEqual(leases, ['recording-one', 'recording-one']);
  controller.stop();
});

void test('leases renew every ten seconds without changing the active generation', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  assert.deepEqual(
    f.timers.map((timer) => timer.ms),
    [1000, 10000, 500],
  );
  const first = controller.getWorkState().lease;
  f.advance(10000);
  await controller.renewLease();
  assert.equal(defined(controller.getWorkState().lease).generation, defined(first).generation);
  assert.equal(
    defined(controller.getWorkState().lease).expiresAt,
    defined(first).expiresAt + 10000,
  );
  defined(defined(f.jobs[0]).resolve)([]);
  await flush();
  assert.equal(defined(f.writes[0]).generation, defined(first).generation);
  controller.stop();
  await flush();
});

void test('a second tab cannot process until lease expiry and stale first-tab results cannot save', async () => {
  const f = fixture(),
    first = f.make('owner-one'),
    second = f.make('owner-two');
  await first.start();
  await flush();
  await second.start();
  await flush();
  assert.equal(defined(second.getState()[0]).status, 'lease-held');
  assert.equal(f.jobs.length, 1);
  f.advance(60001);
  await second.poll();
  await flush();
  assert.equal(f.jobs.length, 2);
  assert.equal(defined(second.getWorkState().lease).generation, 2);
  defined(defined(f.jobs[0]).resolve)([word('stale', 1, 2)]);
  await flush();
  assert.equal(f.writes.length, 0);
  defined(defined(f.jobs[1]).resolve)([word('new owner', 1, 2)]);
  await flush();
  assert.equal(defined(f.writes[0]).generation, 2);
  first.stop();
  second.stop();
  await flush();
});

void test('renewal failure cancels only live work and preserves the persisted draft', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  const jobId = defined(f.jobs[0]).options.jobId;
  f.failLease(Object.assign(new Error('fenced'), { status: 409 }));
  await controller.renewLease();
  await flush();
  assert.deepEqual(f.cancelled, [jobId]);
  assert.equal(defined(controller.getState()[0]).status, 'lease-held');
  assert.equal(f.writes.length, 0);
  assert.equal(controller.getWorkState().prepared, null);
  controller.stop();
});

void test('independent watchdog releases expired ASR and prepared PCM while GET and renewal hang', async () => {
  const f = fixture({ clockStart: 1000000 }),
    controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start();
  await flush();
  assert.equal(defined(controller.getWorkState().lease).expiresAt, 1060000);
  const signals: (AbortSignal | undefined)[] = [];
  f.api.recordings = (signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  f.api.lease = (_id: string, _owner: string, signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const pendingGet = controller.poll(),
    pendingRenew = controller.renewLease();
  await flush();
  assert.equal(signals.length, 2);
  const job = controller.getWorkState().active;
  f.advance(70001);
  defined(f.timers.find((timer) => timer.ms === 500)).callback();
  await Promise.all([pendingGet, pendingRenew]);
  await flush();
  assert.deepEqual(f.cancelled, [job]);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.ok(signals.every((signal) => defined(signal).aborted));
  assert.equal(defined(controller.getState()[0]).status, 'lease-held');
  await controller.renewLease();
  controller.stop();
});

void test('lease expiry deadline cancels processing independently of poll and renewal guards', async () => {
  const f = fixture({ clockStart: 1000000 }),
    controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start();
  await flush();
  f.api.recordings = () => new Promise(() => {});
  f.api.lease = () => new Promise(() => {});
  const pendingGet = controller.poll(),
    pendingRenew = controller.renewLease();
  await flush();
  f.advance(60001);
  f.runDeadlines();
  await Promise.all([pendingGet, pendingRenew]);
  await flush();
  assert.equal(f.cancelled.length, 1);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.equal(f.writes.length, 0);
  controller.stop();
});

void test('a renewal reply delivered after local expiry cannot revive the expired ASR operation', async () => {
  const f = fixture({ clockStart: 1000000 }),
    controller = f.make('owner-one', { requestTimeoutMs: 120000 });
  await controller.start();
  await flush();
  let reply:
    | ((value: Partial<LeaseGrant> & Pick<LeaseGrant, 'generation' | 'expiresAt'>) => void)
    | undefined;
  f.api.lease = () =>
    new Promise((resolve) => {
      reply = resolve;
    });
  const pendingRenew = controller.renewLease();
  await flush();
  f.advance(60001);
  // Deliver the server's extended expiry before the overdue timer callbacks.
  defined(reply)({
    generation: 1,
    expiresAt: 1120,
    totalFrames: f.record.totalFrames,
    draft: null,
  });
  await pendingRenew;
  await flush();
  assert.equal(f.cancelled.length, 1);
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  assert.equal(defined(controller.getState()[0]).status, 'lease-held');
  controller.stop();
});

void test('network deadlines settle uncooperative GET and renewal and allow subsequent recovery', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  const list = f.api.recordings,
    grant = f.api.lease,
    signals: (AbortSignal | undefined)[] = [];
  let deliverStale: ((value: { recordings: ExtensionRecording[] }) => void) | undefined;
  f.api.recordings = (signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise((resolve) => {
      deliverStale = resolve;
    });
  };
  f.api.lease = (_id: string, _owner: string, signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const pendingGet = controller.poll(),
    pendingRenew = controller.renewLease();
  await flush();
  f.advance(8001);
  f.runDeadlines();
  await Promise.all([pendingGet, pendingRenew]);
  await flush();
  assert.ok(signals.every((signal) => defined(signal).aborted));
  assert.equal(defined(controller.getState()[0]).status, 'connection-error');
  assert.deepEqual(controller.getWorkState(), { active: null, prepared: null, lease: null });
  f.api.recordings = list;
  f.api.lease = grant;
  await controller.poll();
  await flush();
  assert.equal(f.jobs.length, 2);
  const active = controller.getWorkState().active;
  defined(deliverStale)({ recordings: [] });
  await flush();
  assert.equal(controller.getWorkState().active, active);
  assert.equal(controller.getState().length, 1);
  controller.stop();
  await flush();
});

void test('final processing preempts active and prepared work; failure retains draft for recovery', async () => {
  const draft = mergeLiveWindow(empty(), {
    startFrame: 0,
    frameCount: 20 * RATE,
    words: [word('keep this', 1, 2)],
    modelRevision: 'r',
  });
  const f = fixture({ draft }),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  f.setBusy(true);
  controller.preempt();
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'processing-busy');
  assert.equal(controller.getWorkState().active, null);
  assert.equal(controller.getWorkState().prepared, null);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.record.draft, draft);
  await controller.poll();
  await flush();
  assert.equal(f.jobs.length, 1);
  f.setBusy(false);
  await controller.poll();
  await flush();
  assert.equal(f.jobs.length, 2);
  assert.equal(defined(f.reads.at(-2)).startFrame, 15 * RATE);
  controller.stop();
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'paused-open-echo');
});

void test('ambiguous draft acknowledgement reloads the durable cursor before retrying', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  f.failDraft(new Error('connection lost after durable save'));
  defined(defined(f.jobs[0]).resolve)([word('durable', 1, 2)]);
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'connection-error');
  assert.equal(defined(f.record.draft).throughFrame, 20 * RATE);
  await controller.poll();
  await flush();
  assert.equal(f.jobs.length, 2);
  assert.equal(defined(f.jobs[1]).audio.length, 20 * RATE);
  assert.equal(defined(f.reads.at(-2)).startFrame, 15 * RATE);
  defined(defined(f.jobs[1]).resolve)([word('next', 5, 6)]);
  await flush();
  assert.deepEqual(
    defined(f.record.draft).words.map((word: { text: unknown }) => word.text),
    ['durable', 'next'],
  );
  controller.stop();
  await flush();
});

void test('completion preempts live inference while keeping the saved draft visible', async () => {
  const f = fixture(),
    controller = f.make('owner-one');
  await controller.start();
  await flush();
  f.record.status = 'complete';
  await controller.poll();
  await flush();
  assert.equal(defined(controller.getState()[0]).status, 'complete');
  assert.equal(controller.getWorkState().active, null);
  assert.equal(f.writes.length, 0);
  controller.stop();
});

void test('API enforces bounded same-origin PCM and protocol version without redirects', async () => {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const api = createExtensionLiveApi(async (url, options) => {
    assert.equal(typeof url, 'string');
    if (typeof url !== 'string') throw new Error('Expected URL string');
    calls.push({ url, options });
    return url.includes('/pcm?')
      ? new Response(new Uint8Array([0, 128, 255, 127]))
      : Response.json({ protocolVersion: 1, recordings: [] });
  });
  assert.deepEqual(await api.recordings(), { protocolVersion: 1, recordings: [] });
  const pcm = await api.pcm('recording/a', 0, 2);
  assert.deepEqual(Array.from(pcm), [-1, 32767 / 32768]);
  assert.ok(defined(calls[1]).url.startsWith('/api/extensions/recordings/recording%2Fa/pcm'));
  assert.ok(
    calls.every(
      (call) =>
        defined(call.options).redirect === 'error' &&
        defined(call.options).credentials === 'same-origin',
    ),
  );
  await assert.rejects(api.pcm('one', 0, 20 * RATE + 1), /range/);
  await assert.rejects(
    createExtensionLiveApi(async () => Response.json({ protocolVersion: 2 })).recordings(),
    /unsupported/,
  );
  await assert.rejects(
    createExtensionLiveApi(async () => new Response(new Uint8Array(1))).pcm('one', 0, 2),
    /length/,
  );
});

void test('actual live worker stays warm, loads no speaker models, and validates word alignment', async () => {
  const source = (
    await readFile(new URL('../../web/inference-worker.ts', import.meta.url), 'utf8')
  ).replace(/^import[\s\S]*?;\n/gm, '');
  const messages: Record<string, unknown>[] = [],
    operations: { operation: string; options?: Record<string, unknown> }[] = [],
    handlers: ((event: { data: unknown }) => Promise<void>)[] = [];
  const model = { sessions: { decoder_model_merged: { outputNames: ['cross_attentions.0'] } } };
  let output = { text: 'hello', chunks: [word('hello', 1, 2)] };
  const transcriber = Object.assign(
    async (_audio: unknown, options: Record<string, unknown>) => {
      operations.push({ operation: 'ASR', options });
      return output;
    },
    {
      model,
      dispose: async () => {
        operations.push({ operation: 'dispose' });
      },
    },
  );
  const context = {
    env: { backends: { onnx: { wasm: {} } } },
    fetch: async () => {
      throw new Error('Unexpected network use');
    },
    navigator: {},
    crossOriginIsolated: false,
    caches: { open: async () => ({ match: async () => undefined }) },
    URL,
    Response,
    self: {
      addEventListener: (_type: string, handler: (event: { data: unknown }) => void) =>
        handlers.push(async (event) => {
          handler(event);
          await flush();
        }),
      postMessage: (value: unknown) => messages.push(recordFields(value)),
    },
    pipeline: async (_task: unknown, _checkpoint: unknown, options: Record<string, unknown>) => {
      operations.push({ operation: 'load', options });
      return transcriber;
    },
    assertModel() {},
    speechModelConfig: () => ({ checkpoint: 'turbo', revision: 'pinned', name: 'Turbo' }),
    assertWordTimestampSupport() {},
    DEFAULT_SPEECH_MODEL: 'turbo',
    SPEAKER_MODELS: {},
    MODEL_CACHE: 'files',
    MODEL_MANIFEST_CACHE: 'manifest',
    modelManifestUrl() {},
    wasmThreadCount: () => 1,
    Tensor() {},
    cat() {},
    mean() {},
    stack() {},
    std_mean() {},
    correctWhisperAlignment(_model: unknown, ops: Record<string, unknown>) {
      assert.deepEqual(Object.keys(ops).sort(), ['Tensor', 'cat', 'mean', 'stack', 'std_mean']);
    },
    validatedWhisperWords,
    AutoModelForAudioFrameClassification: {
      from_pretrained: () => {
        throw new Error('Speaker model must not load');
      },
    },
    AutoModelForXVector: {},
    AutoProcessor: {},
    diarize: () => {
      throw new Error('Speaker recognition must not run');
    },
    speakerPassages() {},
    speechFailureMessage: (error: { message: unknown }) => error.message,
    traceSpeechChunks: () => {
      throw new Error('Warm worker tracing must not accumulate');
    },
  };
  vm.runInNewContext(transformSync(source, { loader: 'ts' }).code, {
    ...context,
    workerRequest,
    record,
    errorInfo,
    speechModel: (value: unknown) => value,
  });
  await defined(handlers[0])({
    data: {
      id: 'first',
      type: 'transcribe-live',
      modelId: 'turbo',
      audio: new Float32Array(20 * RATE),
    },
  });
  await defined(handlers[0])({
    data: {
      id: 'second',
      type: 'transcribe-live',
      modelId: 'turbo',
      audio: new Float32Array(20 * RATE),
    },
  });
  assert.equal(operations.filter((value) => value.operation === 'load').length, 1);
  assert.equal(operations.filter((value) => value.operation === 'dispose').length, 0);
  assert.equal(
    defined(defined(operations.find((value) => value.operation === 'load')).options)[
      'local_files_only'
    ],
    true,
  );
  const results = messages.filter((message) => message['type'] === 'result');
  assert.equal(results.length, 2);
  assert.deepEqual(recordFields(defined(results[1])['result'])['words'], [word('hello', 1, 2)]);
  assert.equal(recordFields(defined(results[1])['result'])['modelRevision'], 'pinned');
  output = { text: 'bad', chunks: [word('bad', 2, 1)] };
  await defined(handlers[0])({
    data: {
      id: 'invalid',
      type: 'transcribe-live',
      modelId: 'turbo',
      audio: new Float32Array(20 * RATE),
    },
  });
  assert.equal(defined(messages.at(-1))['type'], 'error');
  assert.match(text(defined(messages.at(-1))['error']), /invalid word timestamps/);
  assert.equal(operations.filter((value) => value.operation === 'dispose').length, 1);
});

void test('live status adapter reports only eligible state with monotonic fencing generation', () => {
  const record = { status: 'receiving', liveTranscription: true, generation: 3 };
  assert.deepEqual(liveStatusReport({ status: 'model-missing' }, record, 'tab', 2), {
    ownerId: 'tab',
    generation: 3,
    status: 'model-missing',
  });
  assert.equal(liveStatusReport({ status: 'lease-held' }, record, 'tab', 3), null);
  assert.equal(
    liveStatusReport({ status: 'live' }, { ...record, status: 'complete' }, 'tab', 3),
    null,
  );
  assert.equal(
    liveStatusReport({ status: 'live' }, { ...record, liveTranscription: false }, 'tab', 3),
    null,
  );
});

void test('workspace publishes best-effort heartbeats through long inference and missing model', async () => {
  const f = fixture();
  const reports: Record<string, unknown>[] = [];
  f.api.status = async (_id: string, body: unknown) => {
    reports.push({ id: _id, ...recordFields(body) });
    throw new Error('status unavailable');
  };
  const c = f.make('tab');
  await c.start();
  await flush();
  assert.equal(f.jobs.length, 1);
  f.advance(6000);
  await c.poll();
  await flush();
  assert.ok(
    reports.some((report) => report['status'] === 'live' || report['status'] === 'catching-up'),
  );
  assert.equal(f.cancelled.length, 0);
  assert.equal(c.getWorkState().active, defined(f.jobs[0]).options.jobId);
  c.stop();
  await flush();
  const missing = fixture();
  const missingReports: Record<string, unknown>[] = [];
  missing.setModel(false);
  missing.api.status = async (_id: string, body: unknown) => {
    missingReports.push(recordFields(body));
  };
  const d = missing.make('missing');
  await d.start();
  await flush();
  missing.advance(6000);
  await d.poll();
  await flush();
  assert.equal(missingReports.length, 2);
  assert.equal(defined(missingReports[1])['status'], 'model-missing');
  d.stop();
  await flush();
});
