import test from 'node:test';
import assert from 'node:assert/strict';
import { Tensor, WhisperForConditionalGeneration } from '@huggingface/transformers';
import { correctWhisperAlignment, validatedWhisperWords } from '../web/whisper-alignment.js';

test('Whisper alignment preserves checkpoint heads and crops stride-two audio positions once', () => {
  const heads = [[2, 4], [3, 11]], calls = [];
  const model = { _extract_token_timestamps(...args) { calls.push(args); return 'aligned'; } };
  correctWhisperAlignment(model);
  assert.equal(model._extract_token_timestamps('actual-attentions', heads, 1301, 0.02), 'aligned');
  assert.deepEqual(calls, [['actual-attentions', heads, 650, 0.02]]);
});

test('the cropped extraction runs actual Transformers DTW and returns distinct finite token times', () => {
  const rows = 8, positions = 1500;
  function outputs() {
    const attention = new Float32Array(rows * positions);
    for (let row = 0; row < rows; row++) for (let frame = 0; frame < positions; frame++) {
      attention[row * positions + frame] = 1e-5 * (row + 1) + Math.exp(-((frame - row * 4) ** 2) / 4);
    }
    return { sequences: new Tensor('int64', new BigInt64Array(rows + 1), [1, rows + 1]), cross_attentions: [[new Tensor('float32', attention, [1, 1, rows, positions])]] };
  }
  const model = { config: { decoder_layers: 1, median_filter_width: 3 }, _extract_token_timestamps: WhisperForConditionalGeneration.prototype._extract_token_timestamps };
  const heads = [[0, 0]];
  correctWhisperAlignment(model);
  const normal = model._extract_token_timestamps(outputs(), heads, 60).tolist()[0];
  const expected = [0, 0, 0.04, 0.12, 0.2, 0.28, 0.36, 0.44, 0.52];
  assert.ok(normal.every((time, index) => Math.abs(time - expected[index]) < 1e-6));
  assert.ok(new Set(normal).size > 3 && normal.every(time => time >= 0 && time < 0.6));
});

test('browser words reject out-of-audio, collapsed and unordered alignment before attribution', () => {
  const output = chunks => ({ text: 'one two', chunks });
  assert.throws(() => validatedWhisperWords(output([{ text: 'one', timestamp: [25.98, 25.98] }]), 13), /exceeded/);
  assert.throws(() => validatedWhisperWords(output([{ text: 'one', timestamp: [13, 13] }, { text: 'two', timestamp: [13, 13] }]), 13), /collapsed/);
  assert.throws(() => validatedWhisperWords(output([{ text: 'one', timestamp: [1, 2] }, { text: 'two', timestamp: [0, 1] }]), 13), /unordered/);
  assert.deepEqual(validatedWhisperWords(output([{ text: 'one', timestamp: [-0.02, 0.2] }, { text: 'two', timestamp: [0.2, null] }]), 1), [{ text: 'one', timestamp: [0, 0.2] }, { text: 'two', timestamp: [0.2, 1] }]);
  assert.deepEqual(validatedWhisperWords({ text: '', chunks: [] }, 1), []);
});
