import type { Word } from './types/domain.ts';
import type { Tensor, cat, mean, stack, std_mean } from '@huggingface/transformers';
import { record } from './guards.ts';

/**
 * Transformers.js tensor operations used by the alignment. Callers pass the module's
 * own exports so this file stays importable on the main thread without the runtime.
 */
export interface TensorOps {
  Tensor: typeof Tensor;
  cat: typeof cat;
  mean: typeof mean;
  stack: typeof stack;
  std_mean: typeof std_mean;
}

interface GenerateOutputs {
  cross_attentions: Tensor[][];
  sequences: Tensor;
}

/**
 * Restore Transformers.js 3.8.1 word alignment on the pinned 4.3.2 runtime.
 *
 * 4.3.2 changed word timestamps in two ways that broke Echo on real speech:
 * - word mode now also predicts timestamp tokens, which hallucinated text at
 *   chunk boundaries and produced words past the end of the audio;
 * - its DTW gives token t the alignment of decoder row t, but row t is where
 *   the model predicts token t + 1, so every word took the next word's time.
 * Echo therefore keeps 3.8.1's behaviour: word mode does not predict timestamp
 * tokens, and token timestamps come from the 3.8.1 DTW below, cropped to the
 * actual audio as HF Python generation_whisper.py does (num_frames // 2).
 */
export function correctWhisperAlignment(
  model: {
    config: unknown;
    generate: (options: never) => Promise<unknown>;
    _extract_token_timestamps: (
      outputs: GenerateOutputs,
      exportedHeads: number[][],
      numFrames?: number,
      precision?: number,
      numInputIds?: number,
    ) => Tensor;
  },
  ops: TensorOps,
  alignmentHeads?: number[][],
) {
  const generate = model.generate.bind(model) as (options: unknown) => Promise<unknown>;
  model.generate = (options: unknown) =>
    generate(
      record(options)['return_token_timestamps'] === true
        ? { ...record(options), return_timestamps: false }
        : options,
    );
  model._extract_token_timestamps = (outputs, exportedHeads, numFrames, precision = 0.02) => {
    // Whisper's stride-two encoder has half as many positions as mel frames,
    // and the pipeline passes the chunk's unconverted mel-frame count.
    if (typeof numFrames !== 'number' || !Number.isSafeInteger(numFrames) || numFrames < 2)
      throw new Error('Word alignment requires the actual audio frame count.');
    return tokenTimestamps(
      ops,
      model.config,
      outputs,
      alignmentHeads ?? exportedHeads,
      Math.floor(numFrames / 2),
      precision,
    );
  };
}

// The functions below are ported from Transformers.js 3.8.1
// (WhisperForConditionalGeneration._extract_token_timestamps, medianFilter and
// dynamic_time_warping), Copyright Hugging Face, Apache License 2.0.

function tokenTimestamps(
  ops: TensorOps,
  config: unknown,
  outputs: GenerateOutputs,
  heads: number[][],
  positions: number,
  precision: number,
): Tensor {
  const settings = record(config);
  const layers = settings['decoder_layers'];
  const width = settings['median_filter_width'] ?? 7;
  if (
    typeof layers !== 'number' ||
    typeof width !== 'number' ||
    !Array.isArray(outputs.cross_attentions)
  )
    throw new Error('The speech model returned no word timestamps.');
  // One tensor per decoder layer: (batch, attention heads, output length, input length).
  const crossAttentions = Array.from({ length: layers }, (_, layer) =>
    ops.cat(
      outputs.cross_attentions.map((step) => {
        const tensor = step[layer];
        if (!tensor) throw new Error('The speech model returned no word timestamps.');
        return tensor;
      }),
      2,
    ),
  );
  const weights = ops
    .stack(
      heads.map(([layer, head]) => {
        const attention = layer === undefined ? undefined : crossAttentions[layer];
        if (!attention || head === undefined)
          throw new Error('The speech model returned no word timestamps.');
        return attention.slice(null, head, null, [0, positions]);
      }),
    )
    .permute(1, 0, 2, 3);
  const [batches = 0, headCount = 0, rows = 0, frames = 0] = weights.dims;
  if (batches !== 1) throw new Error('Word alignment supports one recording at a time.');
  const [deviation, average] = ops.std_mean(weights, -2, 0, true);
  if (!deviation || !average) throw new Error('The speech model returned no word timestamps.');
  const smoothed = Float32Array.from(weights.data as Float32Array);
  const std = deviation.data as Float32Array,
    means = average.data as Float32Array;
  for (let head = 0; head < headCount; ++head)
    for (let row = 0; row < rows; ++row) {
      const offset = (head * rows + row) * frames;
      const values = smoothed.subarray(offset, offset + frames);
      for (let frame = 0; frame < frames; ++frame) {
        const at = head * frames + frame;
        values[frame] = ((values[frame] ?? 0) - (means[at] ?? 0)) / (std[at] ?? 1);
      }
      values.set(medianFilter(values, width));
    }
  // Average the alignment heads, then align tokens to audio positions.
  const matrix: unknown = ops
    .mean(new ops.Tensor('float32', smoothed, weights.dims), 1)
    .neg()
    .squeeze_(0)
    .tolist();
  const [textIndices, timeIndices] = dynamicTimeWarping(matrix as number[][]);
  const jumpTimes: number[] = [];
  textIndices.forEach((index, i) => {
    if (i === 0 || index !== textIndices[i - 1]) jumpTimes.push((timeIndices[i] ?? 0) * precision);
  });
  const shape = outputs.sequences.dims;
  const length = (shape[0] ?? 0) * (shape[1] ?? 0);
  if (jumpTimes.length + 1 > length)
    throw new Error('The speech model returned no word timestamps.');
  const timestamps = new Float32Array(length);
  // Token t is predicted from decoder row t - 1, so it takes that row's start.
  timestamps.set(jumpTimes, 1);
  return new ops.Tensor('float32', timestamps, shape);
}

