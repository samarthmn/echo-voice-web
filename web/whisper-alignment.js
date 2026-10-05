/** Correct the mel-frame count passed by pinned Transformers.js 3.8.1 to DTW. */
export function correctWhisperAlignment(model, alignmentHeads) {
  const extract = model._extract_token_timestamps.bind(model);
  model._extract_token_timestamps = (outputs, exportedHeads, numFrames, precision) => {
    // Whisper's stride-two encoder has half as many positions as mel frames.
    // HF Python generation_whisper.py crops attentions to num_frames // 2;
    // Transformers.js 3.8.1 passes the unconverted mel-frame count here.
    if (!Number.isSafeInteger(numFrames) || numFrames < 2) throw new Error('Word alignment requires the actual audio frame count.');
    return extract(outputs, alignmentHeads ?? exportedHeads, Math.floor(numFrames / 2), precision);
  };
}

/** Reject structural alignment failures before speaker assignment or persistence. */
export function validatedWhisperWords(output, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Word alignment requires the recorded audio duration.');
  if (!Array.isArray(output?.chunks)) throw new Error('The speech model returned no word timestamps.');
  if (output.text?.trim() && !output.chunks.length) throw new Error('Word timestamps could not be created.');
  let previous = 0;
  const words = output.chunks.map(word => {
    const [rawStart, rawEnd] = word.timestamp ?? [];
    if (typeof word.text !== 'string' || !word.text.trim() || !Array.isArray(word.timestamp) || word.timestamp.length !== 2 || !Number.isFinite(rawStart) || (rawEnd !== null && !Number.isFinite(rawEnd)) || (rawEnd !== null && rawEnd < rawStart)) throw new Error('The speech model returned invalid word timestamps.');
    // Repair round-off only; clipping every bad word would hide a failed DTW.
    if (rawStart < -0.1 || rawStart > duration + 0.1 || (rawEnd !== null && (rawEnd < -0.1 || rawEnd > duration + 0.1))) throw new Error('Word alignment exceeded the recorded audio.');
    const start = Math.max(0, Math.min(duration, rawStart));
    const end = Math.max(start, Math.min(duration, rawEnd ?? duration));
    if (start < previous) throw new Error('The speech model returned unordered word timestamps.');
    previous = start;
    return { text: word.text, timestamp: [start, end] };
  });
  if (words.length > 1 && words.every(word => word.timestamp[0] === word.timestamp[1])) throw new Error('Word alignment collapsed; no usable word timings were returned.');
  return words;
}
