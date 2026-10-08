import {PCMResampler, monoMix} from './audio';
declare const AudioWorkletProcessor: any;
declare function registerProcessor(name: string, processor: any): void;
declare const sampleRate: number;
declare const currentTime: number;
class EchoPCMProcessor extends AudioWorkletProcessor {
  private resampler = new PCMResampler(sampleRate); private pending = new Int16Array(16000); private used = 0;
  private generatedFrames = 0; private committedFrames = 0;
  private recordingId: string; private gateRevision = -1;
  private micAllowed = false; private gateUntil = -Infinity; private gateEpoch = -Infinity; private paused = false;
  private micExcluded = false; private exclusionRevision = -1;
  constructor(options: any) {super(); this.recordingId = options?.processorOptions?.recordingId; this.port.onmessage = ({data}: any) => {
    if(data.type === 'gate' && data.recordingId === this.recordingId && Number.isSafeInteger(data.gateRevision) && data.gateRevision > this.gateRevision) {this.gateRevision = data.gateRevision; this.micAllowed = data.allowed === true && Number.isFinite(data.ttlMs) && data.ttlMs > 0; this.gateUntil = currentTime + Math.max(0,Math.min(2000,data.ttlMs ?? 0)) / 1000; this.gateEpoch = data.expiresAt ?? -Infinity;}
    if(data.type === 'revoke-mic') {this.micAllowed = false; this.gateUntil = -Infinity; this.gateEpoch = -Infinity;}
    if(data.type === 'exclude-mic' && data.recordingId === this.recordingId && Number.isSafeInteger(data.exclusionRevision) && data.exclusionRevision > this.exclusionRevision) {this.exclusionRevision = data.exclusionRevision; this.micExcluded = data.excluded === true; this.micAllowed = false;}
    if(data.type === 'committed' && Number.isSafeInteger(data.throughFrame) && data.throughFrame >= this.committedFrames && data.throughFrame <= this.generatedFrames) this.committedFrames = data.throughFrame;
    if(data.type === 'pause' || data.type === 'stop') {this.paused = true; this.flush(); this.port.postMessage({type:'flushed',requestId:data.requestId});}
    if(data.type === 'resume') {this.paused = false; this.micAllowed = false; this.gateUntil = -Infinity;}
  };}
  private flush() {
    if(!this.used) return;
    // Encode explicitly little-endian; PCM is independent of the browser's machine byte order.
    const bytes = new ArrayBuffer(this.used * 2); const view = new DataView(bytes); for(let i = 0; i < this.used; i++) view.setInt16(i * 2,this.pending[i],true);
    this.port.postMessage({type:'pcm',pcm:bytes,frames:this.used},[bytes]); this.used = 0;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for(const output of outputs) for(const channel of output) channel.fill(0);
    if(this.paused) return true;
    const frames = inputs[0]?.[0]?.length ?? 128;
    const pcm = this.resampler.process(monoMix(inputs[0] ?? [],inputs[1] ?? [],!this.micExcluded && this.micAllowed && currentTime < this.gateUntil && Date.now() < this.gateEpoch,frames));
    for(const value of pcm) {
      if(this.generatedFrames - this.committedFrames >= 80000) {this.paused = true; this.micAllowed = false; this.port.postMessage({type:'failed',reason:'persistence-backlog'}); return true;}
      this.generatedFrames++; this.pending[this.used++] = value; if(this.used === this.pending.length) this.flush();
    }
    return true;
  }
}
registerProcessor('echo-pcm',EchoPCMProcessor);
