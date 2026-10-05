import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import {readFile,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packageExtension} from '../scripts/package-extension.mjs';
import {EXTENSION_FILES,extensionId} from '../scripts/build-extension.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch = path.join(project,'tmp','extension-runtime','unit');
await mkdir(scratch,{recursive:true}); process.env.TMPDIR = scratch;
async function moduleFor(name) {const outfile = path.join(scratch,`${name}.mjs`); await build({entryPoints:[path.join(project,'extension','src',`${name}.ts`)],outfile,bundle:true,format:'esm',platform:'node',target:'node22'}); return import(pathToFileURL(outfile).href);}
const core = await moduleFor('core'); const adapters = await moduleFor('adapters'); const audio = await moduleFor('audio');
test('real server Unix-second expiry is validated and converted only at the UI boundary',() => {
  assert.equal(core.unixSecondsToMilliseconds(1791200000),1791200000000);
  for(const value of ['1791200000','2026-10-05T00:00:00Z',NaN,Infinity,0,-1,1.5,8640000000001]) assert.throws(() => core.unixSecondsToMilliseconds(value),/invalid expiry/);
});
test('loopback address is exact and meeting identity cannot escape provider hosts',() => {
  assert.equal(core.endpointURL('http://localhost:3000/'),'http://localhost:3000');
  assert.equal(core.endpointURL('http://[::1]:3000'),'http://[::1]:3000');
  for(const url of ['https://localhost:3000','http://localhost.evil:3000','http://user:pass@localhost:3000','http://127.0.0.2:3000','http://localhost:3000/a','http://localhost:3000/?q=1']) assert.throws(() => core.endpointURL(url));
  assert.equal(core.meetingFor('https://meet.google.com/abc-defg-hij').provider,'meet');
  assert.equal(core.meetingFor('https://app.zoom.com/wc/123456789/join').provider,'zoom');
  assert.equal(core.meetingFor('https://teams.cloud.microsoft/meet/123').provider,'teams');
  assert.equal(core.meetingFor('https://meet.google.com.evil/abc-defg-hij'),null);
});
test('microphone gate excludes stale, future, unknown and cross-document observations',() => {
  const identity = 'https://meet.google.com/abc-defg-hij'; const observation = {url:identity,state:'unmuted',seq:5,documentId:'document-1',receivedAt:1000};
  assert.equal(core.microphoneAllowed(observation,identity,'document-1',2999),true);
  assert.equal(core.microphoneAllowed(observation,identity,'document-1',3000),false);
  assert.equal(core.microphoneAllowed(observation,identity,'document-1',999),false);
  assert.equal(core.microphoneAllowed(observation,identity,'document-2',2000),false);
  for(const state of ['muted','prejoin','ended','unknown']) assert.equal(core.microphoneAllowed({...observation,state},identity,'document-1',2000),false);
});
test('provider microphone adapters fail closed on ambiguous/localized/prejoin/ended controls',() => {
  assert.equal(adapters.stateFromLabels('meet',['Turn off microphone (⌘ + d)'],[]),'unmuted');
  assert.equal(adapters.stateFromLabels('meet',['Turn on microphone'],[]),'muted');
  assert.equal(adapters.stateFromLabels('zoom',['Mute my audio'],[]),'unmuted');
  assert.equal(adapters.stateFromLabels('teams',['Unmute mic'],[]),'muted');
  for(const controls of [[],['Mikrofon ausschalten'],['Mute','Unmute'],['Mute','Mute']]) assert.equal(adapters.stateFromLabels('zoom',controls,[]),'unknown');
  assert.equal(adapters.stateFromLabels('teams',['Mute mic'],['Join now']),'prejoin');
  assert.equal(adapters.stateFromLabels('meet',['Turn off microphone'],['The meeting has ended']),'ended');
});
test('streaming 44.1/48 kHz resampling preserves duration across render blocks and headroom',() => {
  for(const sampleRate of [44100,48000]) {
    const converter = new audio.PCMResampler(sampleRate); let count = 0;
    for(let start = 0; start < sampleRate * 3; start += 128) count += converter.process(new Float32Array(Math.min(128,sampleRate * 3 - start)).fill(.5)).length;
    assert.ok(Math.abs(count - 48000) <= 1,`${sampleRate}: ${count}`);
  }
  assert.deepEqual([...audio.monoMix([Float32Array.of(1)],[Float32Array.of(1)],true,1)],[1]);
  assert.deepEqual([...audio.monoMix([Float32Array.of(.5)],[Float32Array.of(1)],false,1)],[.25]);
});
test('AudioWorklet keeps stale microphone out even when delayed gates arrive',async () => {
  const built = await build({entryPoints:[path.join(project,'extension/src/worklet.ts')],bundle:true,format:'iife',write:false});
  let Processor; let now = 1000; const sent = [];
  class Base {port = {postMessage:message => sent.push(message),onmessage:null};}
  const context = {AudioWorkletProcessor:Base,registerProcessor:(_name,value) => {Processor = value;},sampleRate:16000,currentTime:0,Date:{now:() => now},Float32Array,Int16Array,DataView,ArrayBuffer,Math,Number};
  vm.runInNewContext(built.outputFiles[0].text,context); const processor = new Processor({processorOptions:{recordingId:'worklet-recording'}}); let gateRevision = 0;
  const gate = data => processor.port.onmessage({data:{type:'gate',recordingId:'worklet-recording',gateRevision:++gateRevision,...data}});
  const block = () => processor.process([[new Float32Array(128)],[new Float32Array(128).fill(1)]],[[new Float32Array(128)]]);
  const flush = () => {processor.port.onmessage({data:{type:'pause',requestId:'flush'}}); const chunks = sent.splice(0).filter(item => item.type === 'pcm'); processor.port.onmessage({data:{type:'resume'}}); return chunks.flatMap(chunk => [...new Int16Array(chunk.pcm)]);};
  block(); assert.ok(flush().every(value => value === 0));
  gate({allowed:true,ttlMs:100,expiresAt:1100}); block(); assert.ok(flush().some(value => value > 0));
  gate({allowed:true,ttlMs:100,expiresAt:1100}); context.currentTime = .11; now = 1110; block(); assert.ok(flush().slice(1).every(value => value === 0));
  gate({allowed:true,ttlMs:2000,expiresAt:1099}); block(); assert.ok(flush().every(value => value === 0));
  gate({allowed:false,ttlMs:2000,expiresAt:now+2000}); gate({gateRevision:1,allowed:true,ttlMs:2000,expiresAt:now+2000}); block(); assert.ok(flush().every(value => value === 0),'reordered old unmute cannot replace a newer mute');
  gate({recordingId:'old-recording',allowed:true,ttlMs:2000,expiresAt:now+2000}); block(); assert.ok(flush().every(value => value === 0),'another recording cannot unmute this worklet');
  const stalled = new Processor({processorOptions:{recordingId:'stalled-recording'}}); sent.length = 0;
  for(let i=0;i<700;i++) stalled.process([[new Float32Array(128)]],[[new Float32Array(128)]]);
  assert.equal(sent.filter(message => message.type === 'pcm').reduce((n,message) => n + message.frames,0),80000);
  assert.equal(sent.filter(message => message.type === 'failed').length,1,'worklet itself stops at five seconds even if its host event loop is blocked');
});
async function protocolHarness() {
  const fakeStorage = `export async function allRecordings(){return [...globalThis.records.values()]}; export async function recording(id){return globalThis.records.get(id)}; export async function updateRecording(id,patch){const next={...globalThis.records.get(id),...patch};globalThis.records.set(id,next);return next};export async function getChunk(id,sequence){return globalThis.chunks.get(id+':'+sequence)};export async function retainReceiptAndRemovePCM(id,receipt){const row=globalThis.records.get(id);globalThis.records.set(id,{...row,receipt,transferState:'saved-echo'});globalThis.chunks.delete(id+':0')}`;
  const outfile = path.join(scratch,'protocol.mjs'); await build({entryPoints:[path.join(project,'extension/src/protocol.ts')],bundle:true,format:'esm',platform:'node',outfile,plugins:[{name:'fake-journal',setup(builder){builder.onResolve({filter:/^\.\/storage$/},() => ({path:'storage',namespace:'fake'}));builder.onLoad({filter:/.*/,namespace:'fake'},() => ({contents:fakeStorage,loader:'js'}));}}]});
  return import(pathToFileURL(outfile).href);
}
const protocol = await protocolHarness();
test('lost completion acknowledgement retains PCM, repeat verification then safely purges',async () => {
  const id = 'recording-1'; const row = {recordingId:id,libraryId:'library-1',title:'Synthetic meeting',provider:'meet',meetingUrl:'https://meet.google.com/abc-defg-hij',consent:true,liveTranscription:false,sampleRate:16000,channels:1,createdAt:'2026-10-05T00:00:00Z',chunkCount:1,totalFrames:100,captureState:'stopped',gaps:[],interrupted:false};
  globalThis.records = new Map([[id,row]]); globalThis.chunks = new Map([[id+':0',{pcm:new ArrayBuffer(200),frames:100,sha256:'a'.repeat(64)}]]);
  let sequence = 0; let complete = false; let loseComplete = true; let purgesChecked = false;
  const reply = () => ({protocolVersion:1,recordingId:id,libraryId:'library-1',meetingId:'meeting-1',status:complete ? 'complete':'receiving',nextSequence:sequence,totalFrames:sequence * 100,controls:[]});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url,options) => {
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit'); assert.equal(options.headers.get('Authorization'),'Bearer synthetic-token');
    if(url.endsWith('/chunks/0')) {assert.equal(options.headers.get('X-Echo-Frames'),'100'); assert.equal(options.body.byteLength,200); sequence = 1;}
    if(url.endsWith('/complete')) {complete = true; if(loseComplete) {loseComplete = false; throw new Error('Lost response');}}
    if(options.method === undefined && complete) {assert.ok(globalThis.chunks.has(id+':0'),'PCM retained until independent GET'); purgesChecked = true;}
    return new Response(JSON.stringify(reply()),{status:200});
  };
  try {
    const pair = {endpoint:'http://localhost:3000',libraryId:'library-1',credential:'synthetic-token'};
    await assert.rejects(protocol.transferOne(row,pair,async () => {}),/unavailable/); assert.ok(globalThis.chunks.has(id+':0')); assert.equal(globalThis.records.get(id).receipt,undefined);
    await protocol.transferOne(globalThis.records.get(id),pair,async () => {}); assert.equal(purgesChecked,true); assert.equal(globalThis.chunks.size,0); assert.equal(globalThis.records.get(id).receipt.libraryId,'library-1');
  } finally {globalThis.fetch = originalFetch;}
});
test('wrong-library and chunk conflicts preserve the complete local prefix',async () => {
  const row = {recordingId:'recording-2',libraryId:'library-1',chunkCount:1,totalFrames:100,captureState:'stopped'}; globalThis.records = new Map([[row.recordingId,row]]); globalThis.chunks = new Map([[row.recordingId+':0',{frames:100,pcm:new ArrayBuffer(200),sha256:'b'.repeat(64)}]]);
  const originalFetch = globalThis.fetch; const pair = {endpoint:'http://localhost:3000',libraryId:'library-1',credential:'synthetic-token'};
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({protocolVersion:1,recordingId:row.recordingId,libraryId:'wrong',status:'receiving',nextSequence:0,totalFrames:0}));
    await assert.rejects(protocol.transferOne(row,pair,async () => {}),/inconsistent/); assert.equal(globalThis.chunks.size,1);
    globalThis.fetch = async (url) => url.includes('/chunks/') ? new Response('{}',{status:409}) : new Response(JSON.stringify({protocolVersion:1,recordingId:row.recordingId,libraryId:'library-1',status:'receiving',nextSequence:0,totalFrames:0}));
    await protocol.transferPending({pairs:{'library-1':pair},activeLibraryId:'library-1'},async () => {},() => {}); assert.equal(globalThis.records.get(row.recordingId).transferState,'attention'); assert.equal(globalThis.chunks.size,1);
  } finally {globalThis.fetch = originalFetch;}
});
test('bounded transfer turns retain unfinished audio and complete only after the full manifest',async () => {
  const id = 'batch-recording'; const row = {recordingId:id,libraryId:'library-1',chunkCount:65,totalFrames:65,captureState:'stopped',gaps:[],createdAt:'2026-10-05T00:00:00Z'};
  globalThis.records = new Map([[id,row]]);globalThis.chunks = new Map(Array.from({length:65},(_,sequence) => [id+':'+sequence,{pcm:new ArrayBuffer(2),frames:1,sha256:'c'.repeat(64)}]));
  let nextSequence = 0; let completionCalls = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url,options) => {if(url.includes('/chunks/'))nextSequence++;if(url.endsWith('/complete'))completionCalls++;return new Response(JSON.stringify({protocolVersion:1,recordingId:id,libraryId:'library-1',meetingId:'meeting-1',status:completionCalls ? 'complete':'receiving',nextSequence,totalFrames:nextSequence}));};
  try {const pair={endpoint:'http://localhost:3000',libraryId:'library-1',credential:'synthetic'};await protocol.transferOne(row,pair,async () => {});assert.equal(nextSequence,64);assert.equal(completionCalls,0);assert.equal(globalThis.chunks.size,65);await protocol.transferOne(globalThis.records.get(id),pair,async () => {});assert.equal(nextSequence,65);assert.equal(completionCalls,1);assert.ok(globalThis.records.get(id).receipt);} finally {globalThis.fetch=originalFetch;}
});
test('an unreachable active library cannot starve another library’s durable recording',async () => {
  const offline={recordingId:'offline-active',libraryId:'offline-library',chunkCount:1,totalFrames:1,captureState:'recording',createdAt:'2026-10-05T00:00:01Z'};const healthy={recordingId:'healthy-pending',libraryId:'healthy-library',chunkCount:1,totalFrames:1,captureState:'stopped',gaps:[],createdAt:'2026-10-05T00:00:00Z'};
  globalThis.records=new Map([[offline.recordingId,offline],[healthy.recordingId,healthy]]);globalThis.chunks=new Map([offline,healthy].map(row => [row.recordingId+':0',{pcm:new ArrayBuffer(2),frames:1,sha256:'d'.repeat(64)}]));
  let now=1000000;let complete=false;let nextSequence=0;const originalFetch=globalThis.fetch;const originalNow=Date.now;
  Date.now=() => now;globalThis.fetch=async url => {if(url.startsWith('http://localhost:3999')){now+=15000;throw new Error('unreachable')}if(url.includes('/chunks/'))nextSequence=1;if(url.endsWith('/complete'))complete=true;return new Response(JSON.stringify({protocolVersion:1,recordingId:healthy.recordingId,libraryId:healthy.libraryId,meetingId:'healthy-meeting',status:complete ? 'complete':'receiving',nextSequence,totalFrames:nextSequence}))};
  try {const prefs={activeLibraryId:offline.libraryId,pairs:{[offline.libraryId]:{libraryId:offline.libraryId,endpoint:'http://localhost:3999',credential:'offline'},[healthy.libraryId]:{libraryId:healthy.libraryId,endpoint:'http://localhost:3000',credential:'healthy'}}};await protocol.transferPending(prefs,async () => {},() => {});assert.equal(globalThis.records.get(healthy.recordingId).receipt,undefined);await protocol.transferPending(prefs,async () => {},() => {});assert.ok(globalThis.records.get(healthy.recordingId).receipt);assert.ok(globalThis.chunks.has(offline.recordingId+':0'));} finally {Date.now=originalNow;globalThis.fetch=originalFetch;}
});
test('manifest uses scoped MV3 permissions, a stable identity and no content credential bridge',async () => {
  const manifest = JSON.parse(await readFile(path.join(project,'extension/manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,3); assert.equal(manifest.minimum_chrome_version,'120'); assert.equal(extensionId(manifest.key),'poonbmodjfijfbfiopememgfijahgbag');
  assert.deepEqual(manifest.permissions,['activeTab','tabCapture','scripting','offscreen','storage','unlimitedStorage','alarms']);
  assert.equal(manifest.externally_connectable,undefined); assert.equal(manifest.web_accessible_resources,undefined); assert.equal(manifest.content_scripts,undefined);
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  const content = await readFile(path.join(project,'extension/src/content.ts'),'utf8'); assert.ok(!/credential|Authorization|fetch\(/.test(content));
  const offscreen = await readFile(path.join(project,'extension/src/offscreen.ts'),'utf8'); assert.ok(!/chrome\.(?:storage|tabs|permissions|alarms|scripting)/.test(offscreen));
  const background=await readFile(path.join(project,'extension/src/background.ts'),'utf8');assert.ok(!background.includes('offscreen.hasDocument'));assert.ok(background.includes('chrome.runtime.getContexts'));
});
test('release ZIP only includes production assets; private stale output stays excluded',async () => {
  const outdir = path.join(scratch,'package-build'); const archive = path.join(scratch,'release.zip'); await mkdir(outdir,{recursive:true});
  for(const name of ['private.json','synthetic.wav','session.log']) await writeFile(path.join(outdir,name),'synthetic private fixture');
  await packageExtension({outdir,archive});
  const list = await promisify(execFile)('python3',['-c','import zipfile,sys,json;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive]);
  assert.deepEqual(JSON.parse(list.stdout).sort(),[...EXTENSION_FILES].sort());
  await symlink(path.join(outdir,'private.json'),path.join(outdir,'credential-link')); await assert.rejects(packageExtension({outdir,archive}),/symlinks/);
  await rm(path.join(outdir,'credential-link')); await writeFile(path.join(outdir,'unexpected.js'),'not a production entry'); await assert.rejects(packageExtension({outdir,archive}),/Unexpected executable/);
});
test.after(async () => {await rm(scratch,{recursive:true,force:true,maxRetries:3});});
