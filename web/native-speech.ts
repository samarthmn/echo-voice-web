import {
  apiError,
  nativeJob,
  nativeStatus,
  parseJson,
  responseJson,
  unrefTimer,
} from './guards.ts';
import type { Progress } from './types/domain.ts';
interface NativeClientOptions {
  fetchRequest?: typeof fetch;
  storage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  online?: () => boolean;
  locks?: {
    request: <T>(
      name: string,
      options: { ifAvailable: true },
      callback: (lock: Pick<Lock, 'name'> | null) => Promise<T>,
    ) => Promise<T>;
  };
  setTimer?: (callback: () => void, ms: number) => number | ReturnType<typeof setTimeout>;
  clearTimer?: (id: number | ReturnType<typeof setTimeout> | undefined) => void;
  retryDelays?: number[];
}
import { errorInfo } from './guards.ts';
import { NATIVE_SPEECH_MODEL } from './models.ts';

const STORAGE_KEY = 'echo-native-speech-owned-jobs-v1';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const cancelled = () =>
  new DOMException('Local processing was cancelled. Your saved audio is unchanged.', 'AbortError');

/** Encode the API's 16 kHz mono PCM contract without changing a subarray's boundaries. */
export function nativePCM(audio: Float32Array | undefined) {
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > 16000 * 7200)
    throw new Error('The local speech engine requires up to two hours of decoded audio.');
  const bytes = new ArrayBuffer(audio.length * 4),
    view = new DataView(bytes);
  for (let index = 0; index < audio.length; index++) {
    if (!Number.isFinite(audio[index]))
      throw new Error('The decoded audio contains invalid samples.');
    view.setFloat32(index * 4, audio[index] ?? 0, true);
  }
  return bytes;
}

