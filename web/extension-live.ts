import {
  apiError,
  draftFields,
  extensionRecordings,
  leaseGrant,
  record,
  responseJson,
} from './guards.ts';
import type {
  ExtensionRecording,
  LeaseGrant,
  LiveDraft,
  LiveState,
  LiveStatus,
  Word,
} from './types/domain.ts';
interface LiveSession {
  recordingId: string;
  generation: number;
  expiresAt: number;
  draft: LiveDraft;
}
interface PreparedWindow {
  session: LiveSession;
  startFrame: number;
  frameCount: number;
  audio: Float32Array | null;
}
interface ActiveWindow {
  jobId: string;
  controller: AbortController;
  item: PreparedWindow;
}
interface LiveControllerOptions {
  api?: Omit<ReturnType<typeof createExtensionLiveApi>, 'status' | 'lease'> & {
    status?: (id: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
    lease: (
      id: string,
      owner: string,
      signal?: AbortSignal,
    ) => Promise<Partial<LeaseGrant> & Pick<LeaseGrant, 'generation' | 'expiresAt'>>;
  };
  inference?: {
    getLiveModelStatus: () => Promise<{ ready: boolean }>;
    transcribeLiveWindow: (
      ...args: Parameters<typeof transcribeLiveWindow>
    ) => Promise<Pick<Awaited<ReturnType<typeof transcribeLiveWindow>>, 'words' | 'modelRevision'>>;
    cancelLiveInference: (jobId: string) => unknown;
    releaseLiveInference: typeof releaseLiveInference;
    getInferenceState: () => { busy: boolean };
  };
  ownerId?: string;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number | ReturnType<typeof setInterval>;
  clearTimer?: (id: number | ReturnType<typeof setInterval> | undefined) => void;
  setDeadline?: (callback: () => void, ms: number) => number | ReturnType<typeof setTimeout>;
  clearDeadline?: (id: number | ReturnType<typeof setTimeout> | undefined) => void;
  requestTimeoutMs?: number;
  onState?: (states: LiveState[]) => void;
  language?: string;
}
import { errorInfo } from './guards.ts';
import {
  getLiveModelStatus,
  transcribeLiveWindow,
  cancelLiveInference,
  releaseLiveInference,
  getInferenceState,
} from './inference.ts';

export const LIVE_SAMPLE_RATE = 16000;
const LIVE_WINDOW_FRAMES = 20 * LIVE_SAMPLE_RATE;
const LIVE_STRIDE_FRAMES = 15 * LIVE_SAMPLE_RATE;
const LIVE_TAIL_FRAMES = 2.5 * LIVE_SAMPLE_RATE;
const statusText = {
  live: 'Live transcription',
  'catching-up': 'Catching up',
  'model-missing': 'Live paused — download Large V3 Turbo in Models',
  'processing-busy': 'Live paused — processing saved audio',
  'paused-open-echo': 'Live paused — open Echo',
  'waiting-audio': 'Waiting for recorded audio',
  'lease-held': 'Live transcription is open in another Echo tab',
  'connection-error': 'Live paused — reconnecting to Echo',
  complete: 'Recording saved',
  disabled: 'Live transcription is off',
};
const emptyDraft = (): LiveDraft => ({
  throughFrame: 0,
  committedThroughFrame: 0,
  words: [],
  language: 'auto',
  modelRevision: '',
});
const aborted = () => new DOMException('Live transcription was paused.', 'AbortError');

/** Word ownership is temporal: keep committed words and replace the entire tail.
 * Repeated phrases remain distinct because their timestamps, not text, own them.
 */
export function mergeLiveWindow(
  draft: LiveDraft,
  {
    startFrame,
    frameCount,
    words,
    language = 'auto',
    modelRevision,
  }: {
    startFrame: number;
    frameCount: number;
    words: Word[];
    language?: string;
    modelRevision: string;
  },
): LiveDraft {
  if (
    !Number.isSafeInteger(startFrame) ||
    startFrame < 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    frameCount > LIVE_WINDOW_FRAMES ||
    !Array.isArray(words)
  )
    throw new Error('Invalid live transcription window.');
  const end = startFrame + frameCount;
  const boundary = Math.max(0, end - LIVE_TAIL_FRAMES);
  const previousBoundary = draft.committedThroughFrame || 0;
  if (end <= draft.throughFrame || startFrame > draft.throughFrame || boundary < previousBoundary)
    throw new Error('Live transcription cursor is not contiguous.');
  let previousStart = 0;
  const incoming = words
    .map((word) => {
      const [start, finish] = word.timestamp;
      if (
        typeof word.text !== 'string' ||
        !word.text.trim() ||
        !Number.isFinite(start) ||
        !Number.isFinite(finish) ||
        start < previousStart ||
        start < 0 ||
        finish < start ||
        finish * LIVE_SAMPLE_RATE > frameCount + 1
      )
        throw new Error('Invalid live word timestamps.');
      previousStart = start;
      const startAt = startFrame + Math.round(start * LIVE_SAMPLE_RATE);
      const endAt = Math.min(end, startFrame + Math.round(finish * LIVE_SAMPLE_RATE));
      const midpoint = (startAt + endAt) / 2;
      return {
        text: word.text,
        startFrame: startAt,
        endFrame: endAt,
        provisional: midpoint > boundary,
        midpoint,
      };
    })
    .filter((word) => !draft.throughFrame || word.midpoint > previousBoundary)
    .map(({ text, startFrame, endFrame, provisional }) => ({
      text,
      startFrame,
      endFrame,
      provisional,
    }));
  return {
    throughFrame: end,
    committedThroughFrame: Math.max(previousBoundary, boundary),
    words: [...draft.words.filter((word) => !word.provisional), ...incoming].sort(
      (a, b) => a.startFrame - b.startFrame,
    ),
    language,
    modelRevision,
  };
}

/** Reject malformed saved cursors before requesting another PCM window. */
export function validateLiveDraft(input: unknown, totalFrames: number): LiveDraft {
  if (!input) return emptyDraft();
  const value = draftFields(input);
  const { throughFrame, committedThroughFrame, words } = value;
  if (
    !Number.isSafeInteger(throughFrame) ||
    throughFrame < 0 ||
    throughFrame > totalFrames ||
    !Number.isSafeInteger(committedThroughFrame) ||
    committedThroughFrame < 0 ||
    committedThroughFrame > throughFrame ||
    !Array.isArray(words)
  )
    throw new Error('Saved live transcription cursor is invalid.');
  let previous = -1;
  for (const word of words) {
    if (
      typeof word.text !== 'string' ||
      !word.text.trim() ||
      !Number.isSafeInteger(word.startFrame) ||
      !Number.isSafeInteger(word.endFrame) ||
      word.startFrame < previous ||
      word.startFrame < 0 ||
      word.endFrame < word.startFrame ||
      word.endFrame > throughFrame ||
      typeof word.provisional !== 'boolean' ||
      word.provisional !== (word.startFrame + word.endFrame) / 2 > committedThroughFrame
    )
      throw new Error('Saved live word timestamps are invalid.');
    previous = word.startFrame;
  }
  return {
    throughFrame,
    committedThroughFrame,
    words: words.map((word) => ({ ...word })),
    language: value.language || 'auto',
    modelRevision: value.modelRevision || '',
  };
}

export function createExtensionLiveApi(fetcher = globalThis.fetch.bind(globalThis)) {
  const json = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetcher(`/api/extensions${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      ...(signal ? { signal } : {}),
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const data = await responseJson(response).catch(() => null);
    if (!response.ok)
      throw Object.assign(new Error(apiError(data) || `Echo returned ${response.status}.`), {
        status: response.status,
      });
    if (record(data)['protocolVersion'] !== 1)
      throw new Error('This Echo extension protocol is unsupported.');
    return data;
  };
  const path = (id: string) => `/recordings/${encodeURIComponent(id)}`;
  return {
    recordings: async (signal?: AbortSignal) => {
      const data = await json('/recordings', undefined, signal);
      return { ...record(data), recordings: extensionRecordings(data) };
    },
    lease: async (id: string, ownerId: string, signal?: AbortSignal) =>
      leaseGrant(await json(`${path(id)}/lease`, { ownerId }, signal)),
    draft: (id: string, body: unknown, signal?: AbortSignal) =>
      json(`${path(id)}/draft`, body, signal),
    status: (id: string, body: unknown, signal?: AbortSignal) =>
      json(`${path(id)}/live-status`, body, signal),
    async pcm(id: string, startFrame: number, frameCount: number, signal?: AbortSignal) {
      if (
        !Number.isSafeInteger(startFrame) ||
        startFrame < 0 ||
        !Number.isSafeInteger(frameCount) ||
        frameCount < 1 ||
        frameCount > LIVE_WINDOW_FRAMES
      )
        throw new Error('Invalid live PCM range.');
      const response = await fetcher(
        `/api/extensions${path(id)}/pcm?startFrame=${startFrame}&frameCount=${frameCount}`,
        { credentials: 'same-origin', redirect: 'error', ...(signal ? { signal } : {}) },
      );
      if (!response.ok)
        throw Object.assign(new Error(`Recorded audio returned ${response.status}.`), {
          status: response.status,
        });
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== frameCount * 2)
        throw new Error('Recorded PCM window has an invalid length.');
      const samples = new Float32Array(frameCount),
        view = new DataView(bytes);
      for (let i = 0; i < frameCount; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      return samples;
    },
  };
}

/** Status reports carry no text; the existing draft lease remains the sole text authority. */
export function liveStatusReport(
  state: Pick<LiveState, 'status'>,
  record: Pick<ExtensionRecording, 'liveTranscription' | 'status' | 'generation'> | undefined,
  ownerId: string,
  generation?: number,
) {
  if (
    !record?.liveTranscription ||
    record.status !== 'receiving' ||
    ![
      'live',
      'catching-up',
      'waiting-audio',
      'model-missing',
      'processing-busy',
      'paused-open-echo',
    ].includes(state.status)
  )
    return null;
  return {
    ownerId,
    generation: Math.max(record.generation || 0, generation || 0),
    status: state.status,
  };
}

/** One global active ASR job and one bounded, prepared PCM window per Echo tab. */
export function createExtensionLiveController({
  api = createExtensionLiveApi(),
  inference = {
    getLiveModelStatus,
    transcribeLiveWindow,
    cancelLiveInference,
    releaseLiveInference,
    getInferenceState,
  },
  ownerId = crypto.randomUUID(),
  now = Date.now,
  setTimer = globalThis.setInterval.bind(globalThis),
  clearTimer = globalThis.clearInterval.bind(globalThis),
  setDeadline = globalThis.setTimeout.bind(globalThis),
  clearDeadline = globalThis.clearTimeout.bind(globalThis),
  requestTimeoutMs = 8000,
  onState = () => {
    /* The caller may omit state notifications. */
  },
  language = 'auto',
}: LiveControllerOptions = {}) {
  const isRunning = () => running;
  const hasPrepared = () => !!prepared;
  let running = false,
    polling: Promise<void> | null = null,
    renewing: Promise<void> | null = null,
    timer: number | ReturnType<typeof setInterval> | null = null,
    leaseTimer: number | ReturnType<typeof setInterval> | null = null,
    watchdogTimer: number | ReturnType<typeof setInterval> | null = null,
    expiryTimer: number | ReturnType<typeof setTimeout> | null = null,
    lifecycle = 0;
  let records: ExtensionRecording[] = [],
    states: LiveState[] = [],
    session: LiveSession | null = null,
    active: ActiveWindow | null = null,
    prepared: PreparedWindow | null = null;
  const fetches = new Set<AbortController>();
  const leaseBackoff = new Map<string, number>();
  const knownGenerations = new Map<string, number>(),
    statusReports = new Map<string, { signature: string; at: number; pending: boolean }>();
  const snapshot = () =>
    states.map((state) => ({
      ...state,
      draft: state.draft
        ? { ...state.draft, words: state.draft.words.map((word) => ({ ...word })) }
        : undefined,
    }));
  const reportStatuses = () => {
    if (!api.status) return;
    for (const state of states) {
      const body = liveStatusReport(
        state,
        records.find((record) => record.recordingId === state.recordingId),
        ownerId,
        knownGenerations.get(state.recordingId),
      );
      if (!body) continue;
      const prior = statusReports.get(state.recordingId);
      const signature = JSON.stringify(body);
      if (prior?.pending || (prior?.signature === signature && now() - prior.at < 5000)) continue;
      const report = { signature, at: now(), pending: true };
      statusReports.set(state.recordingId, report);
      // Best effort: status outages must never cancel inference or draft persistence.
      void request((signal) => api.status?.(state.recordingId, body, signal) ?? Promise.resolve())
        .catch(() => {
          /* Lease cleanup is best effort; the server also expires abandoned leases. */
        })
        .finally(() => {
          report.pending = false;
        });
    }
  };
  const publish = () => {
    onState(snapshot());
    reportStatuses();
  };
  const mark = (id: string, status: LiveStatus, extra: Partial<LiveState> = {}) => {
    states = states.map((state) =>
      state.recordingId === id
        ? { ...state, status, message: statusText[status], ...extra }
        : state,
    );
    publish();
  };
  const request = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    fetches.add(controller);
    let timeout: number | ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {
      /* Cancellation is best effort while the controller relinquishes ownership. */
    };
    // Racing the abort also settles a misbehaving transport that ignores its
    // signal, so it cannot monopolize the poll/renew guard indefinitely.
    const interrupted = new Promise<never>((_resolve, reject: (reason?: unknown) => void) => {
      abort = () => {
        reject((controller.signal.reason as Error | undefined) ?? aborted());
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      timeout = setDeadline(() => {
        controller.abort(new DOMException('Echo live request timed out.', 'TimeoutError'));
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        interrupted,
      ]);
    } finally {
      clearDeadline(timeout ?? undefined);
      controller.signal.removeEventListener('abort', abort);
      fetches.delete(controller);
    }
  };
  const interrupt = () => {
    if (active) {
      active.controller.abort();
      inference.cancelLiveInference(active.jobId);
    }
    active = null;
    prepared = null;
    for (const controller of fetches) controller.abort();
    inference.releaseLiveInference();
  };
  const discardSession = () => {
    clearDeadline(expiryTimer ?? undefined);
    expiryTimer = null;
    interrupt();
    session = null;
  };
  const watchdog = () => {
    if (!isRunning() || !session || now() < session.expiresAt) return;
    const id = session.recordingId;
    lifecycle++;
    discardSession();
    mark(id, 'lease-held', { error: 'The live processing lease expired.' });
  };
  const armExpiry = () => {
    clearDeadline(expiryTimer ?? undefined);
    if (session) expiryTimer = setDeadline(watchdog, Math.max(0, session.expiresAt - now()));
  };
  const isCurrent = (captured: LiveSession) =>
    running && session === captured && now() < captured.expiresAt;
  const parseLease = (lease: Pick<LeaseGrant, 'generation' | 'expiresAt'>) => {
    // The extension HTTP protocol uses Unix seconds; scheduling uses millis.
    const expiresAt =
      typeof lease.expiresAt === 'number' ? lease.expiresAt * 1000 : Date.parse(lease.expiresAt);
    if (
      !Number.isSafeInteger(lease.generation) ||
      lease.generation < 1 ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now()
    )
      throw new Error('Echo returned an invalid processing lease.');
    return { generation: lease.generation, expiresAt };
  };
  async function renewLease() {
    watchdog();
    if (!isRunning() || !session || renewing) return;
    const captured = session;
    const work = (async () => {
      try {
        const grant = await request((signal) => api.lease(captured.recordingId, ownerId, signal));
        watchdog();
        if (session !== captured || !isRunning()) return;
        const lease = parseLease(grant);
        if (lease.generation !== captured.generation) {
          discardSession();
          mark(captured.recordingId, 'lease-held');
          return;
        }
        captured.expiresAt = lease.expiresAt;
        armExpiry();
      } catch (error) {
        if (session !== captured || !isRunning()) return;
        discardSession();
        mark(
          captured.recordingId,
          errorInfo(error).status === 409 ? 'lease-held' : 'connection-error',
          {
            error: errorInfo(error).message,
          },
        );
      }
    })();
    renewing = work;
    try {
      await work;
    } finally {
      if (renewing === work) renewing = null;
    }
  }
  function prepare(captured: LiveSession, startFrame: number, totalFrames: number) {
    if (prepared || !isCurrent(captured) || totalFrames < startFrame + LIVE_WINDOW_FRAMES) return;
    const item: PreparedWindow = {
      session: captured,
      startFrame,
      frameCount: LIVE_WINDOW_FRAMES,
      audio: null,
    };
    prepared = item;
    void request((signal) => api.pcm(captured.recordingId, startFrame, item.frameCount, signal))
      .then((audio) => {
        if (prepared !== item || !isCurrent(captured)) return;
        if (!(audio instanceof Float32Array) || audio.length !== item.frameCount)
          throw new Error('Recorded PCM window has an invalid length.');
        item.audio = audio;
        pump();
      })
      .catch((error: unknown) => {
        if (prepared !== item || !isCurrent(captured)) return;
        prepared = null;
        mark(captured.recordingId, 'connection-error', { error: errorInfo(error).message });
      });
  }
  function pump() {
    watchdog();
    if (
      !isRunning() ||
      active ||
      !session ||
      !prepared?.audio ||
      inference.getInferenceState().busy ||
      !isCurrent(session)
    )
      return;
    const item = prepared,
      captured = session;
    const audio = item.audio;
    if (!audio) return;
    prepared = null;
    const job = { jobId: crypto.randomUUID(), controller: new AbortController(), item };
    active = job;
    const record = records.find((record) => record.recordingId === captured.recordingId);
    const nextStart = item.startFrame + LIVE_STRIDE_FRAMES;
    prepare(captured, nextStart, record?.totalFrames ?? 0);
    mark(
      captured.recordingId,
      (record?.totalFrames ?? 0) - (item.startFrame + item.frameCount) >= LIVE_STRIDE_FRAMES
        ? 'catching-up'
        : 'live',
    );
    void (async () => {
      try {
        const result = await inference.transcribeLiveWindow(audio, {
          jobId: job.jobId,
          language,
          signal: job.controller.signal,
        });
        if (active !== job || !isCurrent(captured) || inference.getInferenceState().busy)
          throw aborted();
        const draft = mergeLiveWindow(captured.draft, {
          startFrame: item.startFrame,
          frameCount: item.frameCount,
          words: result.words,
          language,
          modelRevision: result.modelRevision,
        });
        await request((signal) =>
          api.draft(
            captured.recordingId,
            { ownerId, generation: captured.generation, ...draft },
            signal,
          ),
        );
        if (active !== job || !isCurrent(captured)) return;
        captured.draft = draft;
        mark(
          captured.recordingId,
          (record?.totalFrames ?? 0) - draft.throughFrame >= LIVE_STRIDE_FRAMES
            ? 'catching-up'
            : 'live',
          {
            draft,
            backlogSeconds: Math.max(
              0,
              ((record?.totalFrames ?? 0) - draft.throughFrame) / LIVE_SAMPLE_RATE,
            ),
          },
        );
      } catch (error) {
        if (active !== job || !isRunning()) return;
        // An ambiguous draft acknowledgement must reload the durable cursor;
        // replaying an older local cursor could regress a successful write.
        discardSession();
        mark(
          captured.recordingId,
          errorInfo(error).code === 'model-missing'
            ? 'model-missing'
            : errorInfo(error).code === 'processing-busy' || inference.getInferenceState().busy
              ? 'processing-busy'
              : errorInfo(error).status === 409
                ? 'lease-held'
                : 'connection-error',
          { error: errorInfo(error).message },
        );
      } finally {
        if (active === job) active = null;
        pump();
      }
    })();
  }
  async function tick() {
    const token = lifecycle;
    try {
      const reply = await request((signal) => api.recordings(signal));
      if (!isRunning() || token !== lifecycle) return;
      records = reply.recordings.filter((record) => record.status !== 'deleted');
      const oldStates = new Map(states.map((state) => [state.recordingId, state]));
      states = records.map((record) => ({
        ...oldStates.get(record.recordingId),
        recordingId: record.recordingId,
        meetingId: record.meetingId,
        draft: session?.recordingId === record.recordingId ? session.draft : record.draft,
        status: !record.liveTranscription
          ? 'disabled'
          : record.status === 'complete'
            ? 'complete'
            : oldStates.get(record.recordingId)?.status || 'waiting-audio',
      }));
      for (const state of states) state.message = statusText[state.status];
      const eligible = records.filter(
        (record) => record.liveTranscription && record.status === 'receiving',
      );
      if (session && !eligible.some((record) => record.recordingId === session?.recordingId))
        discardSession();
      if (inference.getInferenceState().busy) {
        discardSession();
        for (const record of eligible) mark(record.recordingId, 'processing-busy');
        publish();
        return;
      }
      if (!eligible.length) {
        publish();
        return;
      }
      const model = await inference.getLiveModelStatus();
      if (!isRunning() || token !== lifecycle) return;
      if (!model.ready) {
        discardSession();
        for (const record of eligible) mark(record.recordingId, 'model-missing');
        return;
      }
      if (session && !isCurrent(session)) discardSession();
      const nextStart = (record: ExtensionRecording) =>
        record.draft?.throughFrame
          ? record.draft.throughFrame - (LIVE_WINDOW_FRAMES - LIVE_STRIDE_FRAMES)
          : 0;
      const available = eligible.filter(
        (record) => (leaseBackoff.get(record.recordingId) || 0) <= now(),
      );
      const ready = available.filter(
        (record) => record.totalFrames >= nextStart(record) + LIVE_WINDOW_FRAMES,
      );
      const readyRecord = ready[0];
      if (
        session &&
        !active &&
        !prepared &&
        readyRecord &&
        readyRecord.recordingId !== session.recordingId
      ) {
        const current = eligible.find((record) => record.recordingId === session?.recordingId);
        const currentStart = session.draft.throughFrame
          ? session.draft.throughFrame - (LIVE_WINDOW_FRAMES - LIVE_STRIDE_FRAMES)
          : 0;
        if (current && current.totalFrames < currentStart + LIVE_WINDOW_FRAMES) discardSession();
      }
      if (!session) {
        // A conflict concerns one recording, not this tab's entire queue.
        for (const record of ready.length ? ready : available) {
          try {
            const grant = await request((signal) => api.lease(record.recordingId, ownerId, signal));
            if (!isRunning() || token !== lifecycle) return;
            const lease = parseLease(grant);
            if (
              typeof grant.totalFrames !== 'number' ||
              !Number.isSafeInteger(grant.totalFrames) ||
              grant.totalFrames < 0 ||
              !Object.hasOwn(grant, 'draft')
            )
              throw new Error(
                'Echo returned no authoritative live cursor with its processing lease.',
              );
            // Ownership and the durable cursor are read atomically by Echo.
            // The earlier list snapshot may predate another owner's save.
            const draft = validateLiveDraft(grant.draft, grant.totalFrames);
            record.totalFrames = grant.totalFrames;
            record.draft = draft;
            session = { recordingId: record.recordingId, ...lease, draft };
            knownGenerations.set(record.recordingId, lease.generation);
            leaseBackoff.delete(record.recordingId);
            armExpiry();
            mark(record.recordingId, 'waiting-audio', { draft });
            break;
          } catch (error) {
            if (!isRunning() || token !== lifecycle) return;
            leaseBackoff.set(record.recordingId, now() + 10000);
            mark(
              record.recordingId,
              errorInfo(error).status === 409 ? 'lease-held' : 'connection-error',
              {
                error: errorInfo(error).message,
              },
            );
          }
        }
        if (!session) return;
      }
      const record = eligible.find((record) => record.recordingId === session?.recordingId);
      if (!active && !prepared) {
        const start = session.draft.throughFrame
          ? session.draft.throughFrame - (LIVE_WINDOW_FRAMES - LIVE_STRIDE_FRAMES)
          : 0;
        prepare(session, start, record?.totalFrames ?? 0);
        if (!hasPrepared() && record) mark(record.recordingId, 'waiting-audio');
      } else if (active && !prepared)
        prepare(session, active.item.startFrame + LIVE_STRIDE_FRAMES, record?.totalFrames ?? 0);
      publish();
      pump();
    } catch (error) {
      if (!isRunning() || token !== lifecycle) return;
      discardSession();
      states = states.map((state) => ({
        ...state,
        status: 'connection-error',
        message: statusText['connection-error'],
        error: errorInfo(error).message,
      }));
      publish();
    }
  }
  const poll = () => {
    watchdog();
    if (!isRunning()) return Promise.resolve();
    if (polling) return polling;
    const work = tick();
    polling = work;
    return work.finally(() => {
      if (polling === work) polling = null;
    });
  };
  return {
    start() {
      if (running) return poll();
      running = true;
      lifecycle++;
      timer = setTimer(() => void poll(), 1000);
      leaseTimer = setTimer(() => void renewLease(), 10000);
      watchdogTimer = setTimer(watchdog, 500);
      return poll();
    },
    stop() {
      running = false;
      lifecycle++;
      clearTimer(timer ?? undefined);
      clearTimer(leaseTimer ?? undefined);
      clearTimer(watchdogTimer ?? undefined);
      timer = leaseTimer = watchdogTimer = null;
      discardSession();
      states = states.map((state) =>
        state.status === 'complete' || state.status === 'disabled'
          ? state
          : { ...state, status: 'paused-open-echo', message: statusText['paused-open-echo'] },
      );
      publish();
    },
    preempt() {
      lifecycle++;
      discardSession();
      states = states.map((state) =>
        ['complete', 'disabled'].includes(state.status)
          ? state
          : { ...state, status: 'processing-busy', message: statusText['processing-busy'] },
      );
      publish();
    },
    poll,
    renewLease,
    getState: snapshot,
    getWorkState: () => ({
      active: active?.jobId ?? null,
      prepared: prepared ? { startFrame: prepared.startFrame, ready: !!prepared.audio } : null,
      lease: session
        ? {
            recordingId: session.recordingId,
            generation: session.generation,
            expiresAt: session.expiresAt,
          }
        : null,
    }),
  };
}

export function installExtensionLive(options: LiveControllerOptions = {}) {
  const controller = createExtensionLiveController({
    ...options,
    onState: (states) => {
      options.onState?.(states);
      window.dispatchEvent(
        new CustomEvent('echo-extension-live-state', { detail: { recordings: states } }),
      );
    },
  });
  const busy = (event: WindowEventMap['echo-inference-state']) => {
    if (event.detail.busy) controller.preempt();
    else void controller.poll();
  };
  const open = () => void controller.start();
  const close = () => {
    controller.stop();
  };
  window.addEventListener('echo-inference-state', busy);
  window.addEventListener('pagehide', close);
  window.addEventListener('pageshow', open);
  window.echoExtensionLive = controller;
  void controller.start();
  return controller;
}
