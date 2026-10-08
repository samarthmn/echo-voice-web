import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import {mkdir,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildExtension} from '../scripts/build-extension.mjs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch = path.join(project,'tmp','extension-runtime','browser');
process.env.TMPDIR = scratch;
test('unpacked MV3 runtime and real IndexedDB preserve durable prefix through interruption',async () => {
  await mkdir(scratch,{recursive:true}); const output = await buildExtension({outdir:path.join(scratch,'unpacked')});
  const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser':'/usr/bin/chromium');
  await access(executablePath);
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(scratch,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${output.outdir}`,`--load-extension=${output.outdir}`,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],env:{...process.env,TMPDIR:scratch}});
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker',{timeout:20000}); assert.ok(worker.url().endsWith('/background.js'));
    const page = await context.newPage(); const errors = []; page.on('pageerror',error => errors.push(error.message));
    await page.goto(`chrome-extension://${output.extensionId}/setup.html`); await page.locator('#paired').getByText('Not paired.').waitFor();
    const startup = await page.evaluate(async () => {const reply = await chrome.runtime.sendMessage({type:'STATE'}); return {ok:reply.ok,endpoint:reply.value?.settings?.endpoint,credentialsExposed:!!reply.value?.settings?.pairs};});
    assert.deepEqual(startup,{ok:true,endpoint:'http://localhost:3000',credentialsExposed:false});
    // This exercises real service-worker sender identity and an offscreen document with only chrome.runtime.
    await worker.evaluate(async () => {await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS'],justification:'Synthetic integration: verify offscreen trusted settings and local journal.'});});
    const response = await worker.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({target:'offscreen',type:'STATUS'});
      const sync = await chrome.runtime.sendMessage({target:'offscreen',type:'SYNC'});
      return {status,sync};
    });
    assert.equal(response.status.ok,true,JSON.stringify(response)); assert.equal(response.status.value.active,null); assert.equal(response.sync.ok,true,JSON.stringify(response));
    const credentialRequest = await page.evaluate(async () => chrome.runtime.sendMessage({type:'TRUSTED_SETTINGS'}));
    assert.equal(credentialRequest.ok,false); assert.match(credentialRequest.error,/Unsupported extension action/);
    const harness = await build({stdin:{contents:"import * as journal from './extension/src/storage.ts'; import * as core from './extension/src/core.ts'; globalThis.journal=journal;globalThis.core=core;",resolveDir:project,loader:'ts'},bundle:true,format:'iife',write:false,target:'chrome120'});
    await page.evaluate(harness.outputFiles[0].text);
    const saved = await page.evaluate(async () => {
      const row = {recordingId:crypto.randomUUID(),title:'Synthetic offline meeting',provider:'meet',meetingUrl:'https://meet.google.com/abc-defg-hij',consent:true,liveTranscription:false,sampleRate:16000,channels:1,createdAt:new Date().toISOString(),libraryId:null,chunkCount:0,totalFrames:0,captureState:'recording',transferState:'saved-local',gaps:[],interrupted:false};
      await journal.createRecording(row); const pcm = new ArrayBuffer(32000); const view = new DataView(pcm); for(let i = 0;i < 16000;i++) view.setInt16(i * 2,i % 100,true);
      const chunk = await journal.appendChunk(row.recordingId,0,pcm); let conflict = false;
      try {await journal.appendChunk(row.recordingId,0,pcm);} catch {conflict = true;}
      return {id:row.recordingId,sha256:chunk.sha256,conflict,totalFrames:(await journal.recording(row.recordingId)).totalFrames};
    }); assert.equal(saved.conflict,true); assert.equal(saved.totalFrames,16000); assert.match(saved.sha256,/^[a-f0-9]{64}$/);
    await page.reload(); await page.evaluate(harness.outputFiles[0].text);
    const recovered = await page.evaluate(async id => {
      await journal.markInterrupted(); const row = await journal.recording(id); const chunk = await journal.getChunk(id,0); const parts = [];
      for await(const part of journal.exportParts(id)) {const bytes = new Uint8Array(await part.blob.arrayBuffer()); parts.push({part:part.part,frames:part.frames,startFrame:part.startFrame,header:String.fromCharCode(...bytes.slice(0,4)),length:bytes.length});}
      let mismatchedReceipt = false; try {await journal.retainReceiptAndRemovePCM(id,{libraryId:'wrong-library',meetingId:'synthetic',verifiedAt:new Date().toISOString()});} catch {mismatchedReceipt = true;}
      return {state:row.captureState,interrupted:row.interrupted,interruption:row.interruption,totalFrames:row.totalFrames,hash:chunk.sha256,parts,mismatchedReceipt,retained:!!(await journal.getChunk(id,0))};
    },saved.id);
    assert.equal(recovered.state,'interrupted'); assert.equal(recovered.interrupted,true); assert.equal(recovered.hash,saved.sha256); assert.equal(recovered.retained,true); assert.equal(recovered.mismatchedReceipt,true);
    assert.equal(recovered.interruption.reason,'recorder-recovered'); assert.equal(recovered.interruption.atFrame,16000);
    assert.deepEqual(recovered.parts,[{part:1,frames:16000,startFrame:0,header:'RIFF',length:32044}]);
    // Bound persistence at exactly the eight-hour and 2 GiB limits without generating huge fixtures.
    const limits = await page.evaluate(async id => {
      await journal.updateRecording(id,{captureState:'recording',totalFrames:core.MAX_FRAMES}); let hours = false;
      try {await journal.appendChunk(id,1,new ArrayBuffer(2));} catch {hours = true;}
      await journal.updateRecording(id,{totalFrames:16000}); const db = await journal.database(); await new Promise((resolve,reject) => {const tx = db.transaction('meta','readwrite'); tx.objectStore('meta').put({key:'pendingBytes',value:core.MAX_PENDING_BYTES}); tx.oncomplete = resolve; tx.onerror = reject;}); let bytes = false;
      try {await journal.appendChunk(id,1,new ArrayBuffer(2));} catch {bytes = true;}
      return {hours,bytes,retained:!!(await journal.getChunk(id,0)),count:(await journal.recording(id)).chunkCount};
    },saved.id); assert.deepEqual(limits,{hours:true,bytes:true,retained:true,count:1});
    // Disk-full metadata updates can leave an inactive durable row marked recording. Export must remain accessible.
    await page.reload(); await page.locator('#recordings button').getByText('Export',{exact:true}).waitFor();
    await page.locator('#recordings button').getByText('Export',{exact:true}).click(); await page.locator('#download-part').waitFor();
    const timeline = await page.evaluate(async () => (await fetch(document.getElementById('download-timeline').href)).json());
    assert.equal(timeline.interrupted,true);assert.equal(timeline.totalFrames,16000);
    assert.deepEqual(errors,[]);
  } finally {if(context) await context.close(); await rm(scratch,{recursive:true,force:true,maxRetries:3});}
});
test('actual Echo server and unpacked extension pair, approve, ingest chunks and verify completion',async () => {
  const runRoot = path.join(project,'tmp','extension-runtime','wire');await mkdir(runRoot,{recursive:true});process.env.TMPDIR=runRoot;
  const data = path.join(runRoot,'data');await mkdir(data,{recursive:true});const output=await buildExtension({outdir:path.join(runRoot,'unpacked')});
  const socket=createServer();await new Promise((resolve,reject) => {socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)});const port=socket.address().port;await new Promise(resolve => socket.close(resolve));const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.env.ECHO_TEST_BINARY || path.join(project,'target/debug/echo-server'),[],{cwd:project,env:{...process.env,TMPDIR:runRoot,ECHO_DATA_DIR:data,ECHO_BIND:`127.0.0.1:${port}`,GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:''},stdio:['ignore','pipe','pipe']});let serverError;let logs='';server.on('error',error => {serverError=error});for(const output of [server.stdout,server.stderr])output.on('data',bytes => {logs=(logs+bytes.toString()).slice(-4000)});
  let context;
  const api=async (route,method='GET',body) => {const response=await fetch(base+route,{method,headers:{Origin:base,...(body ? {'Content-Type':'application/json'}:{})},body:body ? JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});assert.ok(response.ok,`${method} ${route}: ${response.status}`);return response.json()};
  try {
    let ready=false;for(let i=0;i<100;i++){if(serverError)throw serverError;if(server.exitCode!==null)throw new Error(`Isolated server exited: ${logs}`);try{const storage=await api('/api/storage');assert.equal(path.resolve(storage.path),path.resolve(data),'refuse a different server data folder');ready=true;break}catch(error){if(error.message.includes('different server'))throw error;await delay(100)}}assert.equal(ready,true,`Isolated server did not start: ${logs}`);
    const executablePath=process.env.CHROMIUM_PATH || (process.platform==='darwin' ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser':'/usr/bin/chromium');
    context=await chromium.launchPersistentContext(path.join(runRoot,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${output.outdir}`,`--load-extension=${output.outdir}`],env:{...process.env,TMPDIR:runRoot}});const networkErrors=[];context.on('response',async response => {if(response.url().includes('/extension/v1/')&&!response.ok()){const headers=await response.request().allHeaders();networkErrors.push({method:response.request().method(),status:response.status(),origin:headers.origin,error:await response.json().catch(() => null)})}});
    const worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker',{timeout:20000});const page=await context.newPage();await page.goto(`chrome-extension://${output.extensionId}/setup.html`);await page.locator('#paired').getByText('Not paired.').waitFor();
    const pairCode=await api('/api/extensions/pairing','POST',{});assert.equal(pairCode.protocolVersion,1);assert.equal(typeof pairCode.expiresAt,'number');
    await page.locator('#endpoint').fill(base);await page.locator('#code').fill(pairCode.code);await page.locator('#request').click();await page.locator('#status').getByText('Pairing request sent.',{exact:false}).waitFor({timeout:10000});
    const reservation=await worker.evaluate(async () => (await chrome.storage.session.get('pairRequest')).pairRequest);assert.equal(typeof reservation.expiresAt,'number');assert.equal(reservation.expiresAt,pairCode.expiresAt);
    const pending=await page.evaluate(async () => chrome.runtime.sendMessage({type:'PAIR_CLAIM'}));assert.equal(pending.ok,true);assert.equal(pending.value.status,'pending');
    await api(`/api/extensions/requests/${reservation.requestId}/approve`,'POST',{});await page.locator('#claim').click();await page.locator('#paired').getByText('Connected to library',{exact:false}).waitFor({timeout:10000});
    const state=await page.evaluate(async () => (await chrome.runtime.sendMessage({type:'STATE'})).value);assert.equal(state.settings.activeLibraryId,pairCode.libraryId);assert.equal(state.settings.pairs,undefined);
    const harness=await build({stdin:{contents:"import * as journal from './extension/src/storage.ts';globalThis.journal=journal;",resolveDir:project,loader:'ts'},bundle:true,format:'iife',write:false,target:'chrome120'});await page.evaluate(harness.outputFiles[0].text);
    const saved=await page.evaluate(async libraryId => {
      const id=crypto.randomUUID();await journal.createRecording({recordingId:id,title:'Synthetic real-wire recording',provider:'meet',meetingUrl:'https://meet.google.com/abc-defg-hij',consent:true,liveTranscription:false,sampleRate:16000,channels:1,createdAt:new Date().toISOString(),libraryId,chunkCount:0,totalFrames:0,captureState:'recording',transferState:'saved-local',gaps:[],interrupted:false});
      // 65 chunks span two fair transfer turns and exercise the server's whole-manifest completion fence.
      for(let sequence=0;sequence<65;sequence++){const pcm=new ArrayBuffer(32000);const view=new DataView(pcm);for(let frame=0;frame<16000;frame++)view.setInt16(frame*2,Math.round(Math.sin(frame/10)*1000),true);await journal.appendChunk(id,sequence,pcm)}
      const interruption={reason:'tab-loading',at:new Date().toISOString(),atFrame:65*16000}; await journal.updateRecording(id,{captureState:'interrupted',interrupted:true,interruption,error:'Synthetic transient capture error'});await chrome.runtime.sendMessage({type:'SYNC'});return {id,totalFrames:65*16000,interruption};
    },pairCode.libraryId);
    let receipt;for(let attempt=0;attempt<200;attempt++){receipt=await page.evaluate(async id => {const row=await journal.recording(id);return {receipt:row.receipt,state:row.transferState,error:row.error,interruption:row.interruption,chunkCount:row.chunkCount,totalFrames:row.totalFrames,pcmRemoved:!(await journal.getChunk(id,0))}},saved.id);if(receipt.receipt||receipt.state==='attention')break;await delay(100)}
    if(!receipt.receipt) {
      const serverRows=await api('/api/extensions/recordings');
      assert.fail(JSON.stringify({receipt,networkErrors,serverRows}));
    }
    assert.equal(receipt.receipt.libraryId,pairCode.libraryId);assert.equal(receipt.chunkCount,65);assert.equal(receipt.totalFrames,saved.totalFrames);assert.equal(receipt.pcmRemoved,true);
    assert.equal(receipt.error,undefined);assert.deepEqual(receipt.interruption,saved.interruption); await page.reload(); await page.locator('#recordings').getByText('Interrupted at 01:05: The meeting tab began loading.',{exact:true}).waitFor();
    const recordings=await api('/api/extensions/recordings');const imported=recordings.recordings.find(row => row.recordingId===saved.id);assert.ok(imported);assert.equal(imported.status,'complete');assert.equal(imported.nextSequence,65);assert.equal(imported.totalFrames,saved.totalFrames);assert.equal(imported.meetingId,receipt.receipt.meetingId);
  } finally {if(context)await context.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(resolve => server.once('exit',resolve)),delay(3000).then(() => server.kill('SIGKILL'))]);await rm(runRoot,{recursive:true,force:true,maxRetries:3});}
});