/** Per-tab ownership fences server jobs across lost replies, reloads and temporary disconnection. */
export function createNativeSpeechClient({
  fetchRequest = (...args: Parameters<typeof fetch>) => fetch(...args),
  storage = () => globalThis.sessionStorage,
  events = globalThis.window,
  online = () => globalThis.navigator?.onLine !== false,
  locks = globalThis.navigator?.locks,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelays = [1000, 2000, 4000, 8000, 16000, 30000],
}: NativeClientOptions = {}) {
  const activeJobs = new Map<string, AbortController>(),
    owned = new Set<string>(),
    pending = new Map<string, number>(),
    stopping = new Map<string, Promise<void>>(),
    heldLocks = new Map<string, () => void>();
  let retryTimer: number | ReturnType<typeof setTimeout> | undefined,
    hidden = false,
    disposed = false,
    recovering = true;
  try {
    const saved = parseJson(storage()?.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved))
      for (const id of saved.slice(0, 32) as unknown[]) {
        if (typeof id === 'string' && UUID.test(id)) {
          owned.add(id);
          pending.set(id, 0);
        }
      }
  } catch {
    /* In-memory and pagehide cancellation remain available without session storage. */
  }
  function persist() {
    try {
      if (owned.size) storage()?.setItem(STORAGE_KEY, JSON.stringify([...owned]));
      else storage()?.removeItem(STORAGE_KEY);
    } catch {
      /* Never store audio, URLs or another tab's server job. */
    }
  }
  function forget(id: string) {
    owned.delete(id);
    pending.delete(id);
    heldLocks.get(id)?.();
    heldLocks.delete(id);
    persist();
  }
  function claim(id: string, recovered = false): Promise<boolean> {
    if (heldLocks.has(id)) return Promise.resolve(true);
    // Without cross-tab ownership proof, a copied marker must never cancel a
    // source tab. Live jobs can still cancel through their in-memory owner.
    if (!locks?.request) return Promise.resolve(!recovered);
    return new Promise<boolean>((resolve) => {
      try {
        void locks
          .request(`echo-native-speech:${id}`, { ifAvailable: true }, async (lock) => {
            if (!lock || disposed) {
              resolve(false);
              return;
            }
            let release: () => void = () => {};
            const lifetime = new Promise<void>((done) => {
              release = done;
            });
            heldLocks.set(id, release);
            resolve(true);
            await lifetime;
          })
          .catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }
  async function jsonRequest(path: string, options: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController(),
      parent = options.signal;
    let expired = false;
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) abort();
    // Large loopback PCM uploads have a separate generous bound; status/polls
    // must not hold the inference queue forever after the server disconnects.
    const timer = setTimer(
      () => {
        expired = true;
        controller.abort();
      },
      options.method === 'POST' ? 600000 : 10000,
    );
    unrefTimer(timer);
    try {
      const response = await fetchRequest(`/api/speech${path}`, {
        ...options,
        signal: controller.signal,
      });
      const data = await responseJson(response).catch(() => null);
      if (expired)
        throw new Error('The local speech engine did not respond. Check the server and retry.');
      if (!response.ok)
        throw new Error(apiError(data) || `The local speech engine returned ${response.status}.`);
      return data;
    } catch (error) {
      if (expired && !parent?.aborted)
        throw new Error('The local speech engine did not respond. Check the server and retry.');
      throw error;
    } finally {
      clearTimer(timer);
      parent?.removeEventListener('abort', abort);
    }
  }
  function schedule() {
    if (retryTimer !== undefined || recovering || disposed || hidden || !online()) return;
    const attempts = [...pending.values()].filter((attempt) => attempt <= retryDelays.length);
    if (!attempts.length) return;
    const delay = Math.min(
      ...attempts.map((attempt) => (attempt ? (retryDelays[attempt - 1] ?? 0) : 0)),
    );
    retryTimer = setTimer(() => {
      retryTimer = undefined;
      for (const [id, attempt] of pending) if (attempt <= retryDelays.length) void stopJob(id);
    }, delay);
    unrefTimer(retryTimer);
  }
  function stopJob(id: string, keepalive = false): Promise<void> {
    if (!owned.has(id) || disposed) return Promise.resolve();
    if (stopping.has(id) && !keepalive) return stopping.get(id) ?? Promise.resolve();
    const controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), 3000);
    unrefTimer(timeout);
    const job = jsonRequest(`/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: controller.signal,
      keepalive,
    })
      .then((value) => {
        const data = nativeJob(value);
        if (data?.jobId !== id || !['cancelled', 'completed', 'failed'].includes(data.state ?? ''))
          throw new Error('The local speech cancellation was not acknowledged.');
        forget(id);
      })
      .catch(() => {
        if (owned.has(id)) pending.set(id, (pending.get(id) || 0) + 1);
      })
      .finally(() => {
        clearTimer(timeout);
        if (stopping.get(id) === job) stopping.delete(id);
        schedule();
      });
    stopping.set(id, job);
    return job;
  }
  function intent(id: string, keepalive = false) {
    if (!owned.has(id)) return;
    if (!pending.has(id)) pending.set(id, 0);
    persist();
    void stopJob(id, keepalive);
  }
  function cancel() {
    for (const [id, controller] of activeJobs) {
      controller.abort();
      intent(id);
    }
  }
  function pagehide() {
    hidden = true;
    clearTimer(retryTimer);
    retryTimer = undefined;
    for (const controller of activeJobs.values()) controller.abort();
    // No body: keepalive stays below browser limits even for a two-hour upload.
    for (const id of owned) intent(id, true);
  }
  function resume() {
    hidden = false;
    for (const id of pending.keys()) pending.set(id, 0);
    schedule();
  }
  events?.addEventListener('pagehide', pagehide);
  events?.addEventListener('pageshow', resume);
  events?.addEventListener('online', resume);
  const recovery = Promise.all(
    [...owned].map(async (id) => {
      if (!(await claim(id, true))) forget(id);
    }),
  ).finally(() => {
    recovering = false;
    persist();
    schedule();
  });
  function pause(signal: AbortSignal) {
    return new Promise<void>((resolve, reject: (reason?: unknown) => void) => {
      if (signal.aborted) return reject(cancelled());
      const abort = () => {
        clearTimer(timer);
        reject(cancelled());
      };
      const timer = setTimer(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 500);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function run(
    operation: 'download' | 'transcribe',
    audio?: Float32Array,
    language = 'auto',
    onProgress?: (progress: Progress) => void,
  ) {
    const id = crypto.randomUUID(),
      controller = new AbortController();
    activeJobs.set(id, controller);
    const check = () => {
      if (controller.signal.aborted) throw cancelled();
    };
    try {
      await recovery;
      check();
      if (disposed || owned.size >= 32)
        throw new Error(
          'Reconnect the local server to finish pending speech cancellation before starting another job.',
        );
      if (!(await claim(id)))
        throw new Error(
          'This browser could not take ownership of local speech processing. Refresh and retry.',
        );
      check();
      owned.add(id);
      persist();
      const query = new URLSearchParams({
        operation,
        modelId: NATIVE_SPEECH_MODEL,
        jobId: id,
        language: language === 'english' ? 'en' : language || 'auto',
      });
      const body = operation === 'transcribe' ? nativePCM(audio) : undefined;
      const created = nativeJob(
        await jsonRequest(`/jobs?${query}`, {
          method: 'POST',
          ...(body ? { body } : {}),
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: controller.signal,
        }),
      );
      check();
      if (created?.jobId !== id)
        throw new Error('The local speech engine returned an unexpected job identifier.');
      while (true) {
        check();
        const job = nativeJob(
          await jsonRequest(`/jobs/${encodeURIComponent(id)}`, {
            signal: controller.signal,
          }),
        );
        check();
        if (job.progress) onProgress?.(job.progress);
        if (job.state === 'completed') {
          forget(id);
          return job.result;
        }
        if (job.state === 'cancelled') {
          forget(id);
          throw cancelled();
        }
        if (job.state === 'failed') {
          forget(id);
          throw new Error(
            job.error || 'Local speech processing failed. Your saved audio is unchanged.',
          );
        }
        if (!['queued', 'running'].includes(job.state ?? ''))
          throw new Error('The local speech engine returned an invalid job state.');
        await pause(controller.signal);
      }
    } catch (error) {
      // Preserve this exact ID until DELETE is acknowledged, even after a lost POST reply.
      intent(id);
      if (controller.signal.aborted || errorInfo(error).name === 'AbortError') throw cancelled();
      throw error;
    } finally {
      activeJobs.delete(id);
      if (!owned.has(id)) {
        heldLocks.get(id)?.();
        heldLocks.delete(id);
      }
    }
  }
  return {
    async getStatus() {
      const result = nativeStatus(await jsonRequest(''));
      // A successful user refresh can recover a local server restart even
      // when the browser's network never went offline.
      if (pending.size) resume();
      return result;
    },
    run,
    cancel,
    dispose() {
      disposed = true;
      clearTimer(retryTimer);
      for (const release of heldLocks.values()) release();
      heldLocks.clear();
      events?.removeEventListener('pagehide', pagehide);
      events?.removeEventListener('pageshow', resume);
      events?.removeEventListener('online', resume);
    },
  };
}

const client = createNativeSpeechClient();
export const getNativeSpeechStatus = () => client.getStatus();
export const cancelNativeSpeech = () => client.cancel();
export const runNativeSpeech = (...args: Parameters<typeof client.run>) => client.run(...args);
