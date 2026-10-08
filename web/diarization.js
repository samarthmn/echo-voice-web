const RATE = 16000;
const CHANNELS = [[], [0], [1], [2], [0, 1], [0, 2], [1, 2]];
/** Voice vectors are compared after normalization, independent of volume. */
export function normalize(vector) {
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Speaker recognition returned an invalid voice embedding.');
  return Array.from(vector, value => value / norm);
}
/** Compare normalized voice directions with a dimension-checked cosine score. */
export function similarity(a, b) {
  if (a.length !== b.length) throw new Error('Speaker embedding dimensions do not match.');
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}
/** Match real voice embeddings; local channels in the same window stay distinct. */
export function matchSpeakers(vectors, speakers, threshold = 0.93, anchors = new Map()) {
  const indexOf = label => /^Speaker \d+$/.test(label || '') ? Number(label.slice(8)) - 1 : -1;
  const labels = new Map([...anchors].filter(([, label]) => speakers[indexOf(label)]));
  const used = new Set([...labels.values()].map(indexOf));
  // Longer clean samples get the first chance to match an existing voice.
  for (const { channel, vector, seconds, allowNew = true } of [...vectors].sort((a, b) => b.seconds - a.seconds)) {
    const unit = normalize(vector);
    let index = indexOf(labels.get(channel)), best = threshold;
    // Shared timestamps anchor a continuing voice despite normal variation in
    // an utterance embedding. Strongly contradictory voice evidence rejects it.
    if (index >= 0 && similarity(unit, speakers[index].vector) < 0.65) {
      used.delete(index); labels.delete(channel); index = -1;
    }
    if (index < 0) speakers.forEach((speaker, i) => {
        const score = similarity(unit, speaker.vector);
        if (!used.has(i) && score > best) { best = score; index = i; }
      });
    if (index < 0) {
      if (!allowNew) continue;
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

/** Anchor channels using the same clean speech in adjacent overlapping windows. */
export function overlapSpeakerAnchors(segments, previous, offset) {
  const candidates = [];
  const previousEnd = Math.max(offset, ...previous.map(turn => turn.end));
  for (let channel = 0; channel < 3; channel++) {
    const scores = new Map(); let duration = 0;
    for (const segment of segments.filter(segment => CHANNELS[segment.id]?.length === 1 && CHANNELS[segment.id][0] === channel && segment.confidence >= 0.7)) {
      const start = offset + segment.start, end = Math.min(previousEnd, offset + segment.end);
      duration += Math.max(0, end - start);
      for (const turn of previous.filter(turn => !turn.uncertain && turn.speaker !== 'Unknown speaker')) {
        const overlap = Math.max(0, Math.min(end, turn.end) - Math.max(start, turn.start));
        scores.set(turn.speaker, (scores.get(turn.speaker) || 0) + overlap);
      }
    }
    const best = [...scores].sort((a, b) => b[1] - a[1])[0];
    if (duration >= 0.5 && best?.[1] >= 0.8 * duration) candidates.push({ channel, speaker: best[0], duration: best[1] });
  }
  const used = new Set(), anchors = new Map();
  for (const candidate of candidates.sort((a, b) => b.duration - a.duration)) {
    if (!used.has(candidate.speaker)) { anchors.set(candidate.channel, candidate.speaker); used.add(candidate.speaker); }
  }
  return anchors;
}

/** Embed one sufficiently long contiguous clean sample, excluding transition edges and padding. */
export function cleanSpeechSample(segments, channel, samples, length) {
  const clean = segments.filter(segment => CHANNELS[segment.id]?.length === 1 && CHANNELS[segment.id][0] === channel && segment.confidence >= 0.7)
    .map(segment => ({ start: Math.max(0, segment.start + 0.1), end: Math.min(length / RATE, segment.end - 0.1) }))
    .filter(segment => segment.end - segment.start >= 1.5)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  if (!clean.length) return null;
  const seconds = Math.min(6, clean[0].end - clean[0].start);
  const start = Math.floor((clean[0].start + (clean[0].end - clean[0].start - seconds) / 2) * RATE);
  return { samples: samples.subarray(start, start + Math.floor(seconds * RATE)), seconds };
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
  let previous = [];
  const windowSamples = 10 * RATE, step = 8 * RATE;
  for (let offset = 0; offset < audio.length; offset += step) {
    const length = Math.min(windowSamples, audio.length - offset);
    // PyAnnote expects a full ten-second window; pad only the final one.
    const samples = new Float32Array(windowSamples);
    samples.set(audio.subarray(offset, offset + length));
    const { logits } = await segmentation(await segmentProcessor(samples));
    const segments = segmentProcessor.post_process_speaker_diarization(logits, windowSamples)[0];
    const anchors = overlapSpeakerAnchors(segments, previous, offset / RATE);
    const vectors = [];
    for (let channel = 0; channel < 3; channel++) {
      const sample = cleanSpeechSample(segments, channel, samples, length);
      if (!sample) continue;
      const { embeddings } = await embedding(await embedProcessor(sample.samples));
      vectors.push({ channel, vector: embeddings.data, seconds: sample.seconds, allowNew: sample.seconds >= 2 });
    }
    const labels = matchSpeakers(vectors, speakers, 0.93, anchors);
    const current = [];
    const retainedStart = offset === 0 ? 0 : 1;
    const retainedEnd = offset + windowSamples >= audio.length ? length / RATE : 9;
    for (const segment of segments) {
      const channels = CHANNELS[segment.id] || [];
      if (!channels.length) continue;
      const identified = channels.map(channel => labels.get(channel)).filter(Boolean);
      const attribution = { speaker: identified[0] || 'Unknown speaker', uncertain: channels.length > 1 || !identified.length || segment.confidence < 0.7 };
      current.push({ start: segment.start + offset / RATE, end: Math.min(length / RATE, segment.end) + offset / RATE, ...attribution });
      const start = Math.max(retainedStart, segment.start), end = Math.min(retainedEnd, segment.end);
      if (end <= start) continue;
      turns.push({ start: start + offset / RATE, end: end + offset / RATE, ...attribution });
    }
    previous = current;
    progress(`Recognizing speakers · ${speakers.length} voice groups`, Math.min(100, (offset + length) / audio.length * 100));
    if (offset + windowSamples >= audio.length) break;
  }
  return turns;
}
