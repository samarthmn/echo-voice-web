import {endpointURL, Pair, Recording, Settings} from './core';
import {allRecordings, getChunk, recording, retainReceiptAndRemovePCM, updateRecording} from './storage';
export class ProtocolError extends Error {constructor(message: string, public status = 0) {super(message);}}
export async function jsonRequest(endpoint: string, path: string, options: RequestInit = {}, credential?: string): Promise<any> {
  const headers = new Headers(options.headers); if(credential) headers.set('Authorization',`Bearer ${credential}`);
  const runtime = (globalThis as any).chrome?.runtime;
  if(runtime?.getURL) {
    const origin = runtime.getURL('').replace(/\/$/,'');
    if(!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new ProtocolError('The recorder has an invalid extension identity.');
    // Privileged Chromium GET requests omit Origin unless explicitly supplied. The server still validates it.
    headers.set('Origin',origin);
  }
  if(options.body && typeof options.body === 'string') headers.set('Content-Type','application/json');
  let response: Response;
  try {response = await fetch(endpointURL(endpoint) + '/extension/v1' + path,{...options,headers,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});} catch {throw new ProtocolError('Echo is unavailable. Audio remains saved locally.');}
  if(!response.ok) {
    const errorBody = await response.json().catch(() => null); const reason = typeof errorBody?.error === 'string' ? errorBody.error.slice(0,200):'';
    throw new ProtocolError(response.status === 401 ? 'Pairing expired or was revoked. Reconnect Echo; audio is retained.' : `Echo could not accept this request (${response.status}). ${reason} Audio is retained.`,response.status);
  }
  const body = await response.json(); if(body.protocolVersion !== 1) throw new ProtocolError('This Echo version is incompatible. Audio is retained.'); return body;
}
export function checkStatus(status: any, row: Recording, pair: Pair): void {
  if(status.recordingId !== row.recordingId || status.libraryId !== pair.libraryId || !['receiving','complete','deleted'].includes(status.status) || !Number.isSafeInteger(status.nextSequence) || status.nextSequence < 0 || status.nextSequence > row.chunkCount || !Number.isSafeInteger(status.totalFrames) || status.totalFrames < 0 || status.totalFrames > row.totalFrames) throw new ProtocolError('Echo returned an inconsistent recording acknowledgement. Audio is retained.');
}
export async function transferOne(row: Recording, pair: Pair, onControl: (id: string, action: string) => Promise<void>): Promise<void> {
  if(row.receipt) return;
  if(row.libraryId && row.libraryId !== pair.libraryId) throw new ProtocolError('This recording belongs to a different Echo library.');
  if(!row.libraryId) row = await updateRecording(row.recordingId,{libraryId:pair.libraryId});
  const path = `/recordings/${row.recordingId}`;
  const metadata = {title:row.title,provider:row.provider,meetingUrl:row.meetingUrl,consent:row.consent,liveTranscription:row.liveTranscription,sampleRate:row.sampleRate,channels:row.channels,createdAt:row.createdAt};
  let status = await jsonRequest(pair.endpoint,path,{method:'PUT',body:JSON.stringify(metadata)},pair.credential); checkStatus(status,row,pair);
  if(status.status === 'deleted') throw new ProtocolError('This recording was deleted in Echo. Your local audio is retained for export.');
  for(const control of status.controls ?? []) {
    if(!control || typeof control.commandId !== 'string' || !['pause','resume','stop'].includes(control.action)) continue;
    await onControl(row.recordingId,control.action);
    await jsonRequest(pair.endpoint,`${path}/controls/${encodeURIComponent(control.commandId)}/ack`,{method:'POST'},pair.credential);
  }
  // Bound each turn so a large offline backlog cannot starve live audio or recording controls.
  const endSequence = Math.min(row.chunkCount,status.nextSequence + 64); const transferStarted = Date.now();
  for(let sequence = status.nextSequence; sequence < endSequence && status.status !== 'complete'; sequence++) {
    const chunk = await getChunk(row.recordingId,sequence); if(!chunk) throw new ProtocolError('A committed local audio chunk is missing.');
    status = await jsonRequest(pair.endpoint,`${path}/chunks/${sequence}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Echo-Frames':String(chunk.frames),'X-Echo-SHA256':chunk.sha256},body:chunk.pcm},pair.credential);
    checkStatus(status,row,pair); if(status.nextSequence !== sequence + 1) throw new ProtocolError('Echo did not durably acknowledge the audio sequence.');
    if(Date.now() - transferStarted >= 5000) break;
  }
  const latest = await recording(row.recordingId); if(!latest) return;
  if(['stopped','interrupted'].includes(latest.captureState) && status.nextSequence === latest.chunkCount) {
    await jsonRequest(pair.endpoint,`${path}/complete`,{method:'POST',body:JSON.stringify({chunkCount:latest.chunkCount,totalFrames:latest.totalFrames,gaps:latest.gaps,interrupted:latest.interrupted})},pair.credential);
    // Never purge on a possibly lost completion reply. An independent read verifies ownership and the entire manifest.
    const verified = await jsonRequest(pair.endpoint,path,{},pair.credential); checkStatus(verified,latest,pair);
    if(verified.status !== 'complete' || verified.nextSequence !== latest.chunkCount || verified.totalFrames !== latest.totalFrames || typeof verified.meetingId !== 'string' || !verified.meetingId) throw new ProtocolError('Echo has not confirmed the complete recording. Audio is retained.');
    await retainReceiptAndRemovePCM(row.recordingId,{libraryId:pair.libraryId,meetingId:verified.meetingId,verifiedAt:new Date().toISOString()});
  } else await updateRecording(row.recordingId,{transferState:'saved-local',error:undefined});
}
let transferring = false;
let attemptCounter = 0;
const lastAttempt = new Map<string,number>();
const retryAfterLibrary = new Map<string,number>();
export async function transferPending(settings: Settings, onControl: (id: string, action: string) => Promise<void>, notify: () => void): Promise<void> {
  if(transferring) return; transferring = true;
  const passStarted = Date.now();
  try {
    const rows = await allRecordings(); rows.sort((a,b) => Number(['recording','paused'].includes(b.captureState)) - Number(['recording','paused'].includes(a.captureState)) || (lastAttempt.get(a.recordingId) ?? 0) - (lastAttempt.get(b.recordingId) ?? 0) || b.createdAt.localeCompare(a.createdAt));
    for(const row of rows) {
      if(row.receipt || !row.chunkCount) continue;
      const pair = settings.pairs[row.libraryId ?? settings.activeLibraryId ?? '']; if(!pair) continue;
      if((retryAfterLibrary.get(pair.libraryId) ?? 0) > Date.now()) continue;
      lastAttempt.set(row.recordingId,++attemptCounter);
      await updateRecording(row.recordingId,{transferState:'transferring'}); notify();
      try {await transferOne(row,pair,onControl); retryAfterLibrary.delete(pair.libraryId);} catch(error) {if(error instanceof ProtocolError && (error.status === 0 || error.status === 401)) retryAfterLibrary.set(pair.libraryId,Date.now() + (error.status === 401 ? 60000:10000)); await updateRecording(row.recordingId,{transferState:error instanceof ProtocolError && error.status >= 400 ? 'attention':'saved-local',error:(error as Error).message});}
      notify();
      if(Date.now() - passStarted >= 5000) break;
    }
  } finally {transferring = false;}
}
