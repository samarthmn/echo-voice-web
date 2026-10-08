import {Pair} from './core';
import {settings, saveSettings} from './settings';
import {recording} from './storage';
import {jsonRequest, ProtocolError} from './protocol';
export type ConnectionStatus = 'connected' | 'not-connected' | 'unavailable' | 'revoked';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const liveStates = new Set(['live','catching-up','waiting-audio','model-missing','processing-busy','paused-open-echo','finalizing','final-transcript-needed','complete','disabled']);
let actions: Promise<unknown> = Promise.resolve();
export function connectionAction<T>(work: () => Promise<T>): Promise<T> {const result = actions.then(work); actions = result.catch(() => undefined); return result;}
let connectionCache: {pair: Pair; at: number; value: {status: ConnectionStatus}} | undefined;
let connectionPending: {pair: Pair; promise: Promise<{status: ConnectionStatus}>} | undefined;
const samePair = (a: Pair, b: Pair) => a.libraryId === b.libraryId && a.endpoint === b.endpoint && a.credential === b.credential;
export async function connectionStatus(): Promise<{status: ConnectionStatus}> {
  const prefs = await settings(); const pair = prefs.pairs[prefs.activeLibraryId ?? ''];
  if(!pair) return {status:'not-connected'};
  if(connectionCache && samePair(pair,connectionCache.pair) && Date.now() - connectionCache.at < 5000) return connectionCache.value;
  if(connectionPending && samePair(pair,connectionPending.pair)) return connectionPending.promise;
  const promise = (async () => {
    let status: ConnectionStatus;
    try {const body = await jsonRequest(pair.endpoint,'/connection',{signal:AbortSignal.timeout(3000)},pair.credential); if(body.libraryId !== pair.libraryId || body.installationId !== prefs.installationId) throw new Error('Invalid connection response.'); status = 'connected';}
    catch(error) {status = error instanceof ProtocolError && error.status === 401 ? 'revoked':'unavailable';}
    const current = await settings(); const currentPair = current.pairs[current.activeLibraryId ?? ''];
    if(!currentPair) status = 'not-connected'; else if(!samePair(currentPair,pair)) status = 'unavailable';
    const value = {status}; connectionCache = {pair,at:Date.now(),value}; return value;
  })();
  connectionPending = {pair,promise}; try {return await promise;} finally {if(connectionPending?.promise === promise) connectionPending = undefined;}
}
export function disconnect(confirmed: boolean): Promise<{status: 'disconnected'}> {
  return connectionAction(async () => {
    if(!confirmed) throw new Error('Confirm disconnect first. Pending local audio will remain on this device.');
    const prefs = await settings(); const pair = prefs.pairs[prefs.activeLibraryId ?? ''];
    if(!pair) return {status:'disconnected'};
    try {const body = await jsonRequest(pair.endpoint,'/connection',{method:'DELETE',signal:AbortSignal.timeout(3000)},pair.credential); if(body.status !== 'disconnected') throw new Error('Echo did not confirm disconnect.');}
    catch(error) {if(!(error instanceof ProtocolError && error.status === 401)) throw new Error('Echo could not confirm revocation. The connection is retained. Open Echo and retry disconnect; local audio is safe.');}
    await saveSettings(current => {
      if(!current.pairs[pair.libraryId] || !samePair(pair,current.pairs[pair.libraryId])) return {};
      const pairs = {...current.pairs}; delete pairs[pair.libraryId];
      return {pairs,activeLibraryId:current.activeLibraryId === pair.libraryId ? null:current.activeLibraryId};
    });
    connectionCache = undefined; return {status:'disconnected'};
  });
}
const livePending = new Map<string,Promise<any>>();
export async function livePreview(id: string): Promise<any> {
  if(!uuid.test(id)) throw new Error('Invalid recording identity.');
  const row = await recording(id); if(!row) throw new Error('Recording no longer exists locally.');
  if(!row.liveTranscription) return {recordingId:id,status:'disabled',preview:'',backlogSeconds:0,provisional:false};
  const prefs = await settings(); const pair = prefs.pairs[row.libraryId ?? prefs.activeLibraryId ?? ''];
  if(!pair) return {recordingId:id,status:'not-connected',preview:'',backlogSeconds:0,provisional:false};
  if(livePending.has(id)) return livePending.get(id);
  const promise = (async () => {
    try {
      const body = await jsonRequest(pair.endpoint,`/recordings/${id}/live`,{signal:AbortSignal.timeout(3000)},pair.credential);
      const current = await settings(); const currentPair = current.pairs[pair.libraryId];
      if(!currentPair || !samePair(currentPair,pair)) return {recordingId:id,status:'not-connected',preview:'',backlogSeconds:0,provisional:false};
      if(body.recordingId !== id || body.libraryId !== pair.libraryId || !liveStates.has(body.status) || typeof body.preview !== 'string' || !Number.isFinite(body.backlogSeconds) || body.backlogSeconds < 0 || typeof body.provisional !== 'boolean') throw new Error('Invalid live preview response.');
      return {recordingId:id,status:body.status,preview:Array.from(body.preview).slice(-600).join(''),backlogSeconds:Math.min(body.backlogSeconds,8 * 3600),provisional:body.provisional};
    } catch(error) {
      const status = error instanceof ProtocolError ? error.status === 401 ? 'revoked':error.status === 404 ? 'waiting-audio':error.status === 410 ? 'deleted':'unavailable' : 'unavailable';
      return {recordingId:id,status,preview:'',backlogSeconds:0,provisional:false};
    }
  })(); livePending.set(id,promise); try {return await promise;} finally {if(livePending.get(id) === promise) livePending.delete(id);}
}
