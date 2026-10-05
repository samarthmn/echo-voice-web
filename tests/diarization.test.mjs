import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, matchSpeakers, speakerPassages, diarize, overlapSpeakerAnchors, cleanSpeechSample } from '../web/diarization.js';
import { MODELS, resolveSpeechModel, DEFAULT_SPEECH_MODEL, speechModelConfig, assertWordTimestampSupport } from '../web/models.js';

test('catalog retires Tiny/Base while existing meetings resolve to Turbo', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['onnx-community/whisper-large-v3-turbo', 'onnx-community/whisper-large-v3']);
  assert.equal(resolveSpeechModel('onnx-community/whisper-base'), DEFAULT_SPEECH_MODEL);
  assert.equal(resolveSpeechModel('onnx-community/whisper-tiny.en'), DEFAULT_SPEECH_MODEL);
});
test('speech exports expose real word-alignment outputs instead of incompatible plain decoder weights', () => {
  assert.equal(speechModelConfig(DEFAULT_SPEECH_MODEL).checkpoint, 'onnx-community/whisper-large-v3-turbo_timestamped');
  assert.equal(speechModelConfig('onnx-community/whisper-large-v3').checkpoint, 'Xenova/whisper-large-v3');
  assert.throws(() => assertWordTimestampSupport(['logits', 'present.0.decoder.key']), /cannot create word timestamps/);
  assert.doesNotThrow(() => assertWordTimestampSupport(['logits', 'cross_attentions.0']));
});
test('voices retain their labels when local segmentation channels change across windows or tracks', () => {
  const speakers = [];
  const a = matchSpeakers([{ channel: 0, vector: [1, 0, 0], seconds: 3 }, { channel: 1, vector: [0, 1, 0], seconds: 2 }], speakers);
  const b = matchSpeakers([{ channel: 0, vector: [0, 1, .01], seconds: 2 }, { channel: 1, vector: [1, 0, .01], seconds: 3 }], speakers);
  assert.equal(a.get(0), b.get(1));
  assert.equal(a.get(1), b.get(0));
  assert.equal(speakers.length, 2);
  const c = matchSpeakers([{ channel: 2, vector: [0, 0, 1], seconds: 2 }], speakers);
  assert.equal(c.get(2), 'Speaker 3');
  assert.throws(() => normalize([NaN]), /invalid/);
});
test('different local speakers cannot collapse into one voice even with similar embeddings', () => {
  const speakers = [{ vector: [1, 0], weight: 4 }];
  const labels = matchSpeakers([{ channel: 0, vector: [1, .01], seconds: 2 }, { channel: 1, vector: [1, .02], seconds: 1 }], speakers);
  assert.notEqual(labels.get(0), labels.get(1));
});
test('word timestamps split a sentence at a voice change and mark overlap or missing attribution for review', () => {
  const words = [{ text: ' Hello', timestamp: [0, .5] }, { text: ' there', timestamp: [.5, 1] }, { text: ' Yes', timestamp: [1, 1.5] }, { text: ' agreed', timestamp: [1.5, 2] }, { text: ' unclear', timestamp: [2, 3] }];
  const turns = [{ start: 0, end: 1, speaker: 'Speaker 1' }, { start: 1, end: 1.5, speaker: 'Speaker 2' }, { start: 1.5, end: 2, speaker: 'Speaker 2', uncertain: true }];
  const passages = speakerPassages(words, turns, 3, () => 'id');
  assert.deepEqual(passages.map(p => [p.text, p.speaker, p.uncertain]), [['Hello there', 'Speaker 1', false], ['Yes', 'Speaker 2', false], ['agreed', 'Speaker 2', true], ['unclear', 'Unknown speaker', true]]);
});
test('overlapping segmentation windows keep one continuous timeline and detect final padded samples correctly', async () => {
  const audio = new Float32Array(19 * 16000);
  const speakers = [];
  const segmentation = async () => ({ logits: {} });
  const processor = Object.assign(async () => ({}), { post_process_speaker_diarization: () => [[{ id: 1, start: 0, end: 10, confidence: .9 }]] });
  const embedding = async () => ({ embeddings: { data: new Float32Array([1, 0]) } });
  const turns = await diarize(audio, segmentation, processor, embedding, async () => ({}), speakers, () => {});
  assert.deepEqual(turns.map(t => [t.start, t.end]), [[0, 9], [9, 17], [17, 19]]);
  assert.equal(new Set(turns.map(t => t.speaker)).size, 1);
});

