import {endpointURL, meetingFor, microphoneAllowed, Observation, Provider, validObservation, unixSecondsToMilliseconds} from './core';
import {allRecordings} from './storage';
import {jsonRequest} from './protocol';
import {settings, saveSettings} from './settings';
declare const chrome: any;
type Owner = {tabId: number; identity: string; recordingId: string; documentId?: string; gateRevision: number};
let owner: Owner | undefined; let starting = false; let makingOffscreen: Promise<void> | undefined;
let gateQueue: Promise<void> = Promise.resolve();
const observations = new Map<number,Observation>();
async function hasOffscreen(): Promise<boolean> {return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]})).length > 0;}
async function offscreen(): Promise<void> {
  if(await hasOffscreen()) return;
  if(!makingOffscreen) makingOffscreen = chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS'],justification:'Capture meeting audio after Start and persist local PCM for recovery and transfer.'}).finally(() => {makingOffscreen = undefined;});
  await makingOffscreen;
}
async function send(message: any) {
  await offscreen(); const reply = await chrome.runtime.sendMessage({...message,target:'offscreen'});
  if(!reply?.ok) throw new Error(reply?.error ?? 'The local audio recorder did not respond.'); return reply.value;
}
async function restoreOwner() {if(!owner) {const saved = (await chrome.storage.session.get('captureOwner')).captureOwner; if(!owner) owner = saved;}}
async function clearOwner() {owner = undefined; await chrome.storage.session.remove('captureOwner');}
async function setBadge(active: any) {
  const rows = await allRecordings(); const attention = rows.some(row => !row.receipt && (row.transferState === 'attention' || row.captureState === 'interrupted'));
  const text = active ? active.paused ? 'II':'REC' : attention ? '!':'';
  await chrome.action.setBadgeText({text}); await chrome.action.setBadgeBackgroundColor({color:active ? '#6858d9':'#af3543'});
  await chrome.action.setTitle({title:active ? active.paused ? 'Echo: recording paused':'Echo: recording meeting audio' : attention ? 'Echo: saved recording needs attention':'Echo recorder'});
}
async function gate() {
  gateQueue = gateQueue.catch(() => {}).then(async () => {
    await restoreOwner(); if(!owner || !(await hasOffscreen())) return;
    const capturedOwner = owner; const observation = observations.get(capturedOwner.tabId);
    capturedOwner.gateRevision = (capturedOwner.gateRevision ?? 0) + 1;
    const revision = capturedOwner.gateRevision; await chrome.storage.session.set({captureOwner:capturedOwner});
    // A newer mute report may arrive while session persistence is pending. Never send its predecessor.
    if(owner !== capturedOwner || observations.get(capturedOwner.tabId) !== observation) return;
    const allowed = microphoneAllowed(observation,capturedOwner.identity,capturedOwner.documentId);
    const age = observation ? Date.now() - observation.receivedAt : Infinity;
    const response = await chrome.runtime.sendMessage({target:'offscreen',type:'GATE',recordingId:capturedOwner.recordingId,gateRevision:revision,allowed,expiresAt:observation ? observation.receivedAt + 2000:0,ttlMs:allowed ? Math.max(0,2000 - age):0,state:age >= 2000 ? 'stale meeting controls':observation?.state ?? 'unknown mute state'});
    if(!response?.ok) throw new Error('Microphone gate did not respond.');
  });
  await gateQueue;
}
async function stopOwner(interrupted = true) {
  await restoreOwner(); if(!owner) return;
  const id = owner.recordingId; await send({type:'CONTROL',recordingId:id,action:'stop',interrupted}); await clearOwner();
}
async function start(message: any) {
  if(starting) throw new Error('A recording is already starting.'); starting = true;
  try {
    await restoreOwner(); if(owner) {if(await hasOffscreen() && (await send({type:'STATUS'})).active) throw new Error('A recording is already active. Stop it before starting another.'); await clearOwner();}
    if(message.consent !== true) throw new Error('Confirm that meeting participants consent before starting.');
    const tab = await chrome.tabs.get(message.tabId); const meeting = meetingFor(tab.url ?? ''); if(!meeting) throw new Error('Open a supported Google Meet, Zoom Web or Teams Web meeting tab.');
    const prefs = await settings(); if(!prefs.enabledProviders.includes(meeting.provider)) throw new Error('Enable this meeting provider in Echo extension setup.');
    if(message.micEnabled === true && !prefs.micGranted) throw new Error('Grant microphone permission in setup, or explicitly choose tab audio only.');
    if(!(await chrome.permissions.contains({origins:[meeting.originPattern]}))) throw new Error('This meeting provider needs permission in setup.');
    const title = String(message.title ?? tab.title ?? 'Meeting').trim().slice(0,200) || 'Meeting';
    await offscreen();
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
    const recordingId = crypto.randomUUID(); const observation = observations.get(tab.id);
    owner = {tabId:tab.id,identity:meeting.identity,recordingId,documentId:observation?.documentId,gateRevision:0};
    await chrome.storage.session.set({captureOwner:owner});
    try {
      const micDeviceId = typeof message.micDeviceId === 'string' && message.micDeviceId.length < 512 ? message.micDeviceId : 'default';
      const value = await send({type:'START',streamId,micEnabled:message.micEnabled === true,micDeviceId,recording:{recordingId,title,provider:meeting.provider,meetingUrl:tab.url,consent:true,liveTranscription:message.liveTranscription === true,sampleRate:16000,channels:1,createdAt:new Date().toISOString(),libraryId:prefs.activeLibraryId}});
      if(!owner || owner.recordingId !== recordingId || meetingFor((await chrome.tabs.get(tab.id)).url ?? '')?.identity !== meeting.identity) {await send({type:'CONTROL',recordingId,action:'stop',interrupted:true}); throw new Error('The meeting tab changed while recording started. Its committed audio is retained. Start again from the intended meeting.');}
      await saveSettings({micDeviceId});
      await gate(); return value;
    } catch(error) {await clearOwner(); throw error;}
  } finally {starting = false;}
}
async function pairRequest(message: any) {
  const current = await settings(); const endpoint = endpointURL(message.endpoint);
  const code = String(message.code ?? '').trim(); if(!code || code.length > 128) throw new Error('Enter the pairing code shown in Echo settings.');
  const request = await jsonRequest(endpoint,'/pairing/request',{method:'POST',body:JSON.stringify({code,installationId:current.installationId,name:String(message.name ?? 'Echo browser extension').slice(0,100)})});
  if(typeof request.requestId !== 'string' || typeof request.libraryId !== 'string') throw new Error('Echo returned an invalid pairing request.');
  const expiresAtMs = unixSecondsToMilliseconds(request.expiresAt);
  await chrome.storage.session.set({pairRequest:{...request,code,endpoint}}); return {requestId:request.requestId,expiresAtMs};
}
async function claimPair(confirmLibrary = false) {
  const prefs = await settings(); const stored = await chrome.storage.session.get(['pairRequest','pendingPair']);
  let pair = stored.pendingPair;
  if(!pair) {
    if(!stored.pairRequest) throw new Error('Enter a pairing code first.');
    const request = stored.pairRequest;
    const claim = await jsonRequest(request.endpoint,'/pairing/claim',{method:'POST',body:JSON.stringify({requestId:request.requestId,installationId:prefs.installationId,code:request.code})});
    if(claim.status === 'pending') return {status:'pending'};
    if(claim.status !== 'approved' || typeof claim.credential !== 'string' || !claim.credential || claim.libraryId !== request.libraryId) throw new Error('Echo returned an invalid pairing claim.');
    pair = {endpoint:request.endpoint,libraryId:claim.libraryId,credential:claim.credential};
  }
  const pending = (await allRecordings()).filter(row => !row.receipt && row.chunkCount);
  if(prefs.activeLibraryId && prefs.activeLibraryId !== pair.libraryId && pending.length && !confirmLibrary) {
    await chrome.storage.session.set({pendingPair:pair}); return {status:'confirm-library',pendingCount:pending.length};
  }
  // Retain old library credentials while their audio is pending. Recordings keep their original ownership.
  const approvedPair = pair;
  await saveSettings(current => ({activeLibraryId:approvedPair.libraryId,endpoint:approvedPair.endpoint,pairs:{...current.pairs,[approvedPair.libraryId]:approvedPair}}));
  await chrome.storage.session.remove(['pairRequest','pendingPair']); void send({type:'SYNC'}); return {status:'approved',libraryId:pair.libraryId};
}
async function state() {
  const prefs = await settings(); let active = null; let recoveryError: string | undefined;
  if(await hasOffscreen()) {const status = await send({type:'STATUS'}); active = status.active; recoveryError = status.error;}
  return {settings:{endpoint:prefs.endpoint,installationId:prefs.installationId,activeLibraryId:prefs.activeLibraryId,enabledProviders:prefs.enabledProviders,micGranted:prefs.micGranted,micDeviceId:prefs.micDeviceId},active,recoveryError,recordings:await allRecordings()};
}
chrome.runtime.onMessage.addListener((message: any,sender: any,respond: any) => {
  if(sender.id !== chrome.runtime.id) return false;
  const documentURL = typeof sender.url === 'string' ? sender.url.split(/[?#]/)[0] : '';
  const trustedPage = [chrome.runtime.getURL('popup.html'),chrome.runtime.getURL('setup.html')].includes(documentURL);
  if(sender.tab && !trustedPage) {
    if(message.type !== 'MUTE_OBSERVATION' || sender.frameId !== 0 || !sender.documentId || !validObservation(message) || sender.url !== message.url) return false;
    const previous = observations.get(sender.tab.id);
    if(previous?.documentId === sender.documentId && message.seq <= previous.seq) return false;
    const now = Date.now(); const fresh = Number.isFinite(message.observedAt) && message.observedAt <= now + 100 && now - message.observedAt < 2000;
    const received: Observation = {...message,state:fresh ? message.state:'unknown',documentId:sender.documentId,receivedAt:fresh ? message.observedAt:now};
    observations.set(sender.tab.id,received);
    const run = async () => {
      await restoreOwner();
      if(observations.get(sender.tab.id) !== received) return;
      if(owner?.tabId === sender.tab.id) {
        if(owner.documentId && owner.documentId !== sender.documentId || meetingFor(message.url)?.identity !== owner.identity || message.state === 'ended') {await stopOwner(); return;}
        if(!owner.documentId) {owner.documentId = sender.documentId; await chrome.storage.session.set({captureOwner:owner});}
      }
      if(observations.get(sender.tab.id) !== received) return; await gate();
    };
    run().catch(() => {}); return false;
  }
  if(message.target === 'offscreen') return false;
  if(sender.url === chrome.runtime.getURL('offscreen.html') && message.type === 'TRUSTED_SETTINGS') {settings().then(value => respond({ok:true,value}),error => respond({ok:false,error:(error as Error).message})); return true;}
  if(sender.url === chrome.runtime.getURL('offscreen.html') && message.type === 'CAPTURE_STATUS') {
    void setBadge(message.active); if(!message.active && message.endedRecordingId) void restoreOwner().then(() => {if(owner?.recordingId === message.endedRecordingId) void clearOwner();}); return false;
  }
  if(!trustedPage) return false;
  const run = async () => {
    if(message.type === 'STATE') return state();
    if(message.type === 'START') return start(message);
    if(message.type === 'CONTROL' && ['pause','resume','stop'].includes(message.action)) {
      await restoreOwner(); if(!owner || owner.recordingId !== message.recordingId) throw new Error('That recording is no longer active.');
      const response = await send({type:'CONTROL',recordingId:owner.recordingId,action:message.action}); if(message.action === 'stop') await clearOwner(); return response;
    }
    if(message.type === 'PAIR_REQUEST') return pairRequest(message);
    if(message.type === 'PAIR_CLAIM') return claimPair(message.confirmLibrary === true);
    if(message.type === 'SAVE_ENDPOINT') return saveSettings({endpoint:message.endpoint}).then(() => ({}));
    if(message.type === 'MIC_GRANTED') return saveSettings({micGranted:message.granted === true}).then(() => ({}));
    if(message.type === 'PROVIDER_ENABLED' && ['meet','zoom','teams'].includes(message.provider)) {
      await saveSettings(current => {
        const providers = current.enabledProviders.filter(p => p !== message.provider);
        if(message.enabled === true) providers.push(message.provider as Provider);
        return {enabledProviders:providers};
      }); return {};
    }
    if(message.type === 'SYNC') {void send({type:'SYNC'}); return {};}
    throw new Error('Unsupported extension action.');
  };
  run().then(value => respond({ok:true,value}),error => respond({ok:false,error:(error as Error).message})); return true;
});
chrome.tabs.onRemoved.addListener((tabId: number) => {void restoreOwner().then(() => {if(owner?.tabId === tabId) void stopOwner().catch(() => {});}); observations.delete(tabId);});
chrome.tabs.onUpdated.addListener((tabId: number,change: any,tab: any) => {void restoreOwner().then(() => {if(owner?.tabId === tabId && (change.status === 'loading' || change.url && meetingFor(tab.url ?? change.url)?.identity !== owner.identity)) void stopOwner().catch(() => {});});});
chrome.alarms.onAlarm.addListener((alarm: any) => {if(alarm.name === 'echo-transfer') void allRecordings().then(rows => {if(rows.some(row => !row.receipt && row.chunkCount)) void send({type:'SYNC'});});});
chrome.runtime.onInstalled.addListener(() => {void settings(); void chrome.alarms.create('echo-transfer',{periodInMinutes:0.5});});
chrome.runtime.onStartup.addListener(() => {void clearOwner(); void send({type:'SYNC'});});
setInterval(() => {void gate().catch(() => {});},1000);
void chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
