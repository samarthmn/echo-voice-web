// Event-driven uploads for the offscreen document: a pass runs when audio is committed, when
// Echo connects or when a retry is due; nothing polls while no recording is waiting.
export type PassOutcome = 'idle' | 'more' | 'offline' | 'poll';
/** Reported after a pass that needs no immediate follow-up. `retryAt` is set while Echo is offline. */
export type Settled = { failures: number; retryAt?: number };
type Clock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
};
/** Minimum spacing between passes triggered by committed audio while recording. */
export const UPLOAD_INTERVAL_MS = 2_000;
export const CONTROL_POLL_MS = 3_000;
const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
};
export function uploadScheduler(
  pass: () => Promise<PassOutcome>,
  settled: (state: Settled) => void,
  clock: Clock = systemClock,
) {
  let failures = 0;
  let retryAt = 0;
  let lastStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  let running: Promise<void> | undefined;
  let again = false;
  let pollTimer = false;
  function schedule(at: number) {
    if (timer !== undefined && due <= at) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    due = at;
    pollTimer = false;
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        due = Infinity;
        void run();
      },
      Math.max(0, at - clock.now()),
    );
  }
  function finish(outcome: PassOutcome) {
    if (outcome === 'offline') {
      failures++;
      retryAt = clock.now() + backoffDelay(failures);
      again = false;
      schedule(retryAt);
      settled({ failures, retryAt });
      return;
    }
    failures = 0;
    retryAt = 0;
    if (outcome === 'more') schedule(clock.now());
    else if (outcome === 'poll' && !again) {
      schedule(clock.now() + CONTROL_POLL_MS);
      pollTimer = true;
    } else if (again) {
      again = false;
      request();
    } else settled({ failures });
  }
  function run(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    lastStart = clock.now();
    running = pass()
      .catch((error) => {
        // An unexpected local failure backs off like an outage instead of retrying in a loop.
        console.warn('Echo: upload pass failed.', error);
        return 'offline' as const;
      })
      .then((outcome) => {
        running = undefined;
        finish(outcome);
      });
    return running;
  }
  /** Upload soon: spaced by UPLOAD_INTERVAL_MS and never before an offline retry is due. */
  function request() {
    if (running) {
      again = true;
      return;
    }
    schedule(Math.max(clock.now(), lastStart + UPLOAD_INTERVAL_MS, retryAt));
  }
  /** Upload now (connect, user retry, browser start); `previousFailures` continues a backoff. */
  function retryNow(previousFailures = 0): Promise<void> {
    failures = previousFailures;
    retryAt = 0;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    due = Infinity;
    return run();
  }
  return {
    request,
    retryNow,
    stopPolling() {
      if (pollTimer && timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
        due = Infinity;
        pollTimer = false;
      }
    },
    /** A pass is running or about to run; an offline retry timer alone is not busy. */
    busy: () => !!running || (timer !== undefined && retryAt === 0),
  };
}