function medianFilter(data: Float32Array, windowSize: number): Float32Array {
  if (windowSize % 2 === 0 || windowSize <= 0)
    throw new Error('Window size must be a positive odd number');
  const output = new Float32Array(data.length);
  const buffer = new Float32Array(windowSize);
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < data.length; ++i) {
    let count = 0;
    for (let j = -half; j <= half; ++j) {
      let index = i + j;
      if (index < 0) index = Math.abs(index);
      else if (index >= data.length) index = 2 * (data.length - 1) - index;
      buffer[count++] = data[index] ?? 0;
    }
    // Typed-array sort is numeric, as in 3.8.1.
    buffer.sort();
    output[i] = buffer[half] ?? 0;
  }
  return output;
}

function dynamicTimeWarping(matrix: number[][]): [number[], number[]] {
  const outputLength = matrix.length;
  const inputLength = matrix[0]?.length ?? 0;
  const cost = Array.from({ length: outputLength + 1 }, () =>
    new Array<number>(inputLength + 1).fill(Infinity),
  );
  const trace = Array.from({ length: outputLength + 1 }, () =>
    new Array<number>(inputLength + 1).fill(-1),
  );
  const at = (grid: number[][], i: number, j: number) => grid[i]?.[j] ?? Infinity;
  const put = (grid: number[][], i: number, j: number, value: number) => {
    const row = grid[i];
    if (row) row[j] = value;
  };
  put(cost, 0, 0, 0);
  for (let j = 1; j <= inputLength; ++j)
    for (let i = 1; i <= outputLength; ++i) {
      const c0 = at(cost, i - 1, j - 1),
        c1 = at(cost, i - 1, j),
        c2 = at(cost, i, j - 1);
      let c: number, t: number;
      if (c0 < c1 && c0 < c2) [c, t] = [c0, 0];
      else if (c1 < c0 && c1 < c2) [c, t] = [c1, 1];
      else [c, t] = [c2, 2];
      put(cost, i, j, (matrix[i - 1]?.[j - 1] ?? 0) + c);
      put(trace, i, j, t);
    }
  for (let j = 0; j <= inputLength; ++j) put(trace, 0, j, 2);
  for (let i = 0; i <= outputLength; ++i) put(trace, i, 0, 1);
  let i = outputLength,
    j = inputLength;
  const textIndices: number[] = [],
    timeIndices: number[] = [];
  while (i > 0 || j > 0) {
    textIndices.push(i - 1);
    timeIndices.push(j - 1);
    const step = trace[i]?.[j];
    if (step === 0) {
      --i;
      --j;
    } else if (step === 1) --i;
    else if (step === 2) --j;
    else throw new Error('Word alignment failed in dynamic time warping.');
  }
  return [textIndices.reverse(), timeIndices.reverse()];
}

/** Reject structural alignment failures before speaker assignment or persistence. */
export function validatedWhisperWords(value: unknown, duration: number): Word[] {
  const output = record(value);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('Word alignment requires the recorded audio duration.');
  if (!Array.isArray(output['chunks']))
    throw new Error('The speech model returned no word timestamps.');
  if (typeof output['text'] === 'string' && output['text'].trim() && !output['chunks'].length)
    throw new Error('Word timestamps could not be created.');
  let previous = 0;
  const words = output['chunks'].map((value: unknown): Word => {
    const word = record(value);
    const [rawStart, rawEnd]: unknown[] = Array.isArray(word['timestamp'])
      ? (word['timestamp'] as unknown[])
      : [];
    if (
      typeof word['text'] !== 'string' ||
      !word['text'].trim() ||
      !Array.isArray(word['timestamp']) ||
      word['timestamp'].length !== 2 ||
      typeof rawStart !== 'number' ||
      !Number.isFinite(rawStart) ||
      (rawEnd !== null && (typeof rawEnd !== 'number' || !Number.isFinite(rawEnd))) ||
      (rawEnd !== null && rawEnd < rawStart)
    )
      throw new Error('The speech model returned invalid word timestamps.');
    // Repair round-off only; clipping every bad word would hide a failed DTW.
    if (
      rawStart < -0.1 ||
      rawStart > duration + 0.1 ||
      (rawEnd !== null && (rawEnd < -0.1 || rawEnd > duration + 0.1))
    )
      throw new Error('Word alignment exceeded the recorded audio.');
    const start = Math.max(0, Math.min(duration, rawStart));
    const end = Math.max(start, Math.min(duration, rawEnd ?? duration));
    if (start < previous) throw new Error('The speech model returned unordered word timestamps.');
    previous = start;
    return { text: word['text'], timestamp: [start, end] };
  });
  if (words.length > 1 && words.every((word) => word.timestamp[0] === word.timestamp[1]))
    throw new Error('Word alignment collapsed; no usable word timings were returned.');
  return words;
}
