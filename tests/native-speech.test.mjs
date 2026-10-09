import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { validateRequest, decodePCM, readEncryptedPCM, readPrivateRequest, validatedWords, validateWeights, validateReady, correctPinnedAlignment, MODEL_ID, CHECKPOINT, REVISION } from '../scripts/native-speech.mjs';

const scratch = path.resolve('tmp');
await mkdir(scratch, { recursive: true });
async function fixture(t) {
  const root = await mkdtemp(path.join(scratch, 'native-speech-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('native requests keep model choice fixed and accept only supported language and private path fields', () => {
  for (const language of ['en', 'es', 'fr', 'de', 'hi', 'ja', 'pt', 'zh', 'auto']) {
    assert.equal(validateRequest({ operation: 'transcribe', cacheDir: '/private/cache', audioPath: '/private/audio', audioBytes: 4, audioKey: Buffer.alloc(32).toString('base64'), language }).language, language);
  }
  for (const invalid of [null, {}, { operation: 'download', cacheDir: 'relative' }, { operation: 'transcribe', cacheDir: '/private/cache' }, { operation: 'download', cacheDir: '/private/cache', model: 'different-model' }, { operation: 'download', cacheDir: '/private/cache', language: 'untrusted' }]) assert.throws(() => validateRequest(invalid));
});

test('native PCM rejects empty, unaligned and non-finite input before model execution', () => {
  const bytes = Buffer.alloc(12);
  bytes.writeFloatLE(-0.5, 0); bytes.writeFloatLE(0, 4); bytes.writeFloatLE(0.5, 8);
  assert.deepEqual([...decodePCM(bytes)], [-0.5, 0, 0.5]);
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(3)]) assert.throws(() => decodePCM(invalid));
  for (const invalid of [NaN, Infinity, -Infinity]) { bytes.writeFloatLE(invalid, 4); assert.throws(() => decodePCM(bytes), /non-finite/); }
});

test('native output requires actual finite ordered word timestamps within the recorded audio', () => {
  const output = { text: 'Hello world', chunks: [{ text: ' Hello', timestamp: [0.2, 0.6] }, { text: ' world', timestamp: [0.6, 1] }] };
  assert.deepEqual(validatedWords(output, 1), output.chunks);
  assert.deepEqual(validatedWords({ text: '', chunks: [] }, 1), []);
  for (const timestamp of [[NaN, 1], [1, 0], [0, Infinity], [0, undefined], [0]]) assert.throws(() => validatedWords({ chunks: [{ text: 'word', timestamp }] }, 1));
  assert.deepEqual(validatedWords({ chunks: [{ text: 'first', timestamp: [-0.02, 0.2] }, { text: 'last', timestamp: [0.2, null] }] }, 1), [{ text: 'first', timestamp: [0, 0.2] }, { text: 'last', timestamp: [0.2, 1] }]);
  assert.deepEqual(validatedWords({ chunks: [{ text: 'tail', timestamp: [0.98, 1.02] }] }, 1), [{ text: 'tail', timestamp: [0.98, 1] }]);
  assert.throws(() => validatedWords({ chunks: [{ text: 'broken', timestamp: [25.98, 25.98] }] }, 13), /alignment exceeded/);
  assert.throws(() => validatedWords({ chunks: [{ text: 'broken', timestamp: [-1, 0.2] }] }, 1), /alignment exceeded/);
  assert.throws(() => validatedWords({ chunks: [{ text: 'one', timestamp: [11.18, 11.18] }, { text: 'two', timestamp: [11.18, 11.18] }] }, 13), /collapsed/);
  assert.throws(() => validatedWords({ text: 'Missing words', chunks: [] }, 1));
  assert.throws(() => validatedWords({ chunks: [{ text: 'first', timestamp: [0.8, 0.9] }, { text: 'backward', timestamp: [0.1, 0.2] }] }, 1));
});

test('pinned Large V3 alignment uses its original heads and actual stride-two encoder frame count', () => {
  const calls = [], model = { _extract_token_timestamps(...args) { calls.push(args); return 'aligned'; } };
  correctPinnedAlignment(model);
  const outputs = { actual: true };
  assert.equal(model._extract_token_timestamps(outputs, [[9, 19]], 1301, 0.02), 'aligned');
  assert.deepEqual(calls[0], [outputs, [[7, 0], [10, 17], [12, 18], [13, 12], [16, 1], [17, 14], [19, 11], [21, 4], [24, 1], [25, 6]], 650, 0.02]);
  assert.throws(() => model._extract_token_timestamps(outputs, [], undefined), /actual audio/);
});

