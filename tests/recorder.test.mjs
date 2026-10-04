import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../web/recorder.js', import.meta.url), 'utf8');
const { createRecorderController } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
let now = 0;
let current;
let constraints;
class Track extends EventTarget {
  enabled = true;
  readyState = 'live';
  stop() { this.readyState = 'ended'; }
}
class Recorder extends EventTarget {
  static isTypeSupported(type) { return type.includes('webm'); }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  constructor(stream) { super(); this.stream = stream; current = this; }
  start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  chunk(text) { const event = new Event('dataavailable'); event.data = new Blob([text], {type:this.mimeType}); this.dispatchEvent(event); }
  stop() { this.state = 'inactive'; setTimeout(() => { this.chunk('final'); this.dispatchEvent(new Event('stop')); }, 0); }
}
function environment() {
  now = 0;
  const window = new EventTarget();
  window.isSecureContext = true;
  globalThis.window = window;
  globalThis.MediaRecorder = Recorder;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = { now: () => now };
  const track = new Track();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {mediaDevices: {getUserMedia: async (options) => { constraints = options; return {getTracks: () => [track], getAudioTracks: () => [track]}; }}}});
  return track;
}
const meeting = {id:'meeting-1', consent:true, gaps:[]};
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('captures only after explicit start, serializes chunks, excludes paused duration, and logs mute gaps', async () => {
  const track = environment();
  const calls=[];
  let pending=0;
  const controller=createRecorderController({request:async (path, options) => {
    if (options.method==='POST') {
      assert.equal(pending++,0);
      await tick();
      pending--;
      calls.push({sequence:options.body.get('sequence'),trackId:options.body.get('trackId')});
      return {};
    }
    const body=JSON.parse(options.body);
    if(body.status === 'recording') return {...meeting,...body};
    calls.push(body);
    return {...meeting,...body};
  }});
  assert.equal(controller.state.status,'idle');
  await controller.start({meeting,deviceId:'specific-mic',startMuted:true});
  assert.deepEqual(constraints.audio.deviceId,{exact:'specific-mic'});
  assert.equal(current.timeslice,5000);
  assert.equal(track.enabled,false);
  now=1000; controller.toggleMute(); assert.equal(track.enabled,true);
  current.chunk('first');
  controller.pause(); now=61000; controller.resume(); now=63000;
  const save=controller.stop();
  assert.equal(controller.state.status,'saving');
  assert.equal(controller.stop(), save);
  const result=await save;
  assert.equal(result.duration,3);
  assert.equal(result.status,'saved');
  assert.deepEqual(result.gaps,[{start:0,end:1,reason:'Microphone muted'}]);
  assert.deepEqual(calls.slice(0,2).map(x=>x.sequence),['0','1']);
  assert.equal(calls[0].trackId,calls[1].trackId);
  assert.equal(controller.state.status,'idle');
  assert.equal(track.readyState,'ended');
  controller.dispose();
});

test('failed audio upload stops capture and retains the failing and final chunks for retry', async () => {
  const track=environment();
  let failing=true; const sequences=[];
  const controller=createRecorderController({request:async (path,options)=>{
    if (options.method==='POST') {
      sequences.push(options.body.get('sequence'));
      if(failing) { const e=new Error('disk full'); e.status=507; throw e; }
      return {};
    }
    return {...meeting,...JSON.parse(options.body)};
  }});
  await controller.start({meeting}); now=5000; current.chunk('first');
  await new Promise(resolve=>setTimeout(resolve,2400));
  assert.equal(controller.state.status,'error');
  assert.equal(track.readyState,'ended');
  const unload = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(unload); assert.equal(unload.defaultPrevented,true);
  failing=false;
  const result=await controller.retry();
  assert.deepEqual(sequences,['0','0','0','0','1']);
  assert.equal(result.status,'interrupted');
  assert.equal(result.duration,5);
  controller.dispose();
});

test('a failed final metadata save can be retried without reuploading acknowledged audio', async () => {
  environment(); let patches=0, uploads=0;
  const controller=createRecorderController({request:async (path,options)=>{
    if(options.method==='POST') {uploads++;return {};}
    if(JSON.parse(options.body).status === 'recording') return meeting;
    if(++patches===1) throw new Error('temporary failure');
    return {...meeting,...JSON.parse(options.body)};
  }});
  await controller.start({meeting}); now=3000;
  await assert.rejects(controller.stop(),/temporary failure/);
  assert.equal(controller.state.status,'error');
  await controller.retry();
  assert.equal(uploads,1); assert.equal(patches,2);
  controller.dispose();
});

test('a disconnected microphone saves the final chunk as interrupted',async()=>{
  const track=environment(); let result;
  const controller=createRecorderController({request:async(path,options)=>options.method==='POST'?{}:({...meeting,...JSON.parse(options.body)})});
  await controller.start({meeting,onSaved:value=>result=value});
  now=2000; track.dispatchEvent(new Event('ended')); await tick();
  assert.equal(result.status,'interrupted');
  assert.match(controller.state.error,/disconnected/);
  controller.dispose();
});

test('device errors are actionable and do not prevent a later start',async()=>{
  environment(); let requests=0;
  const original=navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia=async()=>{requests++; throw new DOMException('missing','OverconstrainedError');};
  const controller=createRecorderController({request:async(path,options)=>options.method==='POST'?{}:({...meeting,...JSON.parse(options.body)})});
  assert.equal(requests,0);
  await assert.rejects(controller.start({meeting,deviceId:'missing'}),/selected microphone is unavailable/);
  assert.equal(requests,1);
  navigator.mediaDevices.getUserMedia=original;
  await controller.start({meeting}); await controller.stop(); controller.dispose();
});

test('server status is recorded before capture and failed setup releases the microphone',async()=>{
  const track=environment();
  const controller=createRecorderController({request:async(path,options)=>{
    assert.equal(current.state,'inactive');
    assert.deepEqual(JSON.parse(options.body),{status:'recording',error:''});
    throw new Error('Local server unavailable');
  }});
  await assert.rejects(controller.start({meeting}),/Local server unavailable/);
  assert.equal(track.readyState,'ended');
  assert.equal(current.state,'inactive');
  assert.equal(controller.state.status,'error');
  const unload=new Event('beforeunload',{cancelable:true});
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented,false);
  controller.dispose();
});
