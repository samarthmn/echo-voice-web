import { numericVector } from '../../web/guards.ts';
import { defined } from '../helpers/assertions.ts';
import { array } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Tensor,
  WhisperForConditionalGeneration,
  cat,
  mean,
  stack,
  std_mean,
} from '@huggingface/transformers';
import { correctWhisperAlignment, validatedWhisperWords } from '../../web/whisper-alignment.ts';

const ops = { Tensor, cat, mean, stack, std_mean };

void test('Whisper word mode keeps 3.8.1 decoding: no timestamp tokens, other calls unchanged', async () => {
  const calls: unknown[] = [];
  const model = {
    config: { decoder_layers: 1 },
    generate: (options: unknown) => {
      calls.push(options);
      return Promise.resolve('generated');
    },
    _extract_token_timestamps: WhisperForConditionalGeneration.prototype._extract_token_timestamps,
  };
  correctWhisperAlignment(model, ops);
  const generate = model.generate as (options: unknown) => Promise<unknown>;
  assert.equal(
    await generate({ return_token_timestamps: true, return_timestamps: true, num_frames: 1301 }),
    'generated',
  );
  await generate({ max_new_tokens: 1, language: 'english' });
  assert.deepEqual(calls, [
    { return_token_timestamps: true, return_timestamps: false, num_frames: 1301 },
    { max_new_tokens: 1, language: 'english' },
  ]);
  const outputs = {
    cross_attentions: [],
    sequences: new Tensor('int64', new BigInt64Array(1), [1, 1]),
  };
  for (const frames of [undefined, 1, 1.5, Number.NaN])
    assert.throws(() => model._extract_token_timestamps(outputs, [[0, 0]], frames), /actual audio/);
});

void test('the cropped extraction reproduces Transformers.js 3.8.1 DTW token times on 4.3.2 tensors', () => {
  const rows = 8,
    positions = 1500;
  function outputs() {
    const attention = new Float32Array(rows * positions);
    for (let row = 0; row < rows; row++)
      for (let frame = 0; frame < positions; frame++) {
        attention[row * positions + frame] =
          1e-5 * (row + 1) + Math.exp(-((frame - row * 4) ** 2) / 4);
      }
    return {
      sequences: new Tensor('int64', new BigInt64Array(rows + 1), [1, rows + 1]),
      cross_attentions: [[new Tensor('float32', attention, [1, 1, rows, positions])]],
    };
  }
  const model = {
    config: { decoder_layers: 1, median_filter_width: 3 },
    generate: () => Promise.resolve(),
    _extract_token_timestamps: WhisperForConditionalGeneration.prototype._extract_token_timestamps,
  };
  const heads = [[0, 0]];
  correctWhisperAlignment(model, ops);
  const list: unknown = model._extract_token_timestamps(outputs(), heads, 60).tolist();
  const normal = numericVector(array(list)[0]);
  // Produced by Transformers.js 3.8.1's own extraction for this input.
  const expected = [0, 0, 0.04, 0.12, 0.2, 0.28, 0.36, 0.44, 0.52];
  assert.ok(
    normal.every((time: number, index: number) => Math.abs(time - defined(expected[index])) < 1e-6),
  );
  assert.ok(new Set(normal).size > 3 && normal.every((time: number) => time >= 0 && time < 0.6));
});

void test('browser words reject out-of-audio, collapsed and unordered alignment before attribution', () => {
  const output = (chunks: { text: string; timestamp: (number | null)[] }[]) => ({
    text: 'one two',
    chunks,
  });
  assert.throws(
    () => validatedWhisperWords(output([{ text: 'one', timestamp: [25.98, 25.98] }]), 13),
    /exceeded/,
  );
  assert.throws(
    () =>
      validatedWhisperWords(
        output([
          { text: 'one', timestamp: [13, 13] },
          { text: 'two', timestamp: [13, 13] },
        ]),
        13,
      ),
    /collapsed/,
  );
  assert.throws(
    () =>
      validatedWhisperWords(
        output([
          { text: 'one', timestamp: [1, 2] },
          { text: 'two', timestamp: [0, 1] },
        ]),
        13,
      ),
    /unordered/,
  );
  assert.deepEqual(
    validatedWhisperWords(
      output([
        { text: 'one', timestamp: [-0.02, 0.2] },
        { text: 'two', timestamp: [0.2, null] },
      ]),
      1,
    ),
    [
      { text: 'one', timestamp: [0, 0.2] },
      { text: 'two', timestamp: [0.2, 1] },
    ],
  );
  assert.deepEqual(validatedWhisperWords({ text: '', chunks: [] }, 1), []);
});
