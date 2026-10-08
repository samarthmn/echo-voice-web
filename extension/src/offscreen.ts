import {Recording, Settings, MAX_BACKLOG_FRAMES, MAX_FRAMES, MAX_PENDING_BYTES, InterruptionReason, interruption, INTERRUPTION_DESCRIPTIONS} from './core';
import {allRecordings, appendChunk, createRecording, markInterrupted, recording, updateRecording} from './storage';
import {transferPending} from './protocol';
declare const chrome: any;
type Capture = {id: string; context: AudioContext; worklet: AudioWorkletNode; tab: MediaStream; mic?: MediaStream; micDisconnected?: boolean; micExcluded: boolean; exclusionRevision: number; lastGateRevision: number; sequence: number; queuedFrames: number; persistedFrames: number; queue: Promise<void>; failed: boolean; pausedAt?: number; waiters: Map<string,() => void>; sourceState: string};
let active: Capture | undefined; let transition = false; let recoveryError: string | undefined;
let initializing: Promise<void> = markInterrupted().catch(error => {recoveryError = `Local recovery metadata could not be updated. Saved audio is retained for export. ${(error as Error).message}`;});
const activeStatus = () => active ? {recordingId:active.id,mic:active.mic ? active.sourceState:'tab-only',micCaptured:!!active.mic,micAvailable:!!active.mic && !active.micDisconnected,micExcluded:active.micExcluded,tab:true,paused:!!active.pausedAt}:null;
const publish = (endedRecordingId?: string) => chrome.runtime.sendMessage({target:'background',type:'CAPTURE_STATUS',endedRecordingId,active:activeStatus()}).catch(() => {});
async function trustedSettings(): Promise<Settings> {const response = await chrome.runtime.sendMessage({target:'background',type:'TRUSTED_SETTINGS'}); if(!response?.ok) throw new Error('Trusted recorder settings are unavailable.'); return response.value;}
function microphoneFailure(error: unknown): string {
  const name = (error as {name?: string} | null)?.name;
  const retry = ' Or explicitly choose tab audio only before starting.';
  if(name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Check browser and system microphone permissions in setup.' + retry;
  if(name === 'NotFoundError' || name === 'OverconstrainedError') return 'The selected microphone is unavailable. Choose System default or another microphone, then retry.' + retry;
  if(name === 'NotReadableError') return 'The microphone could not be opened. Check other audio apps and system microphone access, then retry.' + retry;
  if(name === 'AbortError') return 'Microphone startup was interrupted. Retry starting the recording.' + retry;
  return 'The microphone could not be started. Check the selected microphone and system microphone access, then retry.' + retry;
}
async function sync() {await transferPending(await trustedSettings(),control,() => publish());}
function cleanup(capture: Capture) {capture.worklet.disconnect(); capture.tab.getTracks().forEach(track => track.stop()); capture.mic?.getTracks().forEach(track => track.stop()); void capture.context.close();}
async function fail(capture: Capture, message: string, reason: InterruptionReason = 'capture-failed') {
  if(capture.failed) return; capture.failed = true; cleanup(capture); if(active === capture) active = undefined;
  await capture.queue.catch(() => {});
  await updateRecording(capture.id,{captureState:'interrupted',interrupted:true,interruption:interruption(reason,capture.persistedFrames),transferState:'attention',error:message}).catch(() => {recoveryError = message;}); publish(capture.id); void sync().catch(() => {});
}
async function flush(capture: Capture, type: string) {
  const requestId = crypto.randomUUID();
  const response = new Promise<void>((resolve,reject) => {
    const timer = setTimeout(() => {capture.waiters.delete(requestId); reject(new Error('Audio capture did not finish its local flush.'));},3000);
    capture.waiters.set(requestId,() => {clearTimeout(timer); resolve();});
  });
  capture.worklet.port.postMessage({type,requestId}); await response; await capture.queue; if(capture.failed) throw new Error('Recording stopped because local audio could not be safely saved.');
}
async function start(message: any) {
  await initializing; if(recoveryError) throw new Error(recoveryError); if(active || transition) throw new Error('A recording is already active.'); transition = true;
  let tab: MediaStream | undefined; let mic: MediaStream | undefined; let context: AudioContext | undefined;
  try {
    const rows = await allRecordings(); if(rows.filter(row => !row.receipt).reduce((n,row) => n + row.totalFrames * 2,0) >= MAX_PENDING_BYTES) throw new Error('Local pending audio has reached 2 GiB. Transfer recordings, or export and delete local copies, before starting.');
    tab = await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}} as any,video:false});
    if(message.micEnabled) {
      try {mic = await navigator.mediaDevices.getUserMedia({audio:{deviceId:message.micDeviceId ? {exact:message.micDeviceId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});}
      catch(error) {throw new Error(microphoneFailure(error));}
    }
    context = new AudioContext(); await context.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
    const worklet = new AudioWorkletNode(context,'echo-pcm',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1],processorOptions:{recordingId:message.recording.recordingId}});
    const row: Recording = {...message.recording,chunkCount:0,totalFrames:0,captureState:'recording',transferState:'saved-local',gaps:[],interrupted:false};
    await createRecording(row);
    const capture: Capture = {id:row.recordingId,context,worklet,tab,mic,micExcluded:false,exclusionRevision:0,lastGateRevision:-1,sequence:0,queuedFrames:0,persistedFrames:0,queue:Promise.resolve(),failed:false,waiters:new Map(),sourceState:'Excluded · unknown mute state'}; active = capture;
    worklet.port.onmessage = ({data}) => {
      if(data.type === 'flushed') {capture.waiters.get(data.requestId)?.(); capture.waiters.delete(data.requestId); return;}
      if(data.type === 'failed') {void fail(capture,'Local saving fell five seconds behind. Recording stopped; the committed audio prefix is retained.','save-backlog'); return;}
      if(data.type !== 'pcm' || capture.failed) return;
      capture.queuedFrames += data.frames;
      if(capture.queuedFrames > MAX_BACKLOG_FRAMES) {void fail(capture,'Local saving fell more than five seconds behind. Recording stopped; the committed audio prefix is retained.','save-backlog'); return;}
      const sequence = capture.sequence++;
      capture.queue = capture.queue.then(async () => {
        if(capture.failed) return;
        await appendChunk(capture.id,sequence,data.pcm); capture.queuedFrames -= data.frames;
        capture.persistedFrames += data.frames; capture.worklet.port.postMessage({type:'committed',throughFrame:capture.persistedFrames});
        const row = await recording(capture.id);
        if(row && row.totalFrames >= MAX_FRAMES) void control(capture.id,'stop');
      });
      capture.queue.catch(error => {void fail(capture,`Local storage stopped accepting audio. Recording stopped; the committed audio prefix is retained. ${(error as Error).name === 'QuotaExceededError' ? 'Storage quota was reached.' : (error as Error).message}`,'local-storage');});
    };
    const tabSource = context.createMediaStreamSource(tab); tabSource.connect(worklet,0,0);
    // tabCapture removes playback from the tab. Restore it separately, never feeding microphone playback.
    tabSource.connect(context.destination);
    if(mic) context.createMediaStreamSource(mic).connect(worklet,0,1);
    worklet.connect(context.destination); await context.resume();
    for(const track of tab.getTracks()) track.addEventListener('ended',() => {if(!capture.failed && active === capture) void control(capture.id,'stop',true,'tab-track-ended').catch(() => {});});
    for(const track of mic?.getTracks() ?? []) track.addEventListener('ended',() => {
      if(capture.failed || active !== capture) return;
      capture.micDisconnected = true; capture.sourceState = 'Excluded · microphone disconnected; tab audio continues'; capture.worklet.port.postMessage({type:'revoke-mic'}); publish();
    });
    context.addEventListener('statechange',() => {if(context?.state === 'suspended' && active === capture) void fail(capture,'Audio capture was suspended. Recording stopped and its committed audio is retained.','audio-suspended');});
    publish(); return {recordingId:row.recordingId};
  } catch(error) {tab?.getTracks().forEach(track => track.stop()); mic?.getTracks().forEach(track => track.stop()); if(context) void context.close(); if(active) {await updateRecording(active.id,{captureState:'interrupted',interrupted:true,interruption:interruption('start-failed',active.persistedFrames),transferState:'attention',error:(error as Error).message}); active = undefined;} throw error;}
  finally {transition = false;}
}
async function control(id: string, action: string, interrupted = false, reason: InterruptionReason = 'capture-failed') {
  const capture = active; if(!capture || capture.id !== id) return; if(transition) throw new Error('Recording is changing state. Retry the control.'); transition = true;
  try {
    if(action === 'pause' && !capture.pausedAt) {await flush(capture,'pause'); capture.pausedAt = Date.now(); capture.sourceState = 'excluded: paused'; await updateRecording(id,{captureState:'paused'});}
    if(action === 'resume' && capture.pausedAt) {
      const row = await recording(id); if(!row) throw new Error('Recording not found.');
      const gaps = [...row.gaps,{atFrame:row.totalFrames,pauseMs:Math.max(0,Date.now() - capture.pausedAt)}];
      await updateRecording(id,{captureState:'recording',gaps}); capture.pausedAt = undefined; capture.sourceState = 'excluded: unknown mute state'; capture.worklet.port.postMessage({type:'resume'});
    }
    if(action === 'stop') {
      await flush(capture,'stop'); const row = await recording(id);
      const gaps = row?.gaps ?? []; if(capture.pausedAt && row) gaps.push({atFrame:row.totalFrames,pauseMs:Math.max(0,Date.now() - capture.pausedAt)});
      active = undefined; cleanup(capture); await updateRecording(id,{captureState:interrupted ? 'interrupted':'stopped',interrupted,gaps,...(interrupted ? {interruption:interruption(reason,row?.totalFrames ?? capture.persistedFrames)} : {})});
    }
    publish(action === 'stop' ? id : undefined);
  } catch(error) {await fail(capture,(error as Error).message,'flush-failed'); throw error;} finally {transition = false;}
  if(action === 'stop') void sync().catch(() => {});
}
chrome.runtime.onMessage.addListener((message: any,sender: any,respond: any) => {
  if(message.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('background.js')) return false;
  const run = async () => {
    await initializing;
    if(message.type === 'START') return start(message);
    if(message.type === 'CONTROL') return control(message.recordingId,message.action,message.interrupted,Object.hasOwn(INTERRUPTION_DESCRIPTIONS,message.interruptionReason) ? message.interruptionReason : 'capture-failed');
    if(message.type === 'MIC_EXCLUSION') {
      if(!active || message.recordingId !== active.id) throw new Error('That recording is no longer active.');
      if(!active.mic || active.micDisconnected) throw new Error('This recording has no available microphone. Stop and start with microphone access to include it.');
      active.micExcluded = message.excluded === true; active.exclusionRevision++;
      active.sourceState = active.micExcluded ? 'Excluded · by you':'Excluded · waiting for meeting microphone state';
      active.worklet.port.postMessage({type:'exclude-mic',recordingId:active.id,exclusionRevision:active.exclusionRevision,excluded:active.micExcluded}); publish();
    }
    if(message.type === 'GATE' && active && message.recordingId === active.id && Number.isSafeInteger(message.gateRevision) && message.gateRevision > active.lastGateRevision) {active.lastGateRevision = message.gateRevision; const ttlMs = Math.max(0,Math.min(message.ttlMs ?? 0,(message.expiresAt ?? 0) - Date.now())); const allowed = message.allowed && ttlMs > 0 && !active.pausedAt && !active.micDisconnected && !active.micExcluded && !!active.mic; active.sourceState = active.micDisconnected ? 'Excluded · microphone disconnected; tab audio continues' : active.pausedAt ? 'Excluded · paused' : active.micExcluded ? 'Excluded · by you' : allowed ? 'Included · meeting microphone on' : `Excluded · ${message.state ?? 'unknown mute state'}`; active.worklet.port.postMessage({type:'gate',recordingId:active.id,gateRevision:message.gateRevision,allowed,ttlMs,expiresAt:message.expiresAt}); publish();}
    if(message.type === 'SYNC') await sync();
    if(message.type === 'STATUS') return {active:activeStatus(),error:recoveryError};
    return {};
  };
  run().then(value => respond({ok:true,value}),error => respond({ok:false,error:(error as Error).message})); return true;
});
setInterval(() => {void sync().catch(() => {});},1000);
void initializing.then(() => {publish(); void sync().catch(() => {});});
