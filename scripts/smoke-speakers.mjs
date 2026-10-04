import assert from 'node:assert/strict';
import { env, AutoProcessor, AutoModelForAudioFrameClassification, AutoModelForXVector } from '@huggingface/transformers';
import { SPEAKER_MODELS } from '../web/models.js';
import { diarize } from '../web/diarization.js';

env.allowLocalModels = false;
/** Decode the public PCM WAV fixtures without relying on browser AudioContext. */
async function fixture(name) {
  const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/' + name + '.wav', { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Speech fixture download failed: ' + response.status);
  const buffer = await response.arrayBuffer(), view = new DataView(buffer);
  let format, channels, rate, bits, start, length;
  for (let cursor = 12; cursor + 8 <= view.byteLength;) {
    const tag = String.fromCharCode(...new Uint8Array(buffer, cursor, 4));
    const size = view.getUint32(cursor + 4, true);
    if (tag === 'fmt ') {
      format = view.getUint16(cursor + 8, true); channels = view.getUint16(cursor + 10, true);
      rate = view.getUint32(cursor + 12, true); bits = view.getUint16(cursor + 22, true);
    } else if (tag === 'data') { start = cursor + 8; length = size; }
    cursor += 8 + size + (size % 2);
  }
  assert.ok(start && rate && channels && ((format === 1 && bits === 16) || (format === 3 && bits === 32)), 'Fixture must be PCM16 or float32 WAV');
  const count = Math.floor(length / (channels * bits / 8)), output = new Float32Array(8 * 16000);
  assert.ok(count / rate >= 8, 'Each fixture must contain at least eight seconds');
  for (let i = 0; i < output.length; i++) {
    const source = Math.min(count - 1, Math.floor(i * rate / 16000)), offset = start + source * channels * bits / 8;
    output[i] = format === 1 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
  }
  return output;
}
const [a, b] = await Promise.all([fixture('jfk'), fixture('mlk')]);
const audio = new Float32Array(a.length * 3);
audio.set(a); audio.set(b, a.length); audio.set(a, a.length * 2);
let segmentation, embedding;
try {
  segmentation = await AutoModelForAudioFrameClassification.from_pretrained(SPEAKER_MODELS.segmentation, { dtype: 'fp32', device: 'cpu' });
  const segmentProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.segmentation);
  embedding = await AutoModelForXVector.from_pretrained(SPEAKER_MODELS.embedding, { dtype: 'q8', device: 'cpu' });
  const embedProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODELS.embedding);
  const speakers = [];
  const turns = await diarize(audio, segmentation, segmentProcessor, embedding, embedProcessor, speakers, status => console.log(status));
  function dominant(start, end) {
    const totals = new Map();
    for (const turn of turns) {
      if (turn.speaker === 'Unknown speaker') continue;
      const amount = Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
      totals.set(turn.speaker, (totals.get(turn.speaker) || 0) + amount);
    }
    return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const first = dominant(1, 7), second = dominant(9, 15), repeated = dominant(17, 23);
  assert.ok(first && second && repeated, 'Real speech must receive speaker labels');
  assert.notEqual(first, second, 'Different recorded voices must separate');
  assert.equal(first, repeated, 'A returning voice must keep its label');
  console.log('PASS: real PyAnnote/WavLM inference separates JFK/MLK recordings and recognizes the returning voice.');
} finally {
  await segmentation?.dispose();
  await embedding?.dispose();
}
