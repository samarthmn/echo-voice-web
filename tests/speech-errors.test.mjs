import test from 'node:test';
import assert from 'node:assert/strict';
import { speechErrorDetail, speechFailureMessage, traceSpeechSessions, traceSpeechChunks } from '../web/speech-errors.js';

test('native exceptions keep numeric, string, and cross-realm object diagnostics', () => {
  assert.equal(speechErrorDetail(735912), 'ONNX runtime exception 735912');
  assert.equal(speechErrorDetail('decoder failed'), 'decoder failed');
  assert.equal(speechErrorDetail({ message: 'OrtRun failed' }), 'OrtRun failed');
  assert.equal(speechErrorDetail({ code: 6, reason: 'invalid shape' }), '{"code":6,"reason":"invalid shape"}');
  const cycle = {}; cycle.self = cycle;
  assert.match(speechErrorDetail(cycle), /unknown error/);
});

test('failed Large V3 inference keeps the runtime exception, phase, and safe retry path', () => {
  const message = speechFailureMessage(735912, { modelName: 'Whisper Large V3', phase: 'transcribing audio and aligning word timestamps' });
  assert.match(message, /Whisper Large V3 failed while transcribing audio and aligning word timestamps/);
  assert.match(message, /ONNX runtime exception 735912/);
  assert.match(message, /Retry with Large V3 Turbo/);
  assert.match(message, /Saved audio and transcripts are unchanged/);
  assert.doesNotMatch(message, /ran out of memory/);
});

test('allocation, network, and storage failures retain diagnostics and appropriate recovery', () => {
  const allocation = speechFailureMessage(new Error('failed to allocate a buffer of size 915059840'));
  assert.match(allocation, /failed to allocate a buffer of size 915059840/);
  assert.match(allocation, /memory error/);
  const network = speechFailureMessage('Failed to fetch', { download: true });
  assert.match(network, /Hugging Face/);
  assert.match(network, /Completed files are kept/);
  const storage = speechFailureMessage({ message: 'QuotaExceededError' }, { download: true });
  assert.match(storage, /QuotaExceededError/);
  assert.match(storage, /Free disk space/);
});

test('session diagnostics retain native method ownership and rejection values', async () => {
  const phases = [];
  const sessions = {
    model: { async run(value) { assert.equal(this, sessions.model); return value + 1; } },
    decoder_model_merged: { async run() { assert.equal(this, sessions.decoder_model_merged); throw 123456; } },
  };
  traceSpeechSessions(sessions, phase => phases.push(phase));
  assert.equal(await sessions.model.run(2), 3);
  await assert.rejects(sessions.decoder_model_merged.run(), value => value === 123456);
  assert.deepEqual(phases, ['running the speech encoder', 'running the word timestamp decoder']);
});

test('real generation calls report eight overlapping chunks for 150 seconds without fake percentages', async () => {
  const updates = [], phases = [];
  const model = {
    sessions: { model: { async run() {} }, decoder_model_merged: { async run() {} } },
    async generate(value) {
      assert.equal(this, model);
      await this.sessions.model.run();
      for (let i = 0; i < 33; i++) await this.sessions.decoder_model_merged.run();
      return value;
    },
  };
  traceSpeechChunks(model, 150 * 16000, value => updates.push(value), value => phases.push(value));
  for (let i = 0; i < 8; i++) assert.equal(await model.generate(i), i);
  assert.equal(updates[0].totalChunks, 8);
  assert.equal(updates.filter(value => value.status.startsWith('Aligned chunk')).length, 8);
  assert.match(updates.at(-1).status, /Aligned chunk 8 of 8/);
  assert.ok(updates.some(value => value.status.includes('32 decoder steps')));
  assert.ok(updates.every(value => !('progress' in value)));
  assert.ok(phases.includes('running the word timestamp decoder'));
});

test('a failed chunk keeps its native exception and is not reported as aligned', async () => {
  const updates = [];
  const model = {
    sessions: { model: { async run() {} }, decoder_model_merged: { async run() {} } },
    async generate() { throw 123456; },
  };
  traceSpeechChunks(model, 13 * 16000, value => updates.push(value), () => {});
  await assert.rejects(model.generate(), value => value === 123456);
  assert.deepEqual(updates, [{ status: 'Transcribing chunk 1 of 1', chunk: 1, totalChunks: 1 }]);
});
