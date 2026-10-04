import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, matchSpeakers, speakerPassages, diarize } from '../web/diarization.js';
import { MODELS, resolveSpeechModel, DEFAULT_SPEECH_MODEL } from '../web/models.js';

test('catalog retires Tiny/Base while existing meetings resolve to Turbo', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['onnx-community/whisper-large-v3-turbo', 'onnx-community/whisper-large-v3']);
  assert.equal(resolveSpeechModel('onnx-community/whisper-base'), DEFAULT_SPEECH_MODEL);
  assert.equal(resolveSpeechModel('onnx-community/whisper-tiny.en'), DEFAULT_SPEECH_MODEL);
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