test('partial native weights cannot be trusted and only an explicit download removes its pinned partial files', async t => {
  const root = await fixture(t), folder = path.join(root, CHECKPOINT, REVISION, 'onnx');
  await mkdir(folder, { recursive: true });
  const partial = path.join(folder, 'encoder_model_quantized.onnx');
  const unrelated = path.join(folder, 'unrelated.bin');
  await writeFile(partial, 'partial'); await writeFile(unrelated, 'keep');
  await assert.rejects(validateWeights(root), /complete native/);
  assert.equal(await readFile(partial, 'utf8'), 'partial');
  await validateWeights(root, true);
  await assert.rejects(readFile(partial), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

test('native readiness rejects unqualified and escaping manifests', async t => {
  const root = await fixture(t);
  const ready = { version: 1, modelId: MODEL_ID, checkpoint: CHECKPOINT, revision: REVISION, files: [{ path: '../outside', size: 1 }], forwardVerified: false };
  await writeFile(path.join(root, 'ready.json'), JSON.stringify(ready));
  await assert.rejects(validateReady(root), /execution check/);
  ready.forwardVerified = true;
  await writeFile(path.join(root, 'ready.json'), JSON.stringify(ready));
  await assert.rejects(validateReady(root), /Invalid native/);
});

test('native weight checks reject symbolic-link ancestors before trusting or removing any target', async t => {
  const root = await fixture(t), external = await fixture(t);
  const folder = path.join(root, CHECKPOINT, REVISION);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(external, 'encoder_model_quantized.onnx'), 'keep external');
  await symlink(external, path.join(folder, 'onnx'), 'dir');
  await assert.rejects(validateWeights(root, true), /symbolic links/);
  assert.equal(await readFile(path.join(external, 'encoder_model_quantized.onnx'), 'utf8'), 'keep external');
});

test('the real native helper exits promptly when its stdin lease closes or its owner signals cancellation', { timeout: 10000 }, async t => {
  const root = await fixture(t), preload = path.join(root, 'no-network.mjs');
  await writeFile(preload, 'globalThis.fetch = () => new Promise(() => {});');
  for (const stop of ['eof', 'signal']) {
    const child = spawn(process.execPath, ['--import', preload, 'scripts/native-speech.mjs', '--stdin-request'], { cwd: process.cwd(), env: { ...process.env, TMPDIR: scratch }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(`${JSON.stringify({ operation: 'download', cacheDir: path.join(root, stop) })}\n`);
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let text = '', diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(); });
      child.once('exit', () => reject(new Error(`Helper exited before running: ${text} ${diagnostics}`)));
      child.once('error', reject);
    });
    const first = JSON.parse(text.split('\n')[0]);
    assert.equal(first.type, 'progress');
    assert.equal(first.progress.status, 'Downloading native Large V3');
    if (stop === 'eof') child.stdin.end(); else child.kill('SIGTERM');
    const terminal = await exited;
    assert.equal(terminal.signal, 'SIGKILL');
    assert.ok(text.trim().split('\n').every(line => JSON.parse(line).type === 'progress'), 'Protocol stdout must contain only JSON and never a fabricated result');
  }
});

test('a terminal helper error is flushed as JSON and its owner retains the process lease', { timeout: 10000 }, async t => {
  const root = await fixture(t);
  const child = spawn(process.execPath, ['scripts/native-speech.mjs', '--stdin-request'], { cwd: process.cwd(), env: { ...process.env, TMPDIR: scratch }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(`${JSON.stringify({ operation: 'untrusted', cacheDir: root })}\n`);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let text = '';
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(); });
    child.once('exit', () => reject(new Error('Helper exited before its terminal protocol message.')));
    child.once('error', reject);
  });
  assert.equal(JSON.parse(text.trim()).type, 'error');
  assert.equal(child.exitCode, null);
  child.stdin.end();
  assert.equal((await exited).signal, 'SIGKILL');
});

function encryptedFixture(audio, key, sizes = [audio.length]) {
  const parts = [Buffer.from('ECHOPCM1')]; let offset = 0, index = 0n;
  for (const size of sizes) {
    const binding = Buffer.alloc(12), nonce = Buffer.alloc(12);
    binding.writeBigUInt64LE(index); binding.writeUInt32LE(size, 8); nonce.writeBigUInt64LE(index, 4);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(binding);
    const encrypted = Buffer.concat([cipher.update(audio.subarray(offset, offset + size)), cipher.final()]);
    parts.push(binding.subarray(8), encrypted, cipher.getAuthTag()); offset += size; index++;
  }
  return Buffer.concat(parts);
}

test('encrypted PCM authenticates odd record boundaries and rejects tampering, truncation, swaps and plaintext', async t => {
  const root = await fixture(t), audioPath = path.join(root, 'audio.enc');
  const key = randomBytes(32), audio = Buffer.alloc(12);
  audio.writeFloatLE(-0.5, 0); audio.writeFloatLE(0, 4); audio.writeFloatLE(0.5, 8);
  const sealed = encryptedFixture(audio, key, [3, 9]);
  const request = () => ({ operation: 'transcribe', cacheDir: root, audioPath, audioKey: key.toString('base64'), audioBytes: audio.length });
  await writeFile(audioPath, sealed);
  assert.deepEqual([...await readEncryptedPCM(request())], [-0.5, 0, 0.5]);
  assert.equal(sealed.includes(audio), false);
  const tampered = Buffer.from(sealed); tampered[16] ^= 1;
  for (const invalid of [tampered, sealed.subarray(0, -1), Buffer.concat([sealed, Buffer.from([0])]), audio, encryptedFixture(audio, randomBytes(32), [3, 9])]) {
    await writeFile(audioPath, invalid); await assert.rejects(readEncryptedPCM(request()));
  }
  await writeFile(audioPath, encryptedFixture(audio, key));
  await assert.rejects(readEncryptedPCM({ ...request(), audioBytes: 8 }));
  await writeFile(audioPath, sealed); await symlink(audioPath, path.join(root, 'link.enc'));
  await assert.rejects(readEncryptedPCM({ ...request(), audioPath: path.join(root, 'link.enc') }));
});

test('private request uses a bounded stdin frame and keeps the owner lease open', async () => {
  const input = new PassThrough(), result = readPrivateRequest(input);
  input.write('{"operation":"down'); input.write('load","cacheDir":"/cache"}\n');
  assert.deepEqual(await result, { operation: 'download', cacheDir: '/cache' });
  assert.equal(input.readableEnded, false); input.end();
  for (const bytes of [Buffer.alloc(4097), Buffer.from('{}\nextra')]) {
    const invalid = new PassThrough(), rejected = readPrivateRequest(invalid); invalid.write(bytes);
    await assert.rejects(rejected); invalid.end();
  }
});
