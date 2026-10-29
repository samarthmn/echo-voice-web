import { protectedCompanion } from './compatibility';
import { Pair } from './core';
import { readLink, connectedPair, saveLink, wasRevoked, Link } from './settings';
import { recording } from './storage';
import { jsonRequest, ProtocolError } from './protocol';
export type ConnectionStatus = 'connected' | 'echo-offline' | 'revoked' | 'waiting' | 'none';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const liveStates = new Set([
  'live',
  'catching-up',
  'waiting-audio',
  'model-missing',
  'processing-busy',
  'paused-open-echo',
  'finalizing',
  'final-transcript-needed',
  'complete',
  'disabled',
]);
let actions: Promise<unknown> = Promise.resolve();
/** Run connection changes one at a time, so a claim never races a cancel or disconnect. */
export function connectionAction<T>(work: () => Promise<T>): Promise<T> {
  const result = actions.then(work);
  actions = result.catch(() => undefined);
  return result;
}
const samePair = (a: Pair, b: Pair) =>
  a.libraryId === b.libraryId && a.endpoint === b.endpoint && a.credential === b.credential;
type StatusReply = { status: ConnectionStatus; endpoint?: string };
async function localStatus(link: Link): Promise<StatusReply> {
  if (link.state === 'none') return { status: (await wasRevoked()) ? 'revoked' : 'none' };
  return { status: link.state, endpoint: link.endpoint };
}
/** Contract UI status. A connected link is checked against Echo's GET /connection. */
export async function connectionStatus(): Promise<StatusReply> {
  const link = await readLink();
  if (link.state !== 'connected') return localStatus(link);
  try {
    const body = await jsonRequest(
      link.endpoint,
      '/connection',
      { signal: AbortSignal.timeout(3_000) },
      link.credential,
    );
    if (body.libraryId !== link.libraryId || !protectedCompanion(body))
      throw new ProtocolError('Echo returned an unexpected connection.');
    // A disconnect or new pairing may have finished while Echo answered.
    const current = await readLink();
    return current.state === 'connected' && samePair(current, link)
      ? { status: 'connected', endpoint: link.endpoint }
      : localStatus(current);
  } catch (error) {
    // jsonRequest already cleared a credential that Echo answered 401 for.
    if (error instanceof ProtocolError && error.status === 401)
      return { status: 'revoked', endpoint: link.endpoint };
    return { status: 'echo-offline', endpoint: link.endpoint };
  }
}
/** Ask an Echo this browser no longer uses to forget it. Best effort; never blocks the caller. */
export async function forgetRemote(pair: Pair): Promise<void> {
  await jsonRequest(
    pair.endpoint,
    '/connection',
    { method: 'DELETE', signal: AbortSignal.timeout(3_000) },
    pair.credential,
  ).catch((error) =>
    console.warn('Echo: the previous Echo did not confirm the disconnect.', error),
  );
}
/**
 * Forget this browser in Echo, then locally. Echo must confirm the revocation unless the user
 * chose `forgetLocally` after Echo could not be reached (moved, removed or not running).
 */
export function disconnect(forgetLocally = false): Promise<void> {
  return connectionAction(async () => {
    const pair = await connectedPair();
    if (!pair) return;
    try {
      await jsonRequest(pair.endpoint, '/connection', { method: 'DELETE' }, pair.credential);
    } catch (error) {
      const revoked = error instanceof ProtocolError && error.status === 401;
      if (!revoked && !forgetLocally)
        throw new Error('Open Echo to disconnect this browser. Recordings stay saved here.');
    }
    await saveLink({ state: 'none' });
  });
}
type LivePreview = {
  recordingId: string;
  status: string;
  preview: string;
  backlogSeconds: number;
  provisional: boolean;
};
const livePending = new Map<string, Promise<LivePreview>>();
export async function livePreview(id: string): Promise<LivePreview> {
  if (!uuid.test(id)) throw new Error('Invalid recording identity.');
  const row = await recording(id);
  if (!row) throw new Error('Recording no longer exists locally.');
  if (!row.liveTranscription)
    return {
      recordingId: id,
      status: 'disabled',
      preview: '',
      backlogSeconds: 0,
      provisional: false,
    };
  const pair = await connectedPair();
  if (!pair)
    return {
      recordingId: id,
      status: 'not-connected',
      preview: '',
      backlogSeconds: 0,
      provisional: false,
    };
  const inFlight = livePending.get(id);
  if (inFlight) return inFlight;
  const promise = (async (): Promise<LivePreview> => {
    try {
      const body = await jsonRequest(
        pair.endpoint,
        `/recordings/${id}/live`,
        { signal: AbortSignal.timeout(3_000) },
        pair.credential,
      );
      const currentPair = await connectedPair();
      if (!currentPair || !samePair(currentPair, pair))
        return {
          recordingId: id,
          status: 'not-connected',
          preview: '',
          backlogSeconds: 0,
          provisional: false,
        };
      if (
        body.recordingId !== id ||
        body.libraryId !== pair.libraryId ||
        !liveStates.has(body.status) ||
        typeof body.preview !== 'string' ||
        !Number.isFinite(body.backlogSeconds) ||
        body.backlogSeconds < 0 ||
        typeof body.provisional !== 'boolean'
      )
        throw new Error('Invalid live preview response.');
      return {
        recordingId: id,
        status: body.status,
        preview: Array.from(body.preview).slice(-600).join(''),
        backlogSeconds: Math.min(body.backlogSeconds, 8 * 3600),
        provisional: body.provisional,
      };
    } catch (error) {
      const status =
        error instanceof ProtocolError
          ? error.status === 401
            ? 'revoked'
            : error.status === 404
              ? 'waiting-audio'
              : error.status === 410
                ? 'deleted'
                : 'unavailable'
          : 'unavailable';
      return { recordingId: id, status, preview: '', backlogSeconds: 0, provisional: false };
    }
  })();
  livePending.set(id, promise);
  try {
    return await promise;
  } finally {
    if (livePending.get(id) === promise) livePending.delete(id);
  }
}
