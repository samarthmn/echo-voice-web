// A streaming interpolation resampler preserves phase across render blocks at 44.1/48 kHz.
export class PCMResampler {
  private inputRate: number; private position = 0; private previous = 0; private seen = 0;
  constructor(inputRate: number) {this.inputRate = inputRate;}
  process(input: Float32Array): Int16Array {
    const result: number[] = []; const step = this.inputRate / 16000; const end = this.seen + input.length;
    while(this.position < end - 1) {
      const left = Math.floor(this.position); const fraction = this.position - left;
      const a = left < this.seen ? this.previous : input[left - this.seen];
      const b = input[left + 1 - this.seen]; const sample = Math.max(-1,Math.min(1,a + (b - a) * fraction));
      result.push(Math.round(sample < 0 ? sample * 32768 : sample * 32767)); this.position += step;
    }
    if(input.length) this.previous = input[input.length - 1]; this.seen = end; return Int16Array.from(result);
  }
}
export function monoMix(tab: Float32Array[], mic: Float32Array[], allowMic: boolean, frames: number): Float32Array {
  const result = new Float32Array(frames);
  for(let i = 0; i < frames; i++) {
    let tabValue = 0; for(const channel of tab) tabValue += channel[i] || 0;
    let micValue = 0; if(allowMic) for(const channel of mic) micValue += channel[i] || 0;
    // Fixed source gains leave headroom without changing tab loudness when the microphone gate changes.
    result[i] = Math.max(-1,Math.min(1,0.5 * (tab.length ? tabValue / tab.length : 0) + 0.5 * (allowMic && mic.length ? micValue / mic.length : 0)));
  }
  return result;
}
