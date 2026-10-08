import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';

const id='11111111-1111-4111-8111-111111111111';
const oldLibrary='22222222-2222-4222-8222-222222222222';
const newLibrary='33333333-3333-4333-8333-333333333333';
const meeting='44444444-4444-4444-8444-444444444444';
const row=()=>({recordingId:id,libraryId:oldLibrary,captureState:'stopped',totalFrames:16000,chunkCount:1,receipt:undefined});
const prefs=()=>({activeLibraryId:newLibrary,endpoint:'http://localhost:3999',pairs:{[oldLibrary]:{libraryId:oldLibrary,endpoint:'http://localhost:3001'},[newLibrary]:{libraryId:newLibrary,endpoint:'http://localhost:3999'}}});
function locks() {
  const queues=new Map();
  return {request(name,options,work) {assert.equal(options.mode,'exclusive'); const task=(queues.get(name)??Promise.resolve()).then(work);queues.set(name,task.catch(()=>{}));return task;}};
}
const actionsBuild=await build({entryPoints:['extension/src/library-actions.ts'],bundle:true,write:false,format:'iife',globalName:'api',plugins:[{name:'library-mocks',setup(b){
  b.onResolve({filter:/^\.\/(settings|storage)$/},args=>({path:args.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path.endsWith('settings')?'export const settings=async()=>globalThis.prefs;':'export const recording=async id=>globalThis.rows.get(id);export const deleteRecording=async id=>{globalThis.deleted.push(id);globalThis.rows.delete(id)};'}));
}}]});
function actionsHarness() {
  const context={URL,navigator:{locks:locks()},prefs:prefs(),rows:new Map([[id,row()]]),deleted:[],opened:[],chrome:{tabs:{create:async value=>context.opened.push(value)}}};
  vm.runInNewContext(actionsBuild.outputFiles[0].text,context);return context;
}
test('receipt opens only its original library, never the current paired destination',async()=>{
  const h=actionsHarness();h.rows.get(id).receipt={libraryId:oldLibrary,meetingId:meeting};
  await h.api.openEcho(id);const url=new URL(h.opened[0].url);
  assert.equal(url.origin,'http://localhost:3001');assert.equal(url.searchParams.get('library'),oldLibrary);assert.equal(url.searchParams.get('meeting'),meeting);
  delete h.prefs.pairs[oldLibrary];await assert.rejects(h.api.openEcho(id),/different Echo library/);assert.equal(h.opened.length,1);
});
test('Echo links reject unsafe endpoints and malformed or cross-library receipts',()=>{
  const h=actionsHarness();const value={...row(),receipt:{libraryId:oldLibrary,meetingId:meeting}};
  h.prefs.pairs[oldLibrary].endpoint='https://example.invalid';assert.throws(()=>h.api.echoURL(h.prefs,value),/exact local Echo address/);
  h.prefs.pairs[oldLibrary].endpoint='http://localhost:3001';value.receipt.meetingId='../settings';assert.throws(()=>h.api.echoURL(h.prefs,value),/invalid Echo receipt/);
  value.receipt.meetingId=meeting;value.libraryId=newLibrary;assert.throws(()=>h.api.echoURL(h.prefs,value),/invalid Echo receipt/);
});
test('local deletion requires explicit confirmation and rejects the active recording',async()=>{
  const h=actionsHarness();await assert.rejects(h.api.deleteLocalRecording(id,false),/Confirm deletion/);
  await assert.rejects(h.api.deleteLocalRecording(id,true,id),/Stop this recording/);
  assert.equal(h.deleted.length,0);await h.api.deleteLocalRecording(id,true);assert.deepEqual(h.deleted,[id]);assert.equal(h.opened.length,0);
});
test('delete waits for an in-flight transfer holding the same cross-context lock',async()=>{
  const h=actionsHarness();let release;const transfer=h.navigator.locks.request(`echo-recording:${id}`,{mode:'exclusive'},()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();const deletion=h.api.deleteLocalRecording(id,true);await Promise.resolve();assert.equal(h.deleted.length,0);
  release();await transfer;await deletion;assert.deepEqual(h.deleted,[id]);
});
test('a queued transfer re-reads the journal after deletion and cannot recreate or upload the row',async()=>{
  const result=await build({entryPoints:['extension/src/protocol.ts'],bundle:true,write:false,format:'iife',globalName:'protocol',plugins:[{name:'transfer-journal',setup(b){
    b.onResolve({filter:/^\.\/storage$/},()=>({path:'storage',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const recording=async id=>globalThis.rows.get(id);export const allRecordings=async()=>[];export const getChunk=async()=>{throw Error("unexpected chunk")};export const updateRecording=async()=>{throw Error("unexpected update")};export const retainReceiptAndRemovePCM=async()=>{throw Error("unexpected receipt")};'}));
  }}]});
  const context={navigator:{locks:locks()},rows:new Map([[id,row()]]),fetch:()=>{throw Error('unexpected network')}};vm.runInNewContext(result.outputFiles[0].text,context);
  let release;const deletion=context.navigator.locks.request(`echo-recording:${id}`,{mode:'exclusive'},()=>new Promise(resolve=>{release=()=>{context.rows.delete(id);resolve();};}));
  await Promise.resolve();const transfer=context.protocol.transferOne(row(),prefs().pairs[oldLibrary],async()=>{});release();await deletion;await transfer;assert.equal(context.rows.size,0);
});

const storageBuild=await build({entryPoints:['extension/src/storage.ts'],bundle:true,write:false,format:'iife',globalName:'journal'});
function journalHarness(initialRow,pendingBytes=32000) {
  const data={recordings:new Map([[id,structuredClone(initialRow)]]),chunks:new Map([['chunk',{recordingId:id,sequence:0,pcm:new ArrayBuffer(32000)}]]),meta:new Map([['pendingBytes',{key:'pendingBytes',value:pendingBytes}]])};
  let strict=false;
  const db={transaction(names,mode,options){strict=options?.durability==='strict';const local=Object.fromEntries(Object.entries(data).map(([name,map])=>[name,structuredClone(map)]));let aborted=false;
    const request=value=>{const req={result:structuredClone(value)};queueMicrotask(()=>req.onsuccess?.());return req;};
    const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){return {get:key=>request(local[name].get(key)),put:value=>local[name].set(value.key??value.recordingId,structuredClone(value)),delete:key=>local[name].delete(key),index(){return {openCursor(target){const req={};const entries=[...local.chunks.entries()].filter(([,value])=>value.recordingId===target);let index=0;const next=()=>queueMicrotask(()=>{const entry=entries[index++];req.result=entry?{delete:()=>local.chunks.delete(entry[0]),continue:next}:null;req.onsuccess?.({target:req});});next();return req;}};}};}};
    setTimeout(()=>{if(!aborted){for(const name of names)data[name]=local[name];tx.oncomplete?.();}},0);return tx;}};
  const context={URL,Uint8Array,ArrayBuffer,Blob,IDBKeyRange:{only:value=>value},indexedDB:{open(){const req={result:db};queueMicrotask(()=>req.onsuccess?.());return req;}}};
  vm.runInNewContext(storageBuild.outputFiles[0].text,context);return {api:context.journal,data,strict:()=>strict};
}
test('atomic local audio deletion removes chunks and releases pending byte budget',async()=>{
  const h=journalHarness(row());await h.api.deleteRecording(id);assert.equal(h.strict(),true);assert.equal(h.data.recordings.size,0);assert.equal(h.data.chunks.size,0);assert.equal(h.data.meta.get('pendingBytes').value,0);
});
test('receipt removal leaves other recordings’ pending byte budget unchanged',async()=>{
  const h=journalHarness({...row(),receipt:{libraryId:oldLibrary,meetingId:meeting}});h.data.chunks.clear();await h.api.deleteRecording(id);assert.equal(h.data.meta.get('pendingBytes').value,32000);assert.equal(h.data.recordings.size,0);
});
test('recording and paused rows abort local deletion without mutating chunks or budget',async()=>{
  for(const captureState of ['recording','paused']){const h=journalHarness({...row(),captureState});await assert.rejects(h.api.deleteRecording(id),/Stop this recording/);assert.equal(h.data.recordings.size,1);assert.equal(h.data.chunks.size,1);assert.equal(h.data.meta.get('pendingBytes').value,32000);}
});
