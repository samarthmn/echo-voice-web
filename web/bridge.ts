import {
  apiError,
  errorInfo,
  meeting,
  meeting as parseMeeting,
  responseJson,
  settings,
} from './guards.ts';
import type { Meeting } from './types/domain.ts';
interface ImportSession {
  file: File;
  fingerprint: string;
  meeting: Meeting;
  mimeType: string;
  trackId: string;
  sequence: number;
  offset: number;
  running: Promise<Meeting> | null;
  duration: Promise<number>;
}
import './theme.ts';
import { assertModel, resolveSpeechModel } from './models.ts';
import { automaticTranscriptionEligible } from './automatic-transcription.ts';
import './inference.ts';
import './notes.ts';
import './files.ts';
import './recorder.ts';
import './accessibility.ts';
import './extension-workspace.ts';
import './extension-connection.ts';

const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const imports = new Map<string, ImportSession>();
const startingImports = new Map<string, Promise<Meeting>>();
const autoHandled = new Set<string>();
let automaticQueue: Promise<unknown> = Promise.resolve();
let automaticGeneration = 0;
const pendingAutomatic = new Set<string>();
const emit = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

/** Call the local API while preserving meaningful JSON or HTTP errors. */
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`/api${path}`, { ...init, signal: controller.signal });
    const value = await responseJson(response).catch(() => null);
    if (!response.ok) {
      const error = new Error(apiError(value) || `The local server returned ${response.status}.`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return value;
  } catch (error) {
    if (errorInfo(error).name === 'AbortError')
      throw new Error('The local server took too long to save this audio chunk. Retry the import.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Retry transient persistence failures with a bounded backoff. */
async function retryRequest(path: string, init: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    try {
      return await request(path, init);
    } catch (error) {
      lastError = error;
      if (
        (errorInfo(error).status ?? 0) >= 400 &&
        (errorInfo(error).status ?? 0) < 500 &&
        ![408, 429].includes(errorInfo(error).status ?? 0)
      )
        break;
    }
  }
  throw lastError;
}

/** Identify supported audio containers from file headers rather than trusting filename extensions. */
async function audioType(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (start: number, count: number) =>
    String.fromCharCode(...bytes.slice(start, start + count));
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return 'audio/webm';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (['RIFF', 'RF64'].includes(ascii(0, 4)) && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return 'audio/mpeg';
  throw new Error(
    'Choose an original WAV, MP3, WebM, Ogg, MP4/M4A, or FLAC recording. This file does not have a supported audio header.',
  );
}

/** Inspect decoded audio duration and release the temporary audio resources. */
async function audioDuration(file: File): Promise<number> {
  const audio = document.createElement('audio');
  const url = URL.createObjectURL(file);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number>((resolve) => {
      const finish = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
      };
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        if (audio.duration === Infinity) audio.currentTime = 1e101;
        else finish();
      };
      audio.ondurationchange = finish;
      audio.ontimeupdate = finish;
      audio.onerror = () => resolve(0);
      timer = setTimeout(
        () => resolve(Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0),
        8000,
      );
      audio.src = url;
    });
  } finally {
    clearTimeout(timer);
    audio.onloadedmetadata = audio.ondurationchange = audio.ontimeupdate = audio.onerror = null;
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
}

const fingerprint = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
/** Publish import state for the UI without losing retryable session metadata. */
function uploadProgress(session: ImportSession, status: string, error?: string) {
  emit('echo-upload-progress', {
    meetingId: session.meeting.id,
    fileName: session.file.name,
    bytes: session.offset,
    total: session.file.size,
    progress: (session.offset / session.file.size) * 100,
    status,
    ...(error ? { error } : {}),
  });
}

/** Persist queued import chunks and finalize the meeting only when every upload succeeds. */
async function finishImport(session: ImportSession): Promise<Meeting> {
  if (session.running) return session.running;
  session.running = (async () => {
    try {
      await request(
        `/meetings/${session.meeting.id}`,
        json('PATCH', { status: 'processing', error: '' }),
      );
      uploadProgress(session, 'Saving recording');
      while (session.offset < session.file.size) {
        const end = Math.min(session.offset + IMPORT_CHUNK_BYTES, session.file.size);
        const chunk = session.file.slice(session.offset, end, session.mimeType);
        const form = new FormData();
        form.append('file', chunk, session.file.name);
        form.append('trackId', session.trackId);
        form.append('sequence', String(session.sequence));
        form.append('mimeType', session.mimeType);
        form.append('label', 'Original recording');
        await retryRequest(`/meetings/${session.meeting.id}/audio`, { method: 'POST', body: form });
        session.offset = end;
        session.sequence++;
        uploadProgress(session, 'Saving recording');
      }
      const duration = await session.duration;
      const value = meeting(
        await retryRequest(
          `/meetings/${session.meeting.id}`,
          json('PATCH', { duration, status: 'saved', error: '' }),
        ),
      );
      imports.delete(session.fingerprint);
      uploadProgress(session, 'Recording saved');
      emit('echo-recording-saved', value);
      return value;
    } catch (error) {
      const message = `${errorInfo(error).message} Select the same file again to retry from the last saved chunk. Keep this page open to retain the import.`;
      await request(
        `/meetings/${session.meeting.id}`,
        json('PATCH', { status: 'error', error: message }),
      ).catch(() => {});
      if (errorInfo(error).status === 404) imports.delete(session.fingerprint);
      uploadProgress(session, 'Import interrupted', message);
      emit('echo-library-changed', { meetingId: session.meeting.id });
      throw new Error(message);
    } finally {
      session.running = null;
    }
  })();
  return session.running;
}

/** Validate a user-selected audio file and create a resumable local import session. */
async function upload(
  input: { files: ArrayLike<File> | null; value: string } | null,
): Promise<Meeting | undefined> {
  const file = input?.files?.[0];
  if (!file) return;
  // Copy the File reference, then reset the existing input so choosing it again can resume.
  if (input) input.value = '';
  if (!file.size) throw new Error('This audio file is empty. Choose another recording.');
  if (file.size > 500 * 1024 * 1024)
    throw new Error('This recording is larger than 500 MB. Split it into smaller files first.');
  const key = fingerprint(file);
  if (startingImports.has(key)) return startingImports.get(key);
  const work = (async () => {
    let session = imports.get(key);
    if (!session) {
      const mimeType = await audioType(file);
      const created = meeting(
        await request(
          '/meetings',
          json('POST', {
            title: file.name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Imported recording',
            mode: 'import',
            consent: true,
          }),
        ),
      );
      session = {
        file,
        fingerprint: key,
        meeting: created,
        mimeType,
        trackId: crypto.randomUUID(),
        sequence: 0,
        offset: 0,
        running: null,
        duration: audioDuration(file),
      };
      imports.set(key, session);
      emit('echo-library-changed', { meetingId: created.id });
    }
    return finishImport(session);
  })();
  startingImports.set(key, work);
  try {
    return await work;
  } finally {
    startingImports.delete(key);
  }
}

/** Start local transcription only when the configured model is downloaded and enabled.
 * @dynamicImport Used by filename-bundled automatic-transcription tests.
 */
export async function autoTranscribeMeeting(meeting: Meeting): Promise<void> {
  if (!automaticTranscriptionEligible(meeting)) return;
  const key = `${meeting.id}:${meeting.tracks.map((track) => `${track.id}:${track.bytes}`).join(',')}`;
  if (autoHandled.has(key) || meeting.transcripts?.length) return;
  autoHandled.add(key);
  const token = automaticGeneration;
  pendingAutomatic.add(meeting.id);
  const skipped = (reason: string, message: string) =>
    emit('echo-auto-transcription-skipped', { meetingId: meeting.id, reason, message });
  try {
    const config = settings(await request('/settings'));
    if (!config.autoTranscribe) return;
    const model = resolveSpeechModel(meeting.speechModel || config.speechModel);
    assertModel(model);
    if (!(await window.echoInference.getDownloadedModels()).includes(model)) {
      skipped(
        'model-not-downloaded',
        'Recording saved. Download its speech model in Models, then choose Transcribe.',
      );
      return;
    }
    const job = automaticQueue
      .catch(() => {})
      .then(async () => {
        if (token !== automaticGeneration) return;
        const current = parseMeeting(await request(`/meetings/${encodeURIComponent(meeting.id)}`));
        if (token !== automaticGeneration || !automaticTranscriptionEligible(current)) return;
        return window.echoInference.transcribeMeeting(meeting.id, model, undefined, {
          automatic: true,
        });
      });
    automaticQueue = job;
    await job;
  } catch (error) {
    skipped('processing-unavailable', `Recording saved. ${errorInfo(error).message}`);
  } finally {
    pendingAutomatic.delete(meeting.id);
  }
}

window.addEventListener('echo-transcription-cancelled', () => {
  automaticGeneration++;
  void window.echoInference.suppressAutomaticTranscription([...pendingAutomatic]);
});

window.addEventListener('echo-recording-saved', (event) => {
  void autoTranscribeMeeting(event.detail);
});
window.addEventListener('echo-extension-import-ready', (event) => {
  void autoTranscribeMeeting(event.detail);
});
window.addEventListener('beforeunload', (event) => {
  if (imports.size || startingImports.size) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.echo = {
  upload,
  autoTranscribeMeeting,
  retryUpload(meetingId: string) {
    const session = [...imports.values()].find((item) => item.meeting.id === meetingId);
    return session
      ? finishImport(session)
      : Promise.reject(new Error('Choose the original audio file again to restart this import.'));
  },
  async testMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Microphone access needs localhost or HTTPS and a supported browser.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      return (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device) => ({ id: device.deviceId, label: device.label || 'Microphone' }));
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  },
  date(
    value: string | number,
    options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
  ) {
    return new Date(value).toLocaleDateString(undefined, options);
  },
};

import { installExtensionLive } from './extension-live.ts';
installExtensionLive();
