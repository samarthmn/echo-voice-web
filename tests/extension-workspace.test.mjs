import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionImportMonitor} from '../web/extension-workspace.js';
test('only complete durable imports trigger saved workflow; retries do not duplicate processing',async()=>{
  let status='receiving';let calls=0;const saved=[];
  const monitor=createExtensionImportMonitor({request:async path=>path==='/extensions/recordings'?{recordings:[{recordingId:'one',meetingId:'m',status}]}:{id:'m',tracks:[{id:'audio'}]},onSaved:m=>saved.push(m.id),onChange:()=>calls++,timers:{setTimeout(){},clearTimeout(){}}});
  await monitor.poll();assert.deepEqual(saved,[]);status='complete';await monitor.poll();await monitor.poll();assert.deepEqual(saved,['m']);assert.equal(calls,1);monitor.stop();
});
test('temporary Echo outage preserves later completion and remains retryable',async()=>{
  let offline=true;let saved=0;let ready=0;const monitor=createExtensionImportMonitor({request:async path=>{if(offline)throw Error('offline');return path==='/extensions/recordings'?{recordings:[{recordingId:'one',meetingId:'m',status:'complete'}]}:{id:'m',tracks:[{}]};},onReady:()=>ready++,onSaved:()=>saved++,onChange:()=>{},timers:{setTimeout(){},clearTimeout(){}}});
  await monitor.poll();assert.equal(saved,0);offline=false;await monitor.poll();assert.equal(saved,0);assert.equal(ready,1);monitor.stop();
});

test('historical imports can resume processing without save notifications or navigation on each workspace load',async()=>{
  const ready=[];const saved=[];let changes=0;
  for(let load=0;load<2;load++) {
    const monitor=createExtensionImportMonitor({request:async path=>path==='/extensions/recordings'?{recordings:[{recordingId:'old',meetingId:'m',status:'complete'}]}:{id:'m',tracks:[{}],transcripts:[{}]},onReady:m=>ready.push(m.id),onSaved:m=>saved.push(m.id),onChange:()=>changes++,timers:{setTimeout(){},clearTimeout(){}}});
    await monitor.poll();await monitor.poll();monitor.stop();
  }
  assert.deepEqual(ready,['m','m']);assert.deepEqual(saved,[]);assert.equal(changes,0);
});

test('receiving imports enter the library and advance duration without triggering final processing or navigation',async()=>{
  let frames=1600000;let final=false;const progress=[];const saved=[];const ready=[];let meetingReads=0;
  const monitor=createExtensionImportMonitor({request:async path=>path==='/extensions/recordings'?{recordings:[{recordingId:'active',meetingId:'m',status:final?'complete':'receiving',totalFrames:frames}]}:(meetingReads++,{id:'m',duration:frames/16000,extensionRecording:{totalFrames:frames},tracks:final?[{id:'audio'}]:[]}),onProgress:m=>progress.push(m.duration),onSaved:m=>saved.push(m.id),onReady:m=>ready.push(m.id),onChange:()=>{},timers:{setTimeout(){},clearTimeout(){}}});
  await monitor.poll();await monitor.poll();assert.deepEqual(progress,[100]);assert.equal(meetingReads,1);assert.deepEqual(saved,[]);assert.deepEqual(ready,[]);
  frames=5760000;await monitor.poll();assert.deepEqual(progress,[100,360]);assert.deepEqual(saved,[]);
  final=true;await monitor.poll();assert.deepEqual(saved,['m']);assert.deepEqual(ready,['m']);monitor.stop();
});
test('a stopped workspace monitor does not publish a late receiving response',async()=>{
  let reply;const progress=[];const monitor=createExtensionImportMonitor({request:()=>new Promise(resolve=>{reply=resolve;}),onProgress:m=>progress.push(m),onSaved:()=>{},onChange:()=>{},timers:{setTimeout(){},clearTimeout(){}}});
  const polling=monitor.poll();monitor.stop();reply({recordings:[{recordingId:'r',meetingId:'m',status:'receiving'}]});await polling;assert.deepEqual(progress,[]);
});