test('similar but different real-world voice directions do not merge at the matching threshold', () => {
  const speakers = [];
  const first = matchSpeakers([{ channel: 0, vector: [1, 0], seconds: 8 }], speakers);
  const second = matchSpeakers([{ channel: 0, vector: [.84, Math.sqrt(1 - .84 ** 2)], seconds: 8 }], speakers);
  const repeated = matchSpeakers([{ channel: 0, vector: [1, .08], seconds: 8 }], speakers);
  assert.notEqual(first.get(0), second.get(0));
  assert.equal(first.get(0), repeated.get(0));
});

test('the final covering window ends processing without a redundant overlapping tail', async () => {
  for (const seconds of [8, 9, 10, 17, 18]) {
    let calls = 0;
    const processor = Object.assign(async () => ({}), { post_process_speaker_diarization: () => [[{ id: 1, start: 0, end: 10, confidence: .9 }]] });
    const turns = await diarize(new Float32Array(seconds * 16000), async () => { calls++; return { logits: {} }; }, processor, async () => ({ embeddings: { data: new Float32Array([1, 0]) } }), async () => ({}), [], () => {});
    assert.equal(calls, seconds <= 10 ? 1 : 2);
    assert.equal(turns.at(-1).end, seconds);
    for (let i = 1; i < turns.length; i++) assert.equal(turns[i].start, turns[i - 1].end);
  }
});

test('shared clean speech anchors a continuing voice despite embedding variation and channel permutation', () => {
  const speakers = [];
  matchSpeakers([{ channel: 0, vector: [1, 0, 0], seconds: 6 }, { channel: 1, vector: [0, 0, 1], seconds: 3 }], speakers);
  const previous = [{ start: 0, end: 10, speaker: 'Speaker 1', uncertain: false }];
  const segments = [{ id: 2, start: 0, end: 5, confidence: .9 }, { id: 1, start: 5, end: 10, confidence: .9 }];
  const anchors = overlapSpeakerAnchors(segments, previous, 8);
  assert.deepEqual([...anchors], [[1, 'Speaker 1']]);
  const labels = matchSpeakers([
    { channel: 1, vector: [.84, Math.sqrt(1 - .84 ** 2), 0], seconds: 4 },
    { channel: 0, vector: [0, 0, 1], seconds: 4 },
  ], speakers, .93, anchors);
  assert.equal(labels.get(1), 'Speaker 1');
  assert.equal(labels.get(0), 'Speaker 2');
  assert.equal(speakers.length, 2);
});

test('overlap anchors reject uncertain, mixed, short or conflicting evidence without collapsing local voices', () => {
  const clean = [{ id: 1, start: 0, end: 10, confidence: .9 }];
  assert.equal(overlapSpeakerAnchors(clean, [{ start: 8, end: 10, speaker: 'Speaker 1', uncertain: true }], 8).size, 0);
  assert.equal(overlapSpeakerAnchors(clean, [{ start: 8, end: 8.3, speaker: 'Speaker 1' }], 8).size, 0);
  assert.equal(overlapSpeakerAnchors(clean, [{ start: 8, end: 9, speaker: 'Speaker 1' }, { start: 9, end: 10, speaker: 'Speaker 2' }], 8).size, 0);
  const alternating = [{ id: 1, start: 0, end: 1, confidence: .9 }, { id: 2, start: 1, end: 2, confidence: .9 }];
  assert.equal(overlapSpeakerAnchors(alternating, [{ start: 8, end: 10, speaker: 'Speaker 1' }], 8).size, 1);
  const speakers = [{ vector: [1, 0], weight: 6 }];
  const labels = matchSpeakers([{ channel: 0, vector: [0, 1], seconds: 4 }], speakers, .93, new Map([[0, 'Speaker 1']]));
  assert.equal(labels.get(0), 'Speaker 2'); // Strong voice disagreement overrules an unreliable temporal anchor.
});

