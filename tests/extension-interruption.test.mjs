import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const fakeModules = {settings:"export async function settings(){return {enabledProviders:['meet'],activeLibraryId:null}}; export async function saveSettings(){return {}}",storage:'export async function allRecordings(){return []}',protocol:'export async function jsonRequest(){throw new Error("unexpected network")}'};
const built = await build({entryPoints:['extension/src/background.ts'],bundle:true,format:'iife',write:false,plugins:[{name:'background-events',setup(builder){builder.onResolve({filter:/^\.\/(settings|storage|protocol)$/},args => ({path:args.path.slice(2),namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},args => ({contents:fakeModules[args.path]}));}}]});
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
test('content observer only forwards browser-trusted pagehide events',async () => {
  const result=await build({entryPoints:['extension/src/content.ts'],bundle:true,format:'iife',write:false});let pagehide;const sent=[];
  vm.runInNewContext(result.outputFiles[0].text,{URL,Date,location:{href:'https://meet.google.com/abc-defg-hij'},document:{documentElement:{},querySelectorAll:()=>[]},MutationObserver:class {observe(){}},setInterval(){},window:{addEventListener(name,callback){if(name==='pagehide')pagehide=callback}},chrome:{runtime:{sendMessage:async message=>{sent.push(message)}}}});
  sent.length=0;pagehide({isTrusted:false});assert.equal(sent.length,0);pagehide({isTrusted:true});assert.equal(sent.length,1);assert.equal(sent[0].type,'MEETING_PAGEHIDE');assert.equal(sent[0].state,'unknown');
});
test('reinjecting content replaces its observer, timer and lifecycle handler without resetting sequence; legacy marker does not block migration',async()=> {
  const result=await build({entryPoints:['extension/src/content.ts'],bundle:true,format:'iife',write:false});const sent=[];const observers=[];const timers=new Map();const handlers=new Set();let nextTimer=0;
  const context=vm.createContext({__echoMuteObserverV1:true,URL,Date,location:{href:'https://meet.google.com/abc-defg-hij'},document:{documentElement:{},querySelectorAll:()=>[]},MutationObserver:class {constructor(){observers.push(this)}disconnected=false;observe(){}disconnect(){this.disconnected=true}},setInterval(callback){const id=++nextTimer;timers.set(id,callback);return id},clearInterval(id){timers.delete(id)},window:{addEventListener(name,callback){handlers.add(callback)},removeEventListener(name,callback){handlers.delete(callback)}},chrome:{runtime:{sendMessage:async message=>{sent.push(message)}}}});
  vm.runInContext(result.outputFiles[0].text,context);vm.runInContext(result.outputFiles[0].text,context);
  assert.equal(observers.length,2);assert.equal(observers[0].disconnected,true);assert.equal(observers[1].disconnected,false);assert.equal(timers.size,1);assert.equal(handlers.size,1);assert.deepEqual(sent.map(message=>message.seq),[0,1]);
  [...handlers][0]({isTrusted:true});assert.equal(sent.at(-1).type,'MEETING_PAGEHIDE');assert.equal(sent.at(-1).seq,2);
});
