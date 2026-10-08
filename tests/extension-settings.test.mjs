import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';

const built = await build({entryPoints:['extension/src/settings.ts'],bundle:true,write:false,format:'iife',globalName:'settingsAPI'});
function harness(initial) {
  let stored = initial && structuredClone(initial); let uuidCalls = 0; let failNext = false;
  const context = {crypto:{randomUUID:() => `installation-${++uuidCalls}`},URL,chrome:{storage:{local:{
    async setAccessLevel() {},
    async get() {return {settings:stored && structuredClone(stored)};},
    async set(value) {if(failNext) {failNext = false; throw new Error('write failed');} stored = structuredClone(value.settings);},
  }}}};
  vm.runInNewContext(built.outputFiles[0].text,context);
  return {api:context.settingsAPI,read:() => stored,uuidCalls:() => uuidCalls,fail:() => {failNext = true;}};
}
const defaults = {installationId:'existing-installation',endpoint:'http://localhost:3000',activeLibraryId:'library',pairs:{library:{credential:'existing-credential'}},enabledProviders:[],micGranted:false,micDeviceId:'default'};
test('concurrent first reads create one durable installation identity',async () => {
  const h = harness(); const rows = await Promise.all([h.api.settings(),h.api.settings(),h.api.settings()]);
  assert.equal(new Set(rows.map(row => row.installationId)).size,1); assert.equal(h.uuidCalls(),1);
});
test('concurrent provider and microphone saves preserve both preferences and pairing',async () => {
  const h = harness(defaults);
  await Promise.all([h.api.saveSettings({enabledProviders:['meet']}),h.api.saveSettings({micGranted:true})]);
  assert.deepEqual(h.read().enabledProviders,['meet']); assert.equal(h.read().micGranted,true);
  assert.deepEqual(h.read().pairs,defaults.pairs); assert.equal(h.read().activeLibraryId,'library');
});
test('queued provider updates derive their lists from the latest saved state and recover after a failed write',async () => {
  const h = harness(defaults);
  await Promise.all(['meet','zoom'].map(provider => h.api.saveSettings(current => ({enabledProviders:[...current.enabledProviders,provider]}))));
  assert.deepEqual(h.read().enabledProviders,['meet','zoom']);
  h.fail(); await assert.rejects(h.api.saveSettings({micGranted:true}),/write failed/);
  await h.api.saveSettings({micDeviceId:'selected'}); assert.equal(h.read().micDeviceId,'selected');
});
test('an open popup refreshes provider status without resetting an explicit microphone choice',async () => {
  const elements = new Map(); const element = id => {if(!elements.has(id))elements.set(id,{textContent:'',value:'',checked:false,hidden:false,append(){},addEventListener(){}});return elements.get(id);};
  let enabled = []; let interval;
  const ui = `export const element=globalThis.element; export async function request(){return {settings:{enabledProviders:globalThis.providers(),micGranted:false},active:null,recordings:[]}}; export const renderRecordings=()=>{}; export const showError=error=>{throw error}; export const action=async fn=>fn(); export const duration=()=>'';`;
  const result = await build({entryPoints:['extension/src/popup.ts'],bundle:true,write:false,format:'iife',plugins:[{name:'popup-state',setup(builder){builder.onResolve({filter:/^\.\/ui$/},() => ({path:'ui',namespace:'mock'}));builder.onLoad({filter:/.*/,namespace:'mock'},() => ({contents:ui}));}}]});
  const context = {URL,element,providers:() => enabled,setInterval:callback => {interval = callback;},document:{createElement:() => ({})},chrome:{tabs:{query:async () => [{id:1,url:'https://meet.google.com/abc-defg-hij',title:'Meeting'}]}},navigator:{mediaDevices:{enumerateDevices:async () => []}}};
  vm.runInNewContext(result.outputFiles[0].text,context);
  await new Promise(resolve => setImmediate(resolve)); assert.match(element('meeting').textContent,/Not enabled/);
  element('mic').checked = false; enabled = ['meet']; interval(); await new Promise(resolve => setImmediate(resolve));
  assert.match(element('meeting').textContent,/Enabled/); assert.equal(element('mic').checked,false);
});
