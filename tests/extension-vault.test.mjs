import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const bundled = await build({entryPoints:['extension/src/vault-crypto.ts'],bundle:true,write:false,format:'iife',globalName:'vault'});
const context = {crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,atob,btoa};
vm.runInNewContext(bundled.outputFiles[0].text,context);
const api = context.vault;
const bytes = value => new TextEncoder().encode(value);
const plain = value => new TextDecoder().decode(value);

test('recovery phrase unlocks the same identity without persisting its private key in the vault descriptor',async()=>{
  const created = await api.createVault();
  assert.equal(created.phrase.split(' ').length,24);
  assert.equal(created.privateKey.extractable,false);
  assert.equal(JSON.stringify(created.descriptor).includes(created.phrase),false);
  assert.equal('privateKey' in created.descriptor,false);
  const unlocked = await api.unlockRecovery(created.descriptor,created.phrase);
  assert.equal(unlocked.extractable,false);
  const record = await api.createRecordingKey(created.descriptor,'record-1');
  const cipher = await api.encryptPayload(record.key,bytes('saved audio'),['pcm','record-1',0,16000]);
  const restored = await api.openRecordingKey(created.descriptor,unlocked,'record-1',record.envelope);
  assert.equal(plain(await api.decryptPayload(restored,cipher,['pcm','record-1',0,16000])),'saved audio');
});

test('public descriptor alone can encrypt a new offline recording; existing audio needs the private identity',async()=>{
  const created = await api.createVault();
  const publicCopy = JSON.parse(JSON.stringify(created.descriptor));
  const first = await api.createRecordingKey(publicCopy,'record-1');
  const second = await api.createRecordingKey(publicCopy,'record-2');
  const cipher = await api.encryptPayload(first.key,bytes('first meeting'),['metadata','record-1']);
  await assert.rejects(api.decryptPayload(second.key,cipher,['metadata','record-1']));
  await assert.rejects(api.openRecordingKey(publicCopy,null,'record-1',first.envelope));
  const restored = await api.openRecordingKey(publicCopy,created.privateKey,'record-1',first.envelope);
  assert.equal(plain(await api.decryptPayload(restored,cipher,['metadata','record-1'])),'first meeting');
});

test('wrong valid phrase, corrupted ciphertext, and changed authenticated context never yield audio',async()=>{
  const created = await api.createVault();
  const wrong = await api.createVault();
  await assert.rejects(api.unlockRecovery(created.descriptor,wrong.phrase),/unlock|recovery/i);
  await assert.rejects(api.unlockRecovery(created.descriptor,'not a recovery phrase'),/recovery/i);
  const record = await api.createRecordingKey(created.descriptor,'record-1');
  const cipher = await api.encryptPayload(record.key,bytes('private PCM'),['pcm','record-1',0,16000]);
  for (const binding of [['pcm','record-1',1,16000],['pcm','record-2',0,16000],['pcm','record-1',0,15999]]) {
    await assert.rejects(api.decryptPayload(record.key,cipher,binding));
  }
  const raw = new Uint8Array(atob(cipher.ciphertext).split('').map(ch=>ch.charCodeAt(0)));raw[0]^=1;
  await assert.rejects(api.decryptPayload(record.key,{...cipher,ciphertext:btoa(String.fromCharCode(...raw))},['pcm','record-1',0,16000]));
  await assert.rejects(api.openRecordingKey(created.descriptor,created.privateKey,'record-2',record.envelope));
});

test('unique nonces and envelope keys prevent reuse across writes and recordings',async()=>{
  const created = await api.createVault();
  const record = await api.createRecordingKey(created.descriptor,'record-1');
  const first = await api.encryptPayload(record.key,bytes('same payload'),['metadata','record-1']);
  const second = await api.encryptPayload(record.key,bytes('same payload'),['metadata','record-1']);
  assert.notEqual(first.nonce,second.nonce);
  assert.notEqual(first.ciphertext,second.ciphertext);
  const next = await api.createRecordingKey(created.descriptor,'record-1');
  assert.notEqual(next.envelope.ephemeralPublicKey,record.envelope.ephemeralPublicKey);
});

test('untrusted envelope versions, oversized data, and mismatched public identities fail closed',async()=>{
  const created = await api.createVault();
  const record = await api.createRecordingKey(created.descriptor,'record-1');
  await assert.rejects(api.openRecordingKey(created.descriptor,created.privateKey,'record-1',{...record.envelope,version:2}));
  await assert.rejects(api.encryptPayload(record.key,new Uint8Array(8*1024*1024+1),['pcm']));
  const other = await api.createVault();
  await assert.rejects(api.unlockRecovery({...created.descriptor,publicKey:other.descriptor.publicKey},created.phrase));
});
