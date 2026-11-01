import { defined } from '../helpers/assertions.ts';
import type { StorageApi } from '../helpers/extension-test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  bundle,
  memoryDatabase,
  sampleRow,
  library,
} from '../helpers/extension-test-helpers.ts';
const contents = `import * as journal from './extension/src/storage';globalThis.api={...journal};`;
async function harness() {
  const h = fixture<StorageApi>();
  h.data = memoryDatabase(h);
  h.api = await bundle(h, contents);
  return h;
}
test('v3 records offline with non-extractable device key, encrypted metadata/PCM; reads survive restart; lists never decrypt', async () => {
  const h = await harness(),
    row = sampleRow();
  await h.api.createRecording(row);
  const pcm = Uint8Array.from([1, 2, 3, 4]).buffer;
  await h.api.appendChunk(row.recordingId, 0, pcm);
  await h.api.updateRecording(row.recordingId, { captureState: 'stopped' });
  assert.equal(defined(defined(h.data['recordings']).get(row.recordingId)).version, 3);
  assert.equal(defined(h.meta.get('credential-device-key')).extractable, false);
  assert.ok(!JSON.stringify([...defined(h.data['recordings']).values()]).includes('Private title'));
  assert.equal(defined(defined(h.data['chunks']).values().next().value).pcm, undefined);
  h.api = await bundle(h, contents);
  assert.deepEqual(
    new Uint8Array(defined(await h.api.getChunk(row.recordingId, 0)).pcm),
    new Uint8Array(pcm),
  );
  assert.equal(defined(await h.api.recording(row.recordingId)).title, 'Private title');
  assert.equal(h.calls.length, 0);
  const stored = defined(h.data['recordings']).get(row.recordingId);
  defined(stored).metadata = { version: 1, nonce: '', ciphertext: '' };
  assert.equal((await h.api.allRecordings()).length, 1);
  await assert.rejects(h.api.recording(row.recordingId));
});
test('v3 transfer receipts remove encrypted metadata and PCM, then prune after seven days', async () => {
  const h = await harness();
  const value = { ...sampleRow(), libraryId: library };
  await h.api.createRecording(value);
  await h.api.appendChunk(value.recordingId, 0, Uint8Array.from([9, 8, 7, 6]).buffer);
  await h.api.updateRecording(value.recordingId, { captureState: 'stopped' });
  const receipt = {
    libraryId: library,
    meetingId: crypto.randomUUID(),
    verifiedAt: new Date().toISOString(),
  };
  await h.api.retainReceiptAndRemovePCM(value.recordingId, receipt);
  const row = defined(h.data['recordings']).get(value.recordingId);
  assert.equal(defined(row).version, 3);
  assert.equal(defined(row).metadata, undefined);
  assert.equal(defined(row).keyWrap, undefined);
  assert.equal(defined(h.data['chunks']).size, 0);
  assert.equal(defined(defined(h.data['meta']).get('pendingBytes')).value, 0);
  assert.deepEqual(defined(await h.api.recording(value.recordingId)).receipt, receipt);
  await h.api.pruneReceipts(Date.now() + 6 * 86400000);
  assert.equal(defined(h.data['recordings']).size, 1);
  await h.api.pruneReceipts(Date.now() + 8 * 86400000);
  assert.equal(defined(h.data['recordings']).size, 0);
});
test('v3 offline export preserves WAV audio after restart, and delete releases its local storage', async () => {
  const h = await harness();
  const row = sampleRow();
  const pcm = Uint8Array.from([1, 2, 3, 4]).buffer;
  await h.api.createRecording(row);
  await h.api.appendChunk(row.recordingId, 0, pcm);
  await h.api.updateRecording(row.recordingId, { captureState: 'stopped' });
  h.api = await bundle(h, contents);
  const parts: number[] = [];
  for await (const part of h.api.exportParts(row.recordingId)) {
    assert.equal(part.blob.type, 'audio/wav');
    assert.equal(part.part, 1);
    assert.equal(part.startFrame, 0);
    assert.equal(part.frames, 2);
    const wav = new Uint8Array(await part.blob.arrayBuffer());
    assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
    parts.push(...wav.slice(44));
  }
  assert.deepEqual(parts, [...new Uint8Array(pcm)]);
  await h.api.deleteRecording(row.recordingId);
  assert.equal(await h.api.recording(row.recordingId), undefined);
  assert.equal(defined(h.data['chunks']).size, 0);
  assert.equal(defined(defined(h.data['meta']).get('pendingBytes')).value, 0);
  assert.equal(h.calls.length, 0);
});
