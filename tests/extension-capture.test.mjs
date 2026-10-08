import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fakeStorage = `export async function allRecordings(){return [...journal.rows.values()]};export async function recording(id){return journal.rows.get(id)};export async function markInterrupted(){journal.recovered=true;for(const row of journal.rows.values())if(['recording','paused'].includes(row.captureState)){row.captureState='interrupted';row.interrupted=true}};export async function createRecording(row){journal.rows.set(row.recordingId,row)};export async function updateRecording(id,patch){if(journal.failMetadata)throw Object.assign(new Error('metadata quota'),{name:'QuotaExceededError'});const row={...journal.rows.get(id),...patch};journal.rows.set(id,row);return row};export async function appendChunk(id,sequence,pcm){if(journal.hold)await journal.hold;if(journal.quotaAt===sequence)throw Object.assign(new Error('quota'),{name:'QuotaExceededError'});const row=journal.rows.get(id);if(row.chunkCount!==sequence||row.captureState!=='recording')throw new Error('sequence');row.chunkCount++;row.totalFrames+=pcm.byteLength/2;journal.chunks.push({id,sequence,pcm});return {id,sequence,pcm}};export async function getChunk(){return undefined};export async function retainReceiptAndRemovePCM(){throw new Error('not expected')}`;
const built = await build({entryPoints:[path.join(project,'extension/src/offscreen.ts')],bundle:true,format:'iife',write:false,plugins:[{name:'mock-durable-storage',setup(builder){builder.onResolve({filter:/^\.\/storage$/},() => ({path:'storage',namespace:'fake'}));builder.onLoad({filter:/.*/,namespace:'fake'},() => ({contents:fakeStorage,loader:'js'}));}}]});
function harness({denyMic = false, micErrorName = 'NotAllowedError'} = {}) {
  const journal = {rows:new Map(),chunks:[],recovered:false,hold:null,quotaAt:-1,failMetadata:false}; const calls = []; const nodes = []; const streams = []; const notifications = []; const contexts = []; let listener;
  class Context {constructor(){contexts.push(this)}listeners = {};destination = {kind:'playback'}; state = 'running'; audioWorklet = {addModule:async () => {}};createMediaStreamSource(stream){const node = {stream,connections:[],connect(target,_output,input){this.connections.push({target,input});}}; nodes.push(node);return node}async resume(){}async close(){this.state='closed'}addEventListener(name,callback){this.listeners[name]=callback}}
  class Worklet {pendingPCM = null;messages = [];disconnected = false;port = {onmessage:null,postMessage:data => {
    this.messages.push(data);
    if(['pause','stop'].includes(data.type)) {if(this.pendingPCM) {this.emit(this.pendingPCM);this.pendingPCM=null;}this.port.onmessage({data:{type:'flushed',requestId:data.requestId}});}
  }};constructor(){nodes.push(this)}disconnect(){this.disconnected=true}connect(){}emit(pcm){this.port.onmessage({data:{type:'pcm',pcm,frames:pcm.byteLength/2}})}}
  const chrome = {runtime:{id:'synthetic',getURL:path => `chrome-extension://synthetic/${path}`,onMessage:{addListener:value => {listener=value}},sendMessage:async message => {
    notifications.push(message);if(message.type==='TRUSTED_SETTINGS')return {ok:true,value:{installationId:'synthetic',endpoint:'http://localhost:3000',pairs:{},activeLibraryId:null,enabledProviders:['meet'],micGranted:true}};return {};
  }}};
  const context = {chrome,journal,AudioContext:Context,AudioWorkletNode:Worklet,navigator:{mediaDevices:{getUserMedia:async constraints => {
    calls.push(constraints);if(calls.length%2===0&&denyMic)throw Object.assign(new Error('private-device-label must not be exposed'),{name:micErrorName});const track={stopped:false,listeners:{},stop(){this.stopped=true},addEventListener(name,callback){this.listeners[name]=callback}};const stream={getTracks:() => [track]};streams.push(stream);return stream;
  }}},crypto:globalThis.crypto,setInterval:() => 1,setTimeout,clearTimeout,Date,Promise,Map,ArrayBuffer,Number,Math,AbortSignal,Headers,Blob,URL,fetch:() => {throw new Error('no endpoint expected')}};
  vm.runInNewContext(built.outputFiles[0].text,context);
  const message = (data,sender = {id:'synthetic',url:'chrome-extension://synthetic/background.js'}) => new Promise(resolve => {const accepted=listener({...data,target:'offscreen'},sender,resolve);if(!accepted)resolve(undefined)});
  const start = (micEnabled = true) => message({type:'START',streamId:'synthetic-stream',micEnabled,micDeviceId:'selected-microphone',recording:{recordingId:'synthetic-recording',libraryId:null,title:'Synthetic capture',provider:'meet',meetingUrl:'https://meet.google.com/abc-defg-hij',consent:true,liveTranscription:false,sampleRate:16000,channels:1,createdAt:'2026-10-05T00:00:00Z'}});
  return {journal,calls,nodes,streams,notifications,contexts,message,start,worklet:() => nodes.find(node => node instanceof Worklet)};
}
async function settle() {for(let i=0;i<10;i++)await new Promise(resolve => setImmediate(resolve));}
test('offscreen uses runtime-only trusted settings and captures selected mic without feedback',async () => {
  const h = harness(); assert.equal((await h.start()).ok,true); assert.equal(h.journal.recovered,true);
  assert.equal(h.calls.length,2); assert.equal(h.calls[0].video,false); assert.equal(h.calls[1].video,false); assert.equal(h.calls[1].audio.deviceId.exact,'selected-microphone');
  const sources = h.nodes.filter(node => node.stream); assert.equal(sources[0].connections.length,2); assert.equal(sources[1].connections.length,1); assert.equal(sources[1].connections[0].target,h.worklet()); assert.equal(sources[1].connections[0].input,1);
  await h.message({type:'SYNC'}); assert.ok(h.notifications.some(message => message.type==='TRUSTED_SETTINGS'));
  assert.equal(await h.message({type:'START'},{id:'synthetic',url:'https://meet.google.com/abc-defg-hij',tab:{id:1}}),undefined);
  assert.equal(await h.message({type:'STATUS'},{id:'different-extension',url:'chrome-extension://synthetic/background.js'}),undefined);
  await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop'}); assert.ok(h.streams.every(stream => stream.getTracks()[0].stopped)); assert.equal(h.journal.rows.get('synthetic-recording').interruption,undefined);
});
test('microphone denial requires explicit tab-only retry and never silently downgrades capture',async () => {
  const h = harness({denyMic:true}); const denied = await h.start(); assert.equal(denied.ok,false); assert.match(denied.error,/explicitly choose tab audio only/); assert.equal(h.journal.rows.size,0); assert.equal(h.streams[0].getTracks()[0].stopped,true);
  const tabOnly = await h.start(false); assert.equal(tabOnly.ok,true); assert.equal(h.calls.length,3); const status = await h.message({type:'STATUS'}); assert.equal(status.value.active.mic,'tab-only'); await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop'});
});
for(const [micErrorName,expected] of [['NotAllowedError',/access was denied/],['SecurityError',/access was denied/],['NotFoundError',/selected microphone is unavailable/],['OverconstrainedError',/selected microphone is unavailable/],['NotReadableError',/could not be opened/],['AbortError',/startup was interrupted/],['UnexpectedError',/could not be started/]]) test(`microphone ${micErrorName} gives actionable bounded failure without automatic fallback`,async () => {
  const h=harness({denyMic:true,micErrorName});const result=await h.start();assert.equal(result.ok,false);assert.match(result.error,expected);assert.match(result.error,/explicitly choose tab audio only/);assert.equal(result.error.includes('private-device-label'),false);assert.equal(h.journal.rows.size,0);assert.equal(h.calls.length,2);assert.equal(h.streams[0].getTracks()[0].stopped,true);
});
test('microphone disconnection excludes its input while preserving healthy tab capture',async () => {
  const h = harness(); await h.start(); h.streams[1].getTracks()[0].listeners.ended();
  await h.message({type:'GATE',recordingId:'synthetic-recording',gateRevision:1,allowed:true,ttlMs:2000,expiresAt:Date.now()+2000,state:'unmuted'});
  const status = await h.message({type:'STATUS'}); assert.match(status.value.active.mic,/microphone disconnected/); assert.equal(h.worklet().messages.at(-1).allowed,false);
  h.worklet().emit(new ArrayBuffer(32000)); await settle(); assert.equal(h.journal.rows.get('synthetic-recording').captureState,'recording'); assert.equal(h.journal.rows.get('synthetic-recording').totalFrames,16000); assert.equal(h.streams[0].getTracks()[0].stopped,false);
  await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop'});
});
test('offscreen rejects old and recording-mismatched gates after a newer mute',async () => {
  const h = harness();await h.start(); const future = Date.now()+2000;
  await h.message({type:'GATE',recordingId:'synthetic-recording',gateRevision:2,allowed:false,ttlMs:2000,expiresAt:future,state:'muted'});
  await h.message({type:'GATE',recordingId:'synthetic-recording',gateRevision:1,allowed:true,ttlMs:2000,expiresAt:future,state:'unmuted'});
  await h.message({type:'GATE',recordingId:'another-recording',gateRevision:3,allowed:true,ttlMs:2000,expiresAt:future,state:'unmuted'});
  assert.match((await h.message({type:'STATUS'})).value.active.mic,/muted/);assert.equal(h.worklet().messages.at(-1).allowed,false);await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop'});
});
test('pause flushes durable PCM before state change, resumes with timeline gap, then stops tracks',async () => {
  const h = harness(); await h.start(false); const worklet = h.worklet(); worklet.emit(new ArrayBuffer(32000)); worklet.pendingPCM = new ArrayBuffer(2000);
  const pause = await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'pause'}); assert.equal(pause.ok,true); assert.equal(h.journal.rows.get('synthetic-recording').captureState,'paused'); assert.equal(h.journal.rows.get('synthetic-recording').totalFrames,17000);
  await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'pause'}); assert.equal(h.journal.rows.get('synthetic-recording').chunkCount,2);
  await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'resume'}); const resumed = h.journal.rows.get('synthetic-recording'); assert.equal(resumed.captureState,'recording'); assert.equal(resumed.gaps.length,1); assert.equal(resumed.gaps[0].atFrame,17000); assert.ok(resumed.gaps[0].pauseMs>=0);
  worklet.emit(new ArrayBuffer(32000)); await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop'}); assert.equal(h.journal.rows.get('synthetic-recording').totalFrames,33000); assert.equal(h.journal.rows.get('synthetic-recording').captureState,'stopped'); assert.equal((await h.message({type:'STATUS'})).value.active,null);
});
test('quota failure stops capture and preserves already committed prefix',async () => {
  const h = harness(); await h.start(false); h.worklet().emit(new ArrayBuffer(32000)); await settle(); h.journal.quotaAt = 1; h.worklet().emit(new ArrayBuffer(32000)); await settle();
  const row = h.journal.rows.get('synthetic-recording'); assert.equal(row.captureState,'interrupted'); assert.equal(row.totalFrames,16000); assert.equal(row.chunkCount,1); assert.match(row.error,/Storage quota was reached/); assert.equal(row.interruption.reason,'local-storage'); assert.equal(row.interruption.atFrame,16000); assert.equal(row.transferState,'attention'); assert.equal((await h.message({type:'STATUS'})).value.active,null);
});
test('a failed interruption metadata write still reports inactive capture and retained recovery audio',async () => {
  const h = harness();await h.start(false);h.worklet().emit(new ArrayBuffer(32000));await settle();h.journal.quotaAt=1;h.journal.failMetadata=true;h.worklet().emit(new ArrayBuffer(32000));await settle();
  const status = await h.message({type:'STATUS'});assert.equal(status.value.active,null);assert.match(status.value.error,/Storage quota was reached/);assert.equal(h.journal.rows.get('synthetic-recording').captureState,'recording');assert.equal(h.journal.rows.get('synthetic-recording').chunkCount,1);assert.equal(h.journal.chunks.length,1);
});
test('persistence backlog beyond five seconds interrupts and retains only durable prefix',async () => {
  const h = harness(); await h.start(false); let release; h.journal.hold = new Promise(resolve => {release=resolve}); h.worklet().emit(new ArrayBuffer(32000)); await settle();
  for(let i=0;i<5;i++)h.worklet().emit(new ArrayBuffer(32000)); release(); await settle();
  const row = h.journal.rows.get('synthetic-recording'); assert.equal(row.captureState,'interrupted'); assert.equal(row.chunkCount,1); assert.equal(row.totalFrames,16000); assert.match(row.error,/five seconds/); assert.ok(h.streams.every(stream => stream.getTracks()[0].stopped));
  assert.equal(row.interruption.reason,'save-backlog');
});
test('captured tab track ending flushes partial audio and records its fixed reason',async () => {
  const h = harness(); await h.start(false); h.worklet().emit(new ArrayBuffer(32000)); await settle(); h.worklet().pendingPCM = new ArrayBuffer(2000);
  h.streams[0].getTracks()[0].listeners.ended(); await settle(); const row = h.journal.rows.get('synthetic-recording');
  assert.equal(row.captureState,'interrupted'); assert.equal(row.totalFrames,17000); assert.equal(row.interruption.reason,'tab-track-ended'); assert.equal(row.interruption.atFrame,17000); assert.match(row.interruption.at,/^\d{4}-/);
});
test('AudioContext suspension retains a distinct diagnostic without flushing unsafe capture',async () => {
  const h = harness(); await h.start(false); h.worklet().emit(new ArrayBuffer(32000)); await settle(); h.contexts[0].state='suspended'; h.contexts[0].listeners.statechange(); await settle();
  assert.equal(h.journal.rows.get('synthetic-recording').interruption.reason,'audio-suspended'); assert.equal((await h.message({type:'STATUS'})).value.active,null);
});
test('only fixed interruption reasons are accepted from control messages',async () => {
  const h = harness(); await h.start(false); await h.message({type:'CONTROL',recordingId:'synthetic-recording',action:'stop',interrupted:true,interruptionReason:'https://private.invalid/meeting-title'});
  assert.equal(h.journal.rows.get('synthetic-recording').interruption.reason,'capture-failed');
});
