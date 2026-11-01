import { extensionRecordings, meeting as parseMeeting, record, responseJson } from './guards.ts';
import type { ExtensionRecording, Meeting } from './types/domain.ts';
type ImportMeeting = Pick<Meeting, 'id'> &
  Partial<Pick<Meeting, 'duration'>> & { tracks?: unknown[] };
type RecordingView = Pick<ExtensionRecording, 'recordingId' | 'meetingId' | 'status'> &
  Partial<Pick<ExtensionRecording, 'totalFrames' | 'captureState'>>;
interface ImportMonitorOptions<M extends ImportMeeting> {
  request: (path: string) => Promise<M | { recordings?: RecordingView[] }>;
  onSaved: (meeting: M) => void;
  onChange: (meeting: M) => void;
  onReady?: (meeting: M) => void;
  onProgress?: (meeting: M) => void;
  interval?: number;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
}
/** Reconcile durable extension imports independently of capture and processing. */
export function createExtensionImportMonitor<M extends ImportMeeting>({
  request,
  onSaved,
  onChange,
  onReady = () => {
    /* The caller may omit ready notifications. */
  },
  onProgress = () => {
    /* The caller may omit progress notifications. */
  },
  interval = 5000,
  timers = {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number' || (typeof id === 'object' && id !== null && 'hasRef' in id))
        globalThis.clearTimeout(id as number | ReturnType<typeof setTimeout>);
    },
  },
}: ImportMonitorOptions<M>) {
  let stopped = false,
    timer: unknown,
    inFlight = false,
    primed = false;
  const isStopped = () => stopped;
  const announced = new Set<string>();
  const progress = new Map<string, string>();
  async function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const value = await request('/extensions/recordings');
      if (isStopped()) return;
      for (const recording of ('recordings' in value ? value.recordings : undefined) ?? []) {
        if (recording.status === 'receiving' && recording.meetingId) {
          const signature = `${recording.meetingId}:${recording.totalFrames}:${recording.captureState || ''}`;
          if (progress.get(recording.recordingId) !== signature) {
            const meeting = await request(`/meetings/${encodeURIComponent(recording.meetingId)}`);
            if (isStopped()) return;
            if (!('id' in meeting)) throw new Error('Invalid meeting response.');
            progress.set(recording.recordingId, signature);
            onProgress(meeting);
          }
          continue;
        }
        if (
          recording.status !== 'complete' ||
          !recording.meetingId ||
          announced.has(recording.recordingId)
        )
          continue;
        const meeting = await request(`/meetings/${encodeURIComponent(recording.meetingId)}`);
        if (isStopped()) return;
        if (!('id' in meeting)) throw new Error('Invalid meeting response.');
        if (!meeting.tracks?.length) continue;
        announced.add(recording.recordingId);
        onReady(meeting);
        if (primed) {
          onChange(meeting);
          onSaved(meeting);
        }
      }
      primed = true;
    } catch {
      /* Echo downtime is independent from extension recording. */
    } finally {
      inFlight = false;
      if (!isStopped())
        timer = timers.setTimeout(() => {
          void poll();
        }, interval);
    }
  }
  return {
    start() {
      stopped = false;
      void poll();
    },
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
    },
    poll,
  };
}

function monitorRequest(
  path: '/extensions/recordings',
): Promise<{ recordings?: ExtensionRecording[] }>;
function monitorRequest(path: `/meetings/${string}`): Promise<Meeting>;
async function monitorRequest(path: string): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Echo unavailable');
  const value = await responseJson(response);
  return path === '/extensions/recordings'
    ? { ...record(value), recordings: extensionRecordings(value) }
    : parseMeeting(value);
}

if (typeof window !== 'undefined') {
  const monitor = createExtensionImportMonitor<Meeting>({
    request: (path) =>
      path === '/extensions/recordings'
        ? monitorRequest(path)
        : monitorRequest(path as `/meetings/${string}`),
    onReady: (meeting) =>
      window.dispatchEvent(new CustomEvent('echo-extension-import-ready', { detail: meeting })),
    onProgress: (meeting) =>
      window.dispatchEvent(
        new CustomEvent('echo-extension-recording-progress', { detail: meeting }),
      ),
    onSaved: (meeting) =>
      window.dispatchEvent(new CustomEvent('echo-recording-saved', { detail: meeting })),
    onChange: (meeting) =>
      window.dispatchEvent(
        new CustomEvent('echo-library-changed', { detail: { meetingId: meeting.id } }),
      ),
  });
  monitor.start();
  window.addEventListener(
    'pagehide',
    () => {
      monitor.stop();
    },
    { once: true },
  );
}
