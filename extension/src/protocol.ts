import { protectedCompanion, UPDATE_ECHO_MESSAGE } from './compatibility';
import { endpointURL, Pair, Recording } from './core';
import {
  allRecordings,
  getChunk,
  recording,
  retainReceiptAndRemovePCM,
  updateRecording,
} from './storage';
import { connectedPair, revokeCredential } from './settings';
import { withRecordingLock } from './recording-lock';
export class ProtocolError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export async function jsonRequest(
  endpoint: string,
  path: string,
  options: RequestInit = {},
  credential?: string,
): Promise<any> {
  const headers = new Headers(options.headers);
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
  const runtime = (globalThis as any).chrome?.runtime;
  if (runtime?.getURL) {
    const origin = runtime.getURL('').replace(/\/$/, '');
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
      throw new ProtocolError('The recorder has an invalid extension identity.');
    // Privileged Chromium GET requests omit Origin unless explicitly supplied. The server still validates it.
    headers.set('Origin', origin);
  }
  if (options.body && typeof options.body === 'string')
    headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(endpointURL(endpoint) + '/extension/v1' + path, {
      ...options,
      headers,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProtocolError('Echo is unavailable. Audio remains saved locally.');
  }
  if (!response.ok) {
    if (response.status === 401 && credential) await revokeCredential(credential, endpoint);
    const errorBody = await response.json().catch(() => null);
    const reason = typeof errorBody?.error === 'string' ? errorBody.error.slice(0, 200) : '';
    throw new ProtocolError(
      response.status === 401
        ? 'Pairing expired or was revoked. Reconnect Echo; audio is retained.'
        : `Echo could not accept this request (${response.status}). ${reason} Audio is retained.`,
      response.status,
    );
  }
  if (response.status === 204) return {};
  const body = await response.json();
  if (body.protocolVersion !== undefined && ![1, 2].includes(body.protocolVersion))
    throw new ProtocolError('This Echo version is incompatible. Audio is retained.');
  return body;
}
function checkStatus(status: any, row: Recording, pair: Pair): void {
  if (
    status.recordingId !== row.recordingId ||
    status.libraryId !== pair.libraryId ||
    !['receiving', 'complete', 'deleted'].includes(status.status) ||
    !Number.isSafeInteger(status.nextSequence) ||
    status.nextSequence < 0 ||
    status.nextSequence > row.chunkCount ||
    !Number.isSafeInteger(status.totalFrames) ||
    status.totalFrames < 0 ||
    status.totalFrames > row.totalFrames
  )
    throw new ProtocolError(
      'Echo returned an inconsistent recording acknowledgement. Audio is retained.',
    );
}
export async function transferOne(
  row: Recording,
  pair: Pair,
  onControl: (id: string, action: string) => Promise<void>,
): Promise<void> {
  return withRecordingLock(row.recordingId, async () => {
    const current = await recording(row.recordingId);
    if (!current) return;
    await transferLocked(current, pair, onControl);
  });
}
async function transferLocked(
  row: Recording,
  pair: Pair,
  onControl: (id: string, action: string) => Promise<void>,
): Promise<void> {
  if (row.receipt) return;
  const companion = await jsonRequest(pair.endpoint, '/connection', {}, pair.credential);
  if (companion.libraryId !== pair.libraryId)
    throw new ProtocolError(
      'Echo returned an inconsistent library acknowledgement. Audio is retained.',
    );
  if (!protectedCompanion(companion)) throw new ProtocolError(UPDATE_ECHO_MESSAGE, 426);
  if (row.libraryId !== pair.libraryId)
    row = await updateRecording(row.recordingId, { libraryId: pair.libraryId });
  const path = `/recordings/${row.recordingId}`;
  const metadata = {
    title: row.title,
    provider: row.provider,
    meetingUrl: row.meetingUrl,
    consent: row.consent,
    liveTranscription: row.liveTranscription,
    sampleRate: row.sampleRate,
    channels: row.channels,
    createdAt: row.createdAt,
  };
  let status = await jsonRequest(
    pair.endpoint,
    path,
    { method: 'PUT', body: JSON.stringify(metadata) },
    pair.credential,
  );
  checkStatus(status, row, pair);
  if (status.status === 'deleted')
    throw new ProtocolError(
      'This recording was deleted in Echo. Your local audio is retained for export.',
    );
  for (const control of status.controls ?? []) {
    if (
      !control ||
      typeof control.commandId !== 'string' ||
      !['pause', 'resume', 'stop'].includes(control.action)
    )
      continue;
    await onControl(row.recordingId, control.action);
    await jsonRequest(
      pair.endpoint,
      `${path}/controls/${encodeURIComponent(control.commandId)}/ack`,
      { method: 'POST' },
      pair.credential,
    );
  }
  // Bound each turn so a large offline backlog cannot starve live audio or recording controls.
  const endSequence = Math.min(row.chunkCount, status.nextSequence + 64);
  const transferStarted = Date.now();
  for (
    let sequence = status.nextSequence;
    sequence < endSequence && status.status !== 'complete';
    sequence++
  ) {
    const chunk = await getChunk(row.recordingId, sequence);
    if (!chunk) throw new ProtocolError('A committed local audio chunk is missing.');
    status = await jsonRequest(
      pair.endpoint,
      `${path}/chunks/${sequence}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Echo-Frames': String(chunk.frames),
          'X-Echo-SHA256': chunk.sha256,
        },
        body: chunk.pcm,
      },
      pair.credential,
    );
    checkStatus(status, row, pair);
    if (status.nextSequence !== sequence + 1)
      throw new ProtocolError('Echo did not durably acknowledge the audio sequence.');
    if (Date.now() - transferStarted >= 5000) break;
  }
  const latest = await recording(row.recordingId);
  if (!latest) return;
  if (
    ['stopped', 'interrupted'].includes(latest.captureState) &&
    status.nextSequence === latest.chunkCount
  ) {
    await jsonRequest(
      pair.endpoint,
      `${path}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          chunkCount: latest.chunkCount,
          totalFrames: latest.totalFrames,
          gaps: latest.gaps,
          interrupted: latest.interrupted,
        }),
      },
      pair.credential,
    );
    // Never purge on a possibly lost completion reply. An independent read verifies ownership and the entire manifest.
    const verified = await jsonRequest(pair.endpoint, path, {}, pair.credential);
    checkStatus(verified, latest, pair);
    if (
      verified.status !== 'complete' ||
      verified.nextSequence !== latest.chunkCount ||
      verified.totalFrames !== latest.totalFrames ||
      typeof verified.meetingId !== 'string' ||
      !verified.meetingId
    )
      throw new ProtocolError('Echo has not confirmed the complete recording. Audio is retained.');
    await retainReceiptAndRemovePCM(row.recordingId, {
      libraryId: pair.libraryId,
      meetingId: verified.meetingId,
      verifiedAt: new Date().toISOString(),
    });
  } else await updateRecording(row.recordingId, { transferState: 'saved-local', error: undefined });
}
let transferring = false;
let attemptCounter = 0;
const lastAttempt = new Map<string, number>();
let retryAfter = 0;
async function updateTransferState(
  id: string,
  patch: Partial<Recording>,
): Promise<Recording | undefined> {
  try {
    return await updateRecording(id, patch);
  } catch (error) {
    // Local deletion may win between selecting pending rows and updating status.
    // Ignore only a verified missing row; persistence errors still propagate.
    if (!(await recording(id))) return undefined;
    throw error;
  }
}
export async function transferPending(
  onControl: (id: string, action: string) => Promise<void>,
  notify: () => void,
): Promise<void> {
  if (transferring) return;
  transferring = true;
  const passStarted = Date.now();
  try {
    const pair = await connectedPair();
    if (!pair || retryAfter > Date.now()) return;
    const rows = await allRecordings();
    rows.sort(
      (a, b) =>
        Number(['recording', 'paused'].includes(b.captureState)) -
          Number(['recording', 'paused'].includes(a.captureState)) ||
        (lastAttempt.get(a.recordingId) ?? 0) - (lastAttempt.get(b.recordingId) ?? 0) ||
        b.createdAt.localeCompare(a.createdAt),
    );
    for (const row of rows) {
      // Locked rows wait for migration; they are never uploaded under another key.
      if (row.receipt || row.locked || !row.chunkCount) continue;
      lastAttempt.set(row.recordingId, ++attemptCounter);
      if (!(await updateTransferState(row.recordingId, { transferState: 'transferring' })))
        continue;
      notify();
      try {
        await transferOne(row, pair, onControl);
        retryAfter = 0;
      } catch (error) {
        const status = error instanceof ProtocolError ? error.status : -1;
        await updateTransferState(row.recordingId, {
          transferState: status >= 400 ? 'attention' : 'saved-local',
          error: (error as Error).message,
        });
        // Offline, revoked or outdated Echo fails every row alike: back off instead.
        if ([0, 401, 426].includes(status)) {
          retryAfter = Date.now() + (status === 0 ? 10_000 : 60_000);
          notify();
          break;
        }
      }
      notify();
      if (Date.now() - passStarted >= 5000) break;
    }
  } finally {
    transferring = false;
  }
}