test('embedding samples preserve continuous speech and exclude short, low-confidence and padded fragments', () => {
  const audio = Float32Array.from({ length: 10 * 16000 }, (_, i) => i);
  const short = [{ id: 1, start: 0, end: .7, confidence: .9 }, { id: 1, start: 1, end: 1.7, confidence: .9 }, { id: 1, start: 2, end: 2.7, confidence: .9 }];
  assert.equal(cleanSpeechSample(short, 0, audio, audio.length), null);
  assert.equal(cleanSpeechSample([{ id: 1, start: 0, end: 10, confidence: .6 }], 0, audio, audio.length), null);
  const sample = cleanSpeechSample([{ id: 1, start: 1, end: 4, confidence: .9 }, { id: 1, start: 8, end: 10, confidence: .9 }], 0, audio, 9 * 16000);
  assert.ok(Math.abs(sample.seconds - 2.8) < 1e-10);
  assert.equal(sample.samples[0], 1.1 * 16000);
  assert.ok(sample.samples.at(-1) < 4 * 16000);
  assert.equal(cleanSpeechSample([{ id: 1, start: 8, end: 10, confidence: .9 }], 0, audio, 9 * 16000), null);
  const speakers = [];
  assert.equal(matchSpeakers([{ channel: 0, vector: [1, 0], seconds: 1.6, allowNew: false }], speakers).size, 0);
  assert.equal(speakers.length, 0);
});

test('rolling continuous speech does not create a new identity at every window boundary', async () => {
  let window = 0, embeddings = 0;
  const processor = Object.assign(async () => ({}), { post_process_speaker_diarization: () => [[{ id: ++window % 2 ? 1 : 2, start: 0, end: 10, confidence: .9 }]] });
  const embedding = async () => {
    const angle = embeddings++ % 2 ? .5 : 0;
    return { embeddings: { data: new Float32Array([Math.cos(angle), Math.sin(angle)]) } };
  };
  const speakers = [];
  const turns = await diarize(new Float32Array(43 * 16000), async () => ({ logits: {} }), processor, embedding, async () => ({}), speakers, () => {});
  assert.equal(window, 6);
  assert.equal(speakers.length, 1);
  assert.equal(new Set(turns.map(turn => turn.speaker)).size, 1);
  assert.equal(turns.at(-1).end, 43);
});

test('continuity anchors preserve a real voice change and recognize the first voice after a gap', async () => {
  const audio = Float32Array.from({ length: 39 * 16000 }, (_, i) => i / 16000 + 1);
  const ranges = [{ start: 0, end: 15, voice: 0 }, { start: 15, end: 27, voice: 1 }, { start: 27, end: 39, voice: 0 }];
  const processor = Object.assign(async samples => ({ offset: samples[0] - 1 }), {
    post_process_speaker_diarization: ({ offset }) => [ranges.filter(range => range.end > offset && range.start < offset + 10)
      .map(range => ({ id: (range.voice + Math.floor(offset / 8)) % 3 + 1, start: Math.max(0, range.start - offset), end: Math.min(10, range.end - offset), confidence: .95 }))],
  });
  const embedding = async ({ time }) => ({ embeddings: { data: new Float32Array(time >= 15 && time < 27 ? [0, 1] : [1, 0]) } });
  const speakers = [];
  const turns = await diarize(audio, async value => ({ logits: value }), processor, embedding, async samples => ({ time: samples[0] - 1 }), speakers, () => {});
  assert.equal(speakers.length, 2);
  for (const turn of turns) {
    const midpoint = (turn.start + turn.end) / 2;
    assert.equal(turn.speaker, midpoint >= 15 && midpoint < 27 ? 'Speaker 2' : 'Speaker 1');
  }
});
