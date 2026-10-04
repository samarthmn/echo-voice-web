const RATE = 16000;
const CHANNELS = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];
/** Voice vectors are compared after normalization, independent of volume. */
export function normalize(vector) {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Speaker recognition returned an invalid voice embedding.');
  return Array.from(vector, value => value / norm);
}
export function similarity(a, b) {
  if (a.length !== b.length) throw new Error('Speaker embedding dimensions do not match.');
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}
/** Match real voice embeddings; local channels in the same window stay distinct. */
export function matchSpeakers(vectors, speakers, threshold = 0.93) {
  const used = new Set();
  const labels = new Map();
  // Longer clean samples get the first chance to match an existing voice.
  for (const { channel, vector, seconds } of [...vectors].sort((a, b) => b.seconds - a.seconds)) {
    const unit = normalize(vector);
    let index = -1, best = threshold;
    speakers.forEach((speaker, i) => {
      const score = similarity(unit, speaker.vector);
      if (!used.has(i) && score > best) { best = score; index = i; }
    });
    if (index < 0) {
      index = speakers.length;
      speakers.push({ vector: unit, weight: seconds });
    } else {
      const speaker = speakers[index];
      const weight = speaker.weight + seconds;
      speaker.vector = normalize(unit.map((value, i) => (speaker.vector[i] * speaker.weight + value * seconds) / weight));
      speaker.weight = weight;
    }
    used.add(index); labels.set(channel, 'Speaker ' + (index + 1));
  }
  return labels;
}
/** Rebuild passages from words so a voice change can split an ASR sentence. */
export function speakerPassages(words, turns, duration, createId = () => crypto.randomUUID()) {
  const passages = [];
  for (const word of words) {
    if (!word.text.trim()) continue;
    const start = Math.max(0, Math.min(duration, word.timestamp?.[0] ?? 0));
    const end = Math.max(start, Math.min(duration, word.timestamp?.[1] ?? duration));
    let best = null, amount = 0;
    for (const turn of turns) {
      const overlap = Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
      if (overlap > amount) { best = turn; amount = overlap; }
    }
    const speaker = best?.speaker || 'Unknown speaker';
    const uncertain = !best || best.uncertain || amount < (end - start) / 2;
    const previous = passages.at(-1);
    if (previous && previous.speaker === speaker && previous.uncertain === uncertain && start - previous.end < 1.5 && end - previous.start < 30) {
      previous.text += word.text; previous.end = end;
    } else {
      passages.push({ id: createId(), start, end, speaker, uncertain, text: word.text });
    }
  }
  return passages.map(p => ({ ...p, text: p.text.trim() }));
}
/** Segment ten-second windows, then identify their voices using WavLM embeddings. */
export async function diarize(audio, segmentation, segmentProcessor, embedding, embedProcessor, speakers, progress) {
  const turns = [];
  const windowSamples = 10 * RATE, step = 8 * RATE;
  for (let offset = 0; offset < audio.length; offset += step) {
    const length = Math.min(windowSamples, audio.length - offset);
    // PyAnnote expects a full ten-second window; pad only the final one.
    const samples = new Float32Array(windowSamples);
    samples.set(audio.subarray(offset, offset + length));
    const { logits } = await segmentation(await segmentProcessor(samples));
    const segments = segmentProcessor.post_process_speaker_diarization(logits, windowSamples)[0];
    const vectors = [];
    for (let channel = 0; channel < 3; channel++) {
      const clean = segments.filter(segment => CHANNELS[segment.id]?.length === 1 && CHANNELS[segment.id][0] === channel);
      const parts = clean.map(segment => samples.subarray(Math.floor(segment.start * RATE), Math.min(length, Math.floor(segment.end * RATE)))).filter(part => part.length);
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      if (total < RATE * 0.5) continue;
      const joined = new Float32Array(total); let cursor = 0;
      for (const part of parts) { joined.set(part, cursor); cursor += part.length; }
      const { embeddings } = await embedding(await embedProcessor(joined));
      vectors.push({ channel, vector: embeddings.data, seconds: total / RATE });
    }
    const labels = matchSpeakers(vectors, speakers);
    const retainedStart = offset === 0 ? 0 : 1;
    const retainedEnd = offset + windowSamples >= audio.length ? length / RATE : 9;
    for (const segment of segments) {
      const channels = CHANNELS[segment.id] || [];
      if (!channels.length) continue;
      const start = Math.max(retainedStart, segment.start), end = Math.min(retainedEnd, segment.end);
      if (end <= start) continue;
      const identified = channels.map(channel => labels.get(channel)).filter(Boolean);
      turns.push({ start: start + offset / RATE, end: end + offset / RATE, speaker: identified[0] || 'Unknown speaker', uncertain: channels.length > 1 || !identified.length || segment.confidence < 0.6 });
    }
    progress('Recognizing speakers', Math.min(100, (offset + length) / audio.length * 100));
    if (offset + windowSamples >= audio.length) break;
  }
  return turns;
}
