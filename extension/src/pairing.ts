import {sealSecret,openSecret} from './device-secrets';
import {endpointURL, unixSecondsToMilliseconds} from './core';
import {settings, saveSettings} from './settings';
import {allRecordings} from './storage';
import {connectionAction, disconnectLocked} from './connection';
import {jsonRequest, ProtocolError} from './protocol';
declare const chrome: any;
export type PairingPhase = 'idle' | 'beginning' | 'pending' | 'prepared' | 'confirm-library' | 'activation-sent' | 'connected' | 'cancelled' | 'rejected' | 'expired';
export type PairingError = 'old-server' | 'unavailable' | 'rate-limited' | 'tab-open-failed' | 'invalid-response' | 'denied';
export type PairingView = {requestId?: string; phase: PairingPhase; expiresAtMs?: number; endpoint?: string; pendingCount: number; error?: PairingError; legacy?: boolean};
export type PairingAttempt = {requestId: string; installationId: string; endpoint: string; name: string; claimSecret: string; createdAtMs: number; expiresAtMs: number; libraryId?: string; phase: PairingPhase; stagedCredential?: string; pendingCount: number; confirmedLibrary?: boolean; cancelRequested?: boolean; activationConfirmed?: boolean; mode: 'browser' | 'manual'; legacy?: boolean; error?: PairingError};
const key = 'pairingAttempt';
const cancellationKey = 'pairingCancellation';
let cancellationWrite: Promise<void> = Promise.resolve();
// Cancellation intent has a separate durable key, so it can arrive while a
// serialized claim is waiting on the network without racing attempt snapshots.
function recordCancellation(): Promise<void> {
  const writeIntent = async () => {const attempt = await read(); if(attempt) await chrome.storage.local.set({[cancellationKey]:attempt.requestId});};
  cancellationWrite = cancellationWrite.catch(() => {}).then(writeIntent);
  return cancellationWrite;
}
async function cancellationRequested(attempt: PairingAttempt): Promise<boolean> {
  for(;;) {const pending = cancellationWrite; await pending; const id = (await chrome.storage.local.get(cancellationKey))[cancellationKey]; if(pending === cancellationWrite) return id === attempt.requestId;}
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = new Set<PairingPhase>(['connected','cancelled','rejected','expired']);
async function read(): Promise<PairingAttempt | undefined> {await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}); const stored=(await chrome.storage.local.get(key))[key]; if(!stored) return undefined; if(stored.encrypted) return openSecret<PairingAttempt>(stored.encrypted,'pairing-attempt'); await write(stored); return stored;}
async function current(attempt: PairingAttempt) {return (await read())?.requestId === attempt.requestId;}
async function write(attempt: PairingAttempt) {await chrome.storage.local.set({[key]:{encrypted:await sealSecret(attempt,'pairing-attempt')}});}
async function save(attempt: PairingAttempt) {if(!(await current(attempt))) throw new Error('Connection attempt changed.'); await write(attempt);}
function view(attempt?: PairingAttempt): PairingView {
  return attempt ? {requestId:attempt.requestId,phase:attempt.phase,expiresAtMs:attempt.expiresAtMs,endpoint:attempt.endpoint,pendingCount:attempt.pendingCount,error:attempt.error,legacy:attempt.legacy} : {phase:'idle',pendingCount:0};
}
export async function pairingView(): Promise<PairingView> {return view(await read());}
function failure(error: unknown): PairingError {return error instanceof ProtocolError ? error.status === 429 ? 'rate-limited' : error.status === 401 || error.status === 403 ? 'denied' : 'unavailable' : 'invalid-response';}
async function request(attempt: PairingAttempt,path: string,body: object) {
  const result = await jsonRequest(attempt.endpoint,path,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  if(!(await current(attempt))) throw new Error('Connection attempt changed.');
  return result;
}
function validateIdentity(body: any,attempt: PairingAttempt,required = true) {
  if((required || body.requestId !== undefined) && body.requestId !== attempt.requestId || (required || body.installationId !== undefined) && body.installationId !== attempt.installationId || body.libraryId !== attempt.libraryId) throw new Error('Invalid pairing identity.');
}
async function manualReservation(attempt: PairingAttempt): Promise<any> {
  const body = {installationId:attempt.installationId,name:attempt.name,code:attempt.claimSecret,...(attempt.legacy ? {}:{deferredActivation:true})};
  try {return await request(attempt,'/pairing/request',body);}
  catch(error) {
    if(attempt.legacy || !(error instanceof ProtocolError) || error.status !== 400) throw error;
    // Old servers reject unknown fields. A failed request alone is insufficient
    // evidence: only a missing begin route permits the legacy wire contract.
    let oldServer = false;
    try {await request(attempt,'/pairing/begin',{});} catch(probe) {oldServer = probe instanceof ProtocolError && [404,405].includes(probe.status);}
    if(!oldServer) throw error;
    attempt.legacy = true; await save(attempt);
    return request(attempt,'/pairing/request',{installationId:attempt.installationId,name:attempt.name,code:attempt.claimSecret});
  }
}
async function reserve(attempt: PairingAttempt): Promise<void> {
  const body = attempt.mode === 'browser'
    ? await request(attempt,'/pairing/begin',{requestId:attempt.requestId,installationId:attempt.installationId,name:attempt.name,claimSecret:attempt.claimSecret})
    : await manualReservation(attempt);
  if(!uuid.test(body.requestId) || !uuid.test(body.libraryId) || attempt.mode === 'browser' && body.requestId !== attempt.requestId) throw new Error('Invalid pairing request.');
  const expiresAtMs = unixSecondsToMilliseconds(body.expiresAt);
  if(expiresAtMs > Date.now() + 301000 || expiresAtMs < attempt.createdAtMs - 1000) throw new Error('Invalid pairing expiry.');
  // A manual reservation is identified by its code on the server; exact retries return the same public UUID.
  if(attempt.mode === 'manual') {if(!(await current(attempt))) throw new Error('Connection attempt changed.'); attempt.requestId = body.requestId;}
  attempt.libraryId = body.libraryId; attempt.expiresAtMs = expiresAtMs; attempt.phase = 'pending'; attempt.error = undefined;
  attempt.legacy = attempt.mode === 'manual' && body.activationRequired !== true;
  await write(attempt);
}
async function openApproval(attempt: PairingAttempt): Promise<void> {
  try {await chrome.tabs.create({url:`${endpointURL(attempt.endpoint)}/extension-connect.html#request=${encodeURIComponent(attempt.requestId)}`}); if(!(await current(attempt))) return; attempt.error = undefined;}
  catch {attempt.error = 'tab-open-failed';}
  await save(attempt);
}
export function openPairingApproval(requestId: string): Promise<PairingView> {return connectionAction(async () => {const attempt = await read(); if(!attempt || attempt.requestId !== requestId || attempt.mode !== 'browser' || attempt.phase !== 'pending') throw new Error('This approval is no longer pending.'); await openApproval(attempt); return view(attempt);});}
async function begin(endpoint: string,name: string,manualCode?: string): Promise<PairingView> {
  endpoint = endpointURL(endpoint); const existing = await read();
  if(existing && !terminal.has(existing.phase)) {
    const resumed = await resumeLocked();
    if(!terminal.has(resumed.phase) && existing.error !== 'old-server') return resumed;
  }
  const prefs = await settings(); const createdAtMs = Date.now();
  const attempt: PairingAttempt = {requestId:crypto.randomUUID(),installationId:prefs.installationId,endpoint,name:String(name || 'Echo browser extension').slice(0,100),claimSecret:manualCode ?? Array.from(crypto.getRandomValues(new Uint8Array(32)),byte => byte.toString(16).padStart(2,'0')).join(''),createdAtMs,expiresAtMs:createdAtMs + 300000,phase:'beginning',pendingCount:0,mode:manualCode === undefined ? 'browser':'manual',legacy:manualCode !== undefined && existing?.endpoint === endpoint && existing.error === 'old-server'};
  await write(attempt);
  try {await reserve(attempt); if(attempt.mode === 'browser') await openApproval(attempt);}
  catch(error) {attempt.error = error instanceof ProtocolError && [404,405].includes(error.status) && attempt.mode === 'browser' ? 'old-server':failure(error); await save(attempt);}
  return view(attempt);
}
export function beginPairing(endpoint: string,name: string): Promise<PairingView> {return connectionAction(() => begin(endpoint,name));}
export function requestManualPairing(endpoint: string,name: string,code: string): Promise<PairingView> {
  code = String(code ?? '').trim(); if(!code || code.length > 128) return Promise.reject(new Error('Enter the pairing code shown in Echo settings.'));
  return connectionAction(() => begin(endpoint,name,code));
}
async function finish(attempt: PairingAttempt) {
  if(await cancellationRequested(attempt)) {attempt.cancelRequested = true; await save(attempt);}
  if(!(await current(attempt)) || !attempt.libraryId || !attempt.stagedCredential) throw new Error('Invalid connection receipt.');
  const pair = {endpoint:attempt.endpoint,libraryId:attempt.libraryId,credential:attempt.stagedCredential};
  await saveSettings(prefs => ({activeLibraryId:pair.libraryId,endpoint:pair.endpoint,pairs:{...prefs.pairs,[pair.libraryId]:pair}}));
  if(!(await current(attempt))) return;
  if(attempt.cancelRequested) {
    // Keep activation-sent until revocation is durable, so a restart retries it.
    await disconnectLocked(true); attempt.phase = 'cancelled';
  } else attempt.phase = 'connected';
  attempt.error = undefined; await save(attempt);
}
async function pendingLibrary(attempt: PairingAttempt): Promise<boolean> {
  const pending = (await allRecordings()).filter(row => !row.receipt && (row.chunkCount || ['recording','paused'].includes(row.captureState)));
  if(!(await current(attempt))) throw new Error('Connection attempt changed.');
  attempt.pendingCount = pending.length;
  return !attempt.confirmedLibrary && pending.some(row => !row.libraryId || row.libraryId !== attempt.libraryId);
}
async function activate(attempt: PairingAttempt): Promise<void> {
  const alreadySent = attempt.phase === 'activation-sent';
  if(!alreadySent && await cancellationRequested(attempt)) {await cancelBeforeActivation(attempt); return;}
  // This durable boundary must precede the request, including its first attempt.
  attempt.phase = 'activation-sent'; attempt.error = undefined; await save(attempt);
  // During this first send we can still prove no activation was dispatched. A
  // restarted worker has no such proof and must reconcile the saved receipt.
  if(!alreadySent && await cancellationRequested(attempt)) {await cancelBeforeActivation(attempt); return;}
  const body = await request(attempt,'/pairing/activate',{requestId:attempt.requestId,installationId:attempt.installationId,claimSecret:attempt.claimSecret,libraryId:attempt.libraryId});
  validateIdentity(body,attempt);
  if(body.status !== 'claimed' || body.activationRequired !== false || body.credential !== undefined && body.credential !== attempt.stagedCredential) throw new Error('Invalid activation receipt.');
  attempt.activationConfirmed = true; await save(attempt);
  await finish(attempt);
}
async function resumeLocked(): Promise<PairingView> {
  const attempt = await read(); if(!attempt || terminal.has(attempt.phase)) return view(attempt);
  try {
    if(await cancellationRequested(attempt)) {
      attempt.cancelRequested = true;
      if(attempt.phase !== 'activation-sent' && !attempt.legacy) {await cancelBeforeActivation(attempt); return view(attempt);}
      await save(attempt);
    }
    if(attempt.phase === 'activation-sent') {if(attempt.activationConfirmed) await finish(attempt); else await activate(attempt); return view(attempt);}
    if(Date.now() >= attempt.expiresAtMs) {attempt.phase = 'expired'; attempt.error = undefined; await save(attempt); return view(attempt);}
    if(attempt.phase === 'beginning') {
      if(attempt.error === 'old-server') return view(attempt);
      await reserve(attempt); if(attempt.mode === 'browser') await openApproval(attempt);
    }
    if(attempt.phase === 'confirm-library') return view(attempt);
    if(attempt.phase === 'pending') {
      const body = await request(attempt,'/pairing/claim',{requestId:attempt.requestId,installationId:attempt.installationId,code:attempt.claimSecret});
      if(body.status === 'pending') {attempt.error = attempt.error === 'tab-open-failed' ? attempt.error:undefined; await save(attempt); return view(attempt);}
      if(['cancelled','rejected'].includes(body.status)) {attempt.phase = body.status; attempt.error = undefined; await save(attempt); return view(attempt);}
      validateIdentity(body,attempt,!attempt.legacy);
      if(typeof body.credential !== 'string' || !body.credential || body.credential.length > 2048 || !['prepared','claimed','approved'].includes(body.status)) throw new Error('Invalid pairing receipt.');
      attempt.stagedCredential = body.credential; attempt.legacy = body.activationRequired !== true && body.status === 'approved'; attempt.phase = 'prepared'; attempt.error = undefined; await save(attempt);
      if(body.status === 'claimed') {await finish(attempt); return view(attempt);}
    }
    if(await pendingLibrary(attempt)) {attempt.phase = 'confirm-library'; await save(attempt); return view(attempt);}
    if(attempt.legacy) await finish(attempt); else await activate(attempt);
  } catch(error) {
    attempt.error = failure(error);
    // Server denial means reconciliation cannot restore authorization. Preserve any
    // old local connection, but permit a fresh user-initiated attempt.
    if(error instanceof ProtocolError && [401,403,410].includes(error.status)) attempt.phase = Date.now() >= attempt.expiresAtMs ? 'expired':'rejected';
    await save(attempt);
  }
  return view(attempt);
}
export function resumePairing(): Promise<PairingView> {return connectionAction(resumeLocked);}
export function confirmPairingLibrary(requestId: string): Promise<PairingView> {return connectionAction(async () => {
  const attempt = await read(); if(!attempt || attempt.requestId !== requestId || attempt.phase !== 'confirm-library') throw new Error('This library confirmation is no longer pending.');
  attempt.confirmedLibrary = true; attempt.phase = 'prepared'; await save(attempt); return resumeLocked();
});}
async function cancelLocked(): Promise<PairingView> {
  const attempt = await read(); if(!attempt || terminal.has(attempt.phase) && attempt.phase !== 'connected') return view(attempt);
  if(attempt.phase === 'connected') {
    const prefs = await settings();
    if(prefs.activeLibraryId !== attempt.libraryId || prefs.pairs[attempt.libraryId ?? '']?.credential !== attempt.stagedCredential) return view(attempt);
    attempt.activationConfirmed = true; attempt.phase = 'activation-sent';
  }
  if(attempt.phase === 'activation-sent' || attempt.legacy && attempt.stagedCredential) {
    attempt.cancelRequested = true; await save(attempt);
    if(attempt.legacy) {await finish(attempt); return view(attempt);}
    return resumeLocked();
  }
  await cancelBeforeActivation(attempt); return view(attempt);
}
async function cancelBeforeActivation(attempt: PairingAttempt) {
  // Local cancellation is durable before the network call; no later claim may activate it.
  attempt.phase = 'cancelled'; attempt.error = undefined; await save(attempt);
  try {await request(attempt,'/pairing/cancel',{requestId:attempt.requestId,installationId:attempt.installationId,claimSecret:attempt.claimSecret,libraryId:attempt.libraryId});} catch { /* A prepared credential has no authority. */ }
}
export function cancelPairing(): Promise<PairingView> {return recordCancellation().then(() => connectionAction(cancelLocked));}
export function disconnectPairing(confirmed: boolean): Promise<{status: 'disconnected'}> {
  if(!confirmed) return Promise.reject(new Error('Confirm disconnect first. Pending local audio will remain on this device.'));
  return recordCancellation().then(() => connectionAction(async () => {
  const cancelled = await cancelLocked();
  if(cancelled.phase === 'activation-sent') throw new Error('Finishing connection. Open Echo to confirm its status before disconnecting.');
  return disconnectLocked(true);
}));}
