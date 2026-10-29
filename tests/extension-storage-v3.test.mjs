import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  fixture,
  bundle,
  memoryDatabase,
  sampleRow,
  library,
  endpoint,
  reply,
} from './extension-test-helpers.mjs';
const contents = `import * as journal from './extension/src/storage';import * as secrets from './extension/src/device-secrets';import * as settings from './extension/src/settings';import * as encryption from './extension/src/encryption';import {unlockWithRecoveryPhrase} from './extension/src/legacy-vault';globalThis.api={...journal,...secrets,...settings,...encryption,unlockWithRecoveryPhrase};`;
async function harness() {
  const h = fixture();
  h.data = memoryDatabase(h);
  h.api = await bundle(h, contents);
  return h;
}
// The former vault-crypto recovery wrapping of the vault's private identity.
async function recoveryEnvelope(api, phrase, vaultId, publicKey, privateBytes) {
  const material = await webcrypto.subtle.importKey(
    'raw',
    mnemonicToEntropy(phrase, wordlist),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('Echo recording vault v1'),
      info: new TextEncoder().encode(JSON.stringify(['echo-vault', 1, 'recovery', vaultId])),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return api.encryptPayload(key, privateBytes, ['private-identity', vaultId, publicKey]);
}
async function legacy(h, { session = true, receipt = false, migrating = false, phrase } = {}) {
  const api = h.api;
  const identity = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const ephemeral = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const base64 = (value) => Buffer.from(value).toString('base64');
  const vaultId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const publicKey = base64(await webcrypto.subtle.exportKey('raw', identity.publicKey));
  const ephemeralPublicKey = base64(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));
  const privateMaterial = base64(await webcrypto.subtle.exportKey('pkcs8', identity.privateKey));
  const recovery = phrase
    ? await recoveryEnvelope(
        api,
        phrase,
        vaultId,
        publicKey,
        new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', identity.privateKey)),
      )
    : {};
  const descriptor = { version: 1, vaultId, publicKey, recovery };
  h.meta.set('recording-vault', descriptor);
  if (session) h.session.recordingVaultIdentity = { vaultId, privateMaterial };
  const shared = await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: identity.publicKey },
    ephemeral.privateKey,
    256,
  );
  const binding = ['recording-key', vaultId, id, ephemeralPublicKey];
  const keyMaterial = await webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrapping = await webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('Echo recording vault v1'),
      info: new TextEncoder().encode(JSON.stringify(['echo-vault', 1, ...binding])),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const raw = webcrypto.getRandomValues(new Uint8Array(32));
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const wrappedKey = await api.encryptPayload(wrapping, raw, binding);
  const row = {
    ...sampleRow(id),
    captureState: 'stopped',
    chunkCount: 1,
    totalFrames: 4,
    ...(receipt
      ? {
          receipt: {
            libraryId: library,
            meetingId: crypto.randomUUID(),
            verifiedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
  const metadata = await api.encryptPayload(key, new TextEncoder().encode(JSON.stringify(row)), [
    'metadata',
    vaultId,
    id,
  ]);
  h.data.recordings.set(id, {
    version: 2,
    recordingId: id,
    libraryId: null,
    chunkCount: 1,
    totalFrames: 4,
    captureState: 'stopped',
    transferState: 'saved-local',
    interrupted: false,
    receipt: row.receipt,
    envelope: { version: 1, vaultId, ephemeralPublicKey, wrappedKey },
    metadata,
    ...(migrating ? { migrating: true } : {}),
  });
  const pcm = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
  const encrypted = await api.encryptPayload(key, new Uint8Array(pcm), ['pcm', vaultId, id, 0, 4]);
  h.data.chunks.set(JSON.stringify([id, 0]), {
    recordingId: id,
    sequence: 0,
    frames: 4,
    version: 2,
    encrypted,
  });
  h.data.meta.set('pendingBytes', { key: 'pendingBytes', value: 8 });
  return { id, pcm, privateMaterial, descriptor, encrypted };
}
test('v3 records offline with non-extractable device key, encrypted metadata/PCM; reads survive restart; lists never decrypt', async () => {
  const h = await harness(),
    row = sampleRow();
  await h.api.createRecording(row);
  const pcm = Uint8Array.from([1, 2, 3, 4]).buffer;
  await h.api.appendChunk(row.recordingId, 0, pcm);
  await h.api.updateRecording(row.recordingId, { captureState: 'stopped' });
  assert.equal(h.data.recordings.get(row.recordingId).version, 3);
  assert.equal(h.meta.get('credential-device-key').extractable, false);
  assert.ok(!JSON.stringify([...h.data.recordings.values()]).includes('Private title'));
  assert.equal(h.data.chunks.values().next().value.pcm, undefined);
  h.api = await bundle(h, contents);
  assert.deepEqual(
    new Uint8Array((await h.api.getChunk(row.recordingId, 0)).pcm),
    new Uint8Array(pcm),
  );
  const stored = h.data.recordings.get(row.recordingId);
  stored.metadata = { version: 1, nonce: '', ciphertext: '' };
  assert.equal((await h.api.allRecordings()).length, 1);
  await assert.rejects(h.api.recording(row.recordingId));
});
test('v2 → v3 rewrap keeps ciphertext and chunk AAD unchanged; PCM round-trips via getChunk', async () => {
  const h = await harness();
  const old = await legacy(h);
  await h.api.migrateRecordings();
  await h.api.migrateRecordings();
  const row = h.data.recordings.get(old.id);
  assert.equal(row.version, 3);
  assert.equal(row.keyContext, old.descriptor.vaultId);
  assert.ok(row.keyWrap);
  assert.deepEqual(h.data.chunks.get(JSON.stringify([old.id, 0])).encrypted, old.encrypted);
  h.api = await bundle(h, contents);
  assert.deepEqual(new Uint8Array((await h.api.getChunk(old.id, 0)).pcm), new Uint8Array(old.pcm));
  assert.equal((await h.api.recording(old.id)).title, 'Private title');
});
test('locked legacy row remains intact with needsUnlock; GET escrow retries migration then DELETE only after rewrap', async () => {
  const h = await harness(),
    old = await legacy(h, { session: false });
  await h.api.migrateRecordings();
  assert.equal(h.data.recordings.get(old.id).needsUnlock, true);
  assert.equal((await h.api.allRecordings())[0].needsUnlock, true);
  await assert.rejects(h.api.getChunk(old.id, 0), /unlock/);
  await h.api.saveLink({ state: 'connected', endpoint, libraryId: library, credential: 'a' });
  h.fetch = async (url, options) => {
    if (options.method === 'DELETE') {
      assert.equal(h.data.recordings.get(old.id).version, 3);
      return new Response(null, { status: 204 });
    }
    return reply({
      vaultId: old.descriptor.vaultId,
      libraryId: library,
      privateMaterial: old.privateMaterial,
    });
  };
  await h.api.migrateRecordings();
  await h.api.migrateRecordings();
  assert.deepEqual(new Uint8Array((await h.api.getChunk(old.id, 0)).pcm), new Uint8Array(old.pcm));
  assert.equal(h.calls.filter(([, options]) => options.method === 'DELETE').length, 1);
});
test('plaintext migration is restartable after row commit, verifies hashes, encrypts chunks', async () => {
  const h = await harness(),
    row = { ...sampleRow(), captureState: 'stopped', totalFrames: 2, chunkCount: 1 };
  const pcm = Uint8Array.from([9, 8, 7, 6]).buffer;
  h.data.recordings.set(row.recordingId, row);
  h.data.chunks.set(JSON.stringify([row.recordingId, 0]), {
    recordingId: row.recordingId,
    sequence: 0,
    frames: 2,
    pcm,
    sha256: 'bad',
  });
  await assert.rejects(h.api.migrateRecordings(), /integrity/);
  assert.equal(h.data.recordings.get(row.recordingId).migrating, true);
  h.data.chunks.get(JSON.stringify([row.recordingId, 0])).sha256 = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', pcm),
  ).toString('hex');
  h.api = await bundle(h, contents);
  await h.api.migrateRecordings();
  assert.equal(h.data.recordings.get(row.recordingId).migrating, undefined);
  assert.equal(h.data.chunks.values().next().value.pcm, undefined);
  assert.deepEqual(
    new Uint8Array((await h.api.getChunk(row.recordingId, 0)).pcm),
    new Uint8Array(pcm),
  );
});
test('legacy receipts migrate without unlock to summary-only rows; receipts prune after seven days', async () => {
  const h = await harness(),
    old = await legacy(h, { session: false, receipt: true });
  // Historical receipts carry their owning library even when no identity is available.
  h.data.recordings.get(old.id).libraryId = library;
  await h.api.migrateRecordings();
  const row = h.data.recordings.get(old.id);
  assert.equal(row.version, 3);
  assert.equal(row.metadata, undefined);
  assert.equal(row.keyWrap, undefined);
  assert.equal(h.data.chunks.size, 0);
  await h.api.pruneReceipts(Date.now() + 6 * 86400000);
  assert.equal(h.data.recordings.size, 1);
  await h.api.pruneReceipts(Date.now() + 8 * 86400000);
  assert.equal(h.data.recordings.size, 0);
});
test('the old recovery phrase unlocks recordings Echo never escrowed, without re-encrypting or storing it', async () => {
  const h = await harness();
  const phrase = generateMnemonic(wordlist, 256);
  const old = await legacy(h, { session: false, phrase });
  h.fetch = async () => new Response('{}', { status: 404 });
  await h.api.migrateRecordings();
  assert.equal(h.data.recordings.get(old.id).needsUnlock, true);
  await assert.rejects(h.api.unlockWithRecoveryPhrase('word '.repeat(12)), /24 recovery words/);
  await assert.rejects(
    h.api.unlockWithRecoveryPhrase(generateMnemonic(wordlist, 256)),
    /does not unlock/,
  );
  await h.api.migrateRecordings();
  assert.equal(h.data.recordings.get(old.id).needsUnlock, true, 'a wrong phrase unlocks nothing');
  // Pasted phrases may carry capitals and extra whitespace.
  await h.api.unlockWithRecoveryPhrase(`  ${phrase.toUpperCase().split(' ').join('\n ')}  `);
  await h.api.migrateRecordings();
  const row = h.data.recordings.get(old.id);
  assert.equal(row.version, 3);
  assert.equal(row.needsUnlock, undefined);
  assert.deepEqual(
    h.data.chunks.get(JSON.stringify([old.id, 0])).encrypted,
    old.encrypted,
    'audio ciphertext is never rewritten',
  );
  assert.deepEqual(new Uint8Array((await h.api.getChunk(old.id, 0)).pcm), new Uint8Array(old.pcm));
  const persisted = JSON.stringify([h.local, h.session, [...h.meta], [...h.data.meta]]);
  // Base64 has no spaces, so any two consecutive words would be the phrase itself.
  assert.ok(!persisted.includes(phrase.split(' ').slice(0, 2).join(' ')));
  assert.ok(!persisted.includes(old.privateMaterial));
});
