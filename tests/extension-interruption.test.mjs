import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const fakeModules = {settings:'export async function settings(){return {}}; export async function saveSettings(){return {}}',storage:'export async function allRecordings(){return []}',protocol:'export async function jsonRequest(){throw new Error("unexpected network")}'};
const built = await build({entryPoints:['extension/src/background.ts'],bundle:true,format:'iife',write:false,plugins:[{name:'background-events',setup(builder){builder.onResolve({filter:/^\.\/(settings|storage|protocol)$/},args => ({path:args.path.slice(2),namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},args => ({contents:fakeModules[args.path]}));}}]});
function harness() {
  let owner={tabId:7,identity:'https://meet.google.com/abc-defg-hij',recordingId:'recording',documentId:'original',gateRevision:0}; const events={}; const sent=[];
  const event = name => ({addListener:listener => {events[name]=listener}});
  const context={URL,Date,Map,Promise,setInterval(){},chrome:{runtime:{id:'synthetic',getURL:path => `chrome-extension://synthetic/${path}`,getContexts:async () => [{}],sendMessage:async message => {sent.push(message);return {ok:true,value:{}}},onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},storage:{session:{get:async () => ({captureOwner:owner}),set:async value => {owner=value.captureOwner},remove:async () => {owner=undefined},setAccessLevel:async () => {}}},tabs:{onRemoved:event('removed'),onUpdated:event('updated')},alarms:{onAlarm:event('alarm')}}};
  vm.runInNewContext(built.outputFiles[0].text,context);
  return {events,sent,observation:(state='muted',documentId='original',url='https://meet.google.com/abc-defg-hij') => events.message({type:'MUTE_OBSERVATION',seq:1,observedAt:Date.now(),url,state},{id:'synthetic',tab:{id:7},frameId:0,documentId,url},()=>{})};
}
async function settle(){for(let i=0;i<3;i++)await new Promise(resolve => setImmediate(resolve));}
for(const [reason,trigger] of [
  ['tab-loading',h => h.events.updated(7,{status:'loading'},{url:'https://meet.google.com/abc-defg-hij'})],
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
