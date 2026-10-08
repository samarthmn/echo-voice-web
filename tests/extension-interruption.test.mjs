import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const fakeModules = {connection:'export async function connectionAction(work){return work()}; export async function connectionStatus(){return {status:"not-connected"}};export async function disconnect(){};export async function livePreview(){}','library-actions':'export async function openEcho(){}; export async function deleteLocalRecording(){}',settings:"export async function settings(){return {enabledProviders:['meet'],activeLibraryId:null}}; export async function saveSettings(){return {}}",storage:'export async function allRecordings(){return []}',protocol:'export async function jsonRequest(){throw new Error("unexpected network")}'};
const built = await build({entryPoints:['extension/src/background.ts'],bundle:true,format:'iife',write:false,plugins:[{name:'background-events',setup(builder){builder.onResolve({filter:/^\.\/(settings|storage|protocol|library-actions|connection)$/},args => ({path:args.path.slice(2),namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},args => ({contents:fakeModules[args.path]}));}}]});
function harness() {
  let owner={tabId:7,identity:'https://meet.google.com/abc-defg-hij',recordingId:'recording',documentId:'original',gateRevision:0}; let probeDocumentId='original'; const events={}; const sent=[];
  const event = name => ({addListener:listener => {events[name]=listener}});
  const context={URL,Date,Map,Promise,crypto:globalThis.crypto,setInterval(){},chrome:{runtime:{id:'synthetic',getURL:path => `chrome-extension://synthetic/${path}`,getContexts:async () => [{}],sendMessage:async message => {sent.push(message);return {ok:true,value:{}}},onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},permissions:{contains:async()=>true},tabCapture:{getMediaStreamId:async()=> 'stream'},scripting:{executeScript:async options => {assert.equal(options.target.tabId,7);if(options.func){assert.deepEqual([...options.target.frameIds],[0]);assert.equal(options.func(),undefined);}else assert.deepEqual([...options.files],['content.js']);if(probeDocumentId instanceof Error)throw probeDocumentId;return [{frameId:0,documentId:probeDocumentId}];}},storage:{session:{get:async () => ({captureOwner:owner}),set:async value => {owner=value.captureOwner},remove:async () => {owner=undefined},setAccessLevel:async () => {}}},tabs:{get:async()=>({id:7,url:'https://meet.google.com/abc-defg-hij'}),onRemoved:event('removed'),onUpdated:event('updated')},alarms:{onAlarm:event('alarm')}}};
  vm.runInNewContext(built.outputFiles[0].text,context);
  return {events,sent,owner:()=>owner,clear:()=>{owner=undefined},probe:documentId => {probeDocumentId=documentId},observation:(state='muted',documentId='original',url='https://meet.google.com/abc-defg-hij') => events.message({type:'MUTE_OBSERVATION',seq:1,observedAt:Date.now(),url,state},{id:'synthetic',tab:{id:7},frameId:0,documentId,url},()=>{}),pagehide:(patch={}) => {const url='https://meet.google.com/abc-defg-hij';events.message({type:'MEETING_PAGEHIDE',seq:1,observedAt:Date.now(),url,state:'unknown'},{id:'synthetic',tab:{id:7},frameId:0,documentId:'original',url,...patch},()=>{})}};
}
async function settle(){for(let i=0;i<3;i++)await new Promise(resolve => setImmediate(resolve));}
for(const [reason,trigger] of [
  ['meeting-changed',h => h.events.updated(7,{url:'https://meet.google.com/xyz-abcd-efg'},{url:'https://meet.google.com/xyz-abcd-efg'})],
  ['tab-closed',h => h.events.removed(7)],
  ['document-changed',h => h.observation('muted','new-document')],
  ['meeting-changed',h => h.observation('muted','original','https://meet.google.com/xyz-abcd-efg')],
  ['meeting-ended',h => h.observation('ended')],
]) test(`background ${reason} pathway sends a fixed interrupted-stop reason`,async () => {
  const h=harness();trigger(h);await settle();const control=h.sent.find(message => message.type==='CONTROL');assert.equal(control?.action,'stop');assert.equal(control.interrupted,true);assert.equal(control.interruptionReason,reason);assert.equal(control.recordingId,'recording');assert.equal(JSON.stringify(control).includes('https://'),false);
});
test('mute and unrelated tab loading do not stop a healthy recording',async () => {
  const h=harness();h.events.updated(8,{status:'loading'},{});h.observation('muted');await settle();assert.equal(h.sent.some(message => message.type==='CONTROL'),false);
});
test('same-document loading and completion keep capture active with microphone excluded during verification',async () => {
  const h=harness();h.events.updated(7,{status:'loading'},{url:'https://meet.google.com/abc-defg-hij'});await settle();h.events.updated(7,{status:'complete'},{url:'https://meet.google.com/abc-defg-hij'});await settle();assert.equal(h.sent.some(message=>message.type==='CONTROL'),false);assert.ok(h.sent.some(message=>message.type==='GATE'&&!message.allowed));
});
test('same-URL replacement is stopped using Chrome document identity even without a pagehide report',async () => {
  const h=harness();h.events.updated(7,{status:'loading'},{url:'https://meet.google.com/abc-defg-hij'});await settle();h.probe('replacement');h.events.updated(7,{status:'complete'},{url:'https://meet.google.com/abc-defg-hij'});await settle();assert.equal(h.sent.find(message=>message.type==='CONTROL')?.interruptionReason,'document-changed');
});
test('Start pins the owner document from Chrome injection even before a mute observation arrives',async()=> {
  const h=harness();h.clear();const reply=await new Promise(resolve=>h.events.message({type:'START',tabId:7,consent:true,micEnabled:false},{id:'synthetic',url:'chrome-extension://synthetic/popup.html'},resolve));assert.equal(reply.ok,true);assert.equal(h.owner().documentId,'original');
});
for(const documentId of [null,new Error('permission lost')]) test('an unavailable document probe stops conservatively',async()=> {const h=harness();h.probe(documentId);h.events.updated(7,{status:'loading'},{});await settle();assert.equal(h.sent.find(message=>message.type==='CONTROL')?.interruptionReason,'document-unavailable');});
test('original top-frame pagehide stops capture and excludes microphone before stop',async () => {
  const h=harness();h.pagehide();await settle();const stop=h.sent.findIndex(message=>message.type==='CONTROL');assert.ok(stop>0);assert.equal(h.sent[stop].interruptionReason,'document-changed');assert.ok(h.sent.slice(0,stop).some(message=>message.type==='GATE'&&!message.allowed));
});
for(const patch of [{frameId:1},{id:'another-extension'},{documentId:'unrelated-document'},{url:'https://private.invalid/'}]) test(`untrusted/subframe/stale document pagehide cannot stop the original capture: ${JSON.stringify(patch)}`,async () => {const h=harness();h.pagehide(patch);await settle();assert.equal(h.sent.some(message=>message.type==='CONTROL'),false);});
const contentBuilt = await build({entryPoints:['extension/src/content.ts'],bundle:true,format:'iife',write:false});
function contentHarness() {
  let now=1000;let nextTimer=0;let label='Turn off microphone';let scans=0;let failSend;
  const sent=[];const observers=[];const timers=new Map();const handlers=new Set();
  const addTimer=(callback,ms,repeat=false) => {const id=++nextTimer;timers.set(id,{callback,due:now+ms,interval:repeat?ms:0});return id;};
  const context=vm.createContext({__echoMuteObserverV1:true,URL,Date:class extends Date {static now(){return now;}},location:{href:'https://meet.google.com/abc-defg-hij'},document:{documentElement:{},querySelectorAll(selector){if(selector==='button,[role="button"]'){scans++;return [{getBoundingClientRect:()=>({width:40,height:40}),getAttribute:name=>name==='aria-label'?label:null,textContent:''}];}return [];}},getComputedStyle:()=>({visibility:'visible',display:'block'}),MutationObserver:class {constructor(callback){this.callback=callback;observers.push(this);}disconnected=false;observe(){}disconnect(){this.disconnected=true;}},setTimeout:(callback,ms)=>addTimer(callback,ms),clearTimeout:id=>timers.delete(id),setInterval:(callback,ms)=>addTimer(callback,ms,true),clearInterval:id=>timers.delete(id),window:{addEventListener(name,callback){handlers.add(callback);},removeEventListener(name,callback){handlers.delete(callback);}},chrome:{runtime:{sendMessage(message){if(failSend==='sync')throw new Error('extension invalidated');if(failSend==='async')return Promise.reject(new Error('extension invalidated'));sent.push(message);return Promise.resolve();}}}});
  const inject=()=>vm.runInContext(contentBuilt.outputFiles[0].text,context);inject();
  const advance=ms=>{const end=now+ms;for(;;){let first;for(const [id,timer] of timers)if(timer.due<=end&&(!first||timer.due<first[1].due))first=[id,timer];if(!first)break;const [id,timer]=first;now=timer.due;if(timer.interval)timer.due+=timer.interval;else timers.delete(id);timer.callback();}now=end;};
  return {sent,observers,timers,handlers,inject,advance,scans:()=>scans,label:value=>{label=value;},fail:value=>{failSend=value;},mutate:()=>{for(const observer of observers)if(!observer.disconnected)observer.callback();},pagehide:isTrusted=>{for(const handler of [...handlers])handler({isTrusted});}};
}
test('mutation bursts scan once per 100 ms and report the latest mute state without stale caching',() => {
  const h=contentHarness();assert.equal(h.scans(),1);assert.equal(h.sent[0].state,'unmuted');
  for(let i=0;i<1000;i++)h.mutate();assert.equal(h.scans(),1);assert.equal(h.timers.size,2);
  h.advance(50);h.label('Turn on microphone');h.mutate();h.advance(49);assert.equal(h.sent.length,1);
  h.advance(1);assert.equal(h.scans(),2);assert.equal(h.sent.at(-1).state,'muted');assert.equal(h.sent.at(-1).observedAt,1100);
  h.label('Unrecognized microphone control');
  for(let i=0;i<100;i++){h.advance(10);h.mutate();}
  assert.equal(h.sent.at(-1).state,'unknown');
  assert.equal(h.scans(),h.sent.length);assert.ok(h.sent.length<=12);
  for(let i=1;i<h.sent.length;i++)assert.ok(h.sent[i].observedAt-h.sent[i-1].observedAt>=100);
});
test('the independent 500 ms heartbeat scans fresh controls without mutation events',() => {
  const h=contentHarness();h.label('Turn on microphone');h.advance(500);assert.equal(h.sent.length,2);assert.equal(h.sent[1].state,'muted');assert.equal(h.sent[1].observedAt,1500);h.advance(500);assert.equal(h.sent.length,3);assert.equal(h.sent[2].observedAt,2000);
});
test('trusted pagehide sends unknown immediately and cancels pending scans; forged events do neither',() => {
  const h=contentHarness();h.advance(50);h.mutate();h.pagehide(false);assert.equal(h.sent.length,1);assert.equal(h.timers.size,2);
  h.pagehide(true);assert.equal(h.sent.length,2);assert.equal(h.sent[1].type,'MEETING_PAGEHIDE');assert.equal(h.sent[1].state,'unknown');assert.equal(h.sent[1].observedAt,1050);assert.equal(h.scans(),1);assert.equal(h.timers.size,0);assert.equal(h.handlers.size,0);assert.equal(h.observers[0].disconnected,true);h.advance(1000);assert.equal(h.sent.length,2);
});
test('reinjecting content cancels pending scans and preserves sequence across observer replacement',() => {
  const h=contentHarness();h.advance(50);h.mutate();assert.equal(h.timers.size,2);h.inject();
  assert.equal(h.observers.length,2);assert.equal(h.observers[0].disconnected,true);assert.equal(h.observers[1].disconnected,false);assert.equal(h.timers.size,1);assert.equal(h.handlers.size,1);assert.deepEqual(h.sent.map(message=>message.seq),[0,1]);
  h.advance(100);assert.equal(h.sent.length,2,'old trailing scan was cancelled');h.pagehide(true);assert.equal(h.sent.at(-1).seq,2);
});
for(const failure of ['sync','async']) test(`observer ${failure} runtime disconnect disposes heartbeat and pending mutation timer`,async () => {
  const h=contentHarness();h.advance(50);h.mutate();h.fail(failure);h.advance(50);await settle();assert.equal(h.observers[0].disconnected,true);assert.equal(h.timers.size,0);assert.equal(h.handlers.size,0);const scans=h.scans();h.advance(1000);h.mutate();assert.equal(h.scans(),scans);
});
