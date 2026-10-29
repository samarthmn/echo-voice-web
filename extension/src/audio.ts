// A streaming interpolation resampler preserves phase across render blocks at 44.1/48 kHz.
// The audio thread reuses its buffers; a returned view is valid until the next call.
export class PCMResampler {
  private inputRate: number;
  private position = 0;
  private previous = 0;
  private seen = 0;
  private output = new Int16Array(0);
  constructor(inputRate: number) {
    this.inputRate = inputRate;
  }
  process(input: Float32Array): Int16Array {
    const step = this.inputRate / 16000;
    const end = this.seen + input.length;
    const capacity = Math.ceil(input.length / step) + 1;
    if (this.output.length < capacity) this.output = new Int16Array(capacity);
    let count = 0;
    while (this.position < end - 1) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const a = left < this.seen ? this.previous : input[left - this.seen];
      const b = input[left + 1 - this.seen];
      const sample = Math.max(-1, Math.min(1, a + (b - a) * fraction));
      this.output[count++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      this.position += step;
    }
    if (input.length) this.previous = input[input.length - 1];
    this.seen = end;
    return this.output.subarray(0, count);
  }
}
const KNEE = 0.8;
/** Unity below the knee, then a smooth tanh curve that never exceeds full scale. */
export function softClip(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= KNEE) return value;
  return Math.sign(value) * (KNEE + (1 - KNEE) * Math.tanh((magnitude - KNEE) / (1 - KNEE)));
}
function average(channels: Float32Array[], index: number): number {
  if (!channels.length) return 0;
  let sum = 0;
  for (const channel of channels) sum += channel[index] || 0;
  return sum / channels.length;
}
/**
 * Mono mix of tab and microphone. Tab audio passes at unity gain while the microphone is
 * gated out, so the gate never changes tab loudness; together they sum through a soft limiter.
 */
export class PCMMixer {
  private output = new Float32Array(0);
  mix(tab: Float32Array[], mic: Float32Array[], allowMic: boolean, frames: number): Float32Array {
    if (this.output.length < frames) this.output = new Float32Array(frames);
    const result = this.output.subarray(0, frames);
    const withMic = allowMic && mic.length > 0;
    for (let i = 0; i < frames; i++) {
      const tabValue = average(tab, i);
      result[i] = withMic
        ? softClip(tabValue + average(mic, i))
        : Math.max(-1, Math.min(1, tabValue));
    }
    return result;
  }
}
