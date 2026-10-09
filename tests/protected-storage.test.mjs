import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const scratch = join(project, 'tmp', 'server-storage-http');
const binary = resolve(process.env.ECHO_TEST_BINARY || join(project, 'target/debug/echo-server'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value;
}
async function launch(directory, key, expectFailure = false) {
  const address = await port();
  const child = spawn(binary, [], { cwd: project, env: { ...process.env, TMPDIR: scratch, ECHO_TEST_MODE: '1', ECHO_TEST_STORAGE_KEY: key, ECHO_DATA_DIR: directory, ECHO_BIND: `127.0.0.1:${address}`, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${address}`;
  let logs = ''; let spawnError;
  child.on('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-6000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      if (expectFailure) { assert.notEqual(child.exitCode, 0); return { logs }; }
      throw new Error(`Isolated server failed: ${logs}`);
    }
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(200) });
      if (response.ok) {
        if (expectFailure) { child.kill('SIGKILL'); assert.fail('Incorrect key unexpectedly unlocked the library'); }
        return { child, base, logs: () => logs };
      }
    } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    await pause(50);
  }
  child.kill('SIGKILL'); throw new Error(`Isolated server startup timed out: ${logs}`);
}
async function stop(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit'); server.child.kill('SIGINT');
  const timer = setTimeout(() => server.child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}
function wav(length) {
  const bytes = Buffer.alloc(length);
  for (let offset = 44; offset < length; offset++) bytes[offset] = offset % 251;
  bytes.write('RIFF'); bytes.writeUInt32LE(length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(length - 44, 40); return bytes;
}

test('real server encrypts metadata and audio, authenticates range blocks, and fails closed with a wrong key', { timeout: 30000 }, async () => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'library-'));
  const key = randomBytes(32).toString('base64'); let server;
  try {
    server = await launch(directory, key);
    async function api(path, method = 'GET', body) {
      const response = await fetch(`${server.base}/api${path}`, { method, headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
      const value = await response.json(); assert.ok(response.ok, `${path}: ${value.error}`); return value;
    }
    const title = 'Private encrypted storage regression meeting';
    const meeting = await api('/meetings', 'POST', { title, mode: 'import', consent: false });
    const first = wav(140000), second = Buffer.alloc(70000, 71), whole = Buffer.concat([first, second]);
    async function upload(bytes, sequence) {
      const form = new FormData(); form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'room.wav');
      form.append('trackId', 'room'); form.append('label', 'Room'); form.append('sequence', String(sequence));
      return api(`/meetings/${meeting.id}/audio`, 'POST', form);
    }
    const initial = await upload(first, 0); assert.deepEqual(await upload(first, 0), initial);
    const track = await upload(second, 1); assert.equal(track.bytes, whole.length);
    const audioDir = join(directory, 'audio', meeting.id);
    const files = (await readdir(audioDir)).filter(file => file.endsWith('.chunk')).sort();
    assert.equal(files.length, 2);
    for (const name of files) { const disk = await readFile(join(audioDir, name)); assert.equal(disk.subarray(0, 8).toString(), 'ECHOENC1'); assert.notDeepEqual(disk, first); }
    for (const [start, end] of [[0, 120], [65530, 65550], [139990, 140020], [whole.length - 12, whole.length - 1]]) {
      const response = await fetch(`${server.base}${track.url}`, { headers: { Range: `bytes=${start}-${end}` } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${whole.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), whole.subarray(start, end + 1));
    }
    for (const name of ['workspace.sqlite', 'workspace.sqlite-wal']) {
      let contents; try { contents = await readFile(join(directory, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      assert.ok(!contents.includes(Buffer.from(title))); assert.notEqual(contents.subarray(0, 16).toString(), 'SQLite format 3\0');
    }
    await stop(server); server = undefined;
    const database = await readFile(join(directory, 'workspace.sqlite'));
    await launch(directory, randomBytes(32).toString('base64'), true);
    assert.ok((await readFile(join(directory, 'workspace.sqlite'))).equals(database), 'wrong-key attempt changed the database');
    server = await launch(directory, key);
    assert.equal((await api(`/meetings/${meeting.id}`)).title, title);
    const ciphertextPath = join(audioDir, files[0]);
    const original = await readFile(ciphertextPath), damaged = Buffer.from(original); damaged[80] ^= 1;
    await writeFile(ciphertextPath, damaged);
    await assert.rejects(async () => { const response = await fetch(`${server.base}${track.url}`, { headers: { Range: 'bytes=0-100' }, signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); });
    assert.deepEqual(await readFile(ciphertextPath), damaged);
    await writeFile(ciphertextPath, original);
    const playback = await fetch(`${server.base}${track.url}`); assert.deepEqual(Buffer.from(await playback.arrayBuffer()), whole);
    assert.ok(!server.logs().includes(key)); assert.ok(!server.logs().includes(title));
  } finally { await stop(server); await rm(directory, { recursive: true, force: true }); await rmdir(scratch).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }); }
});
