import { bufferChunk } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

void test('release server rejects fixture key injection before opening a library', async () => {
  const project = process.cwd();
  await mkdir(path.join(project, 'tmp'), { recursive: true });
  const scratch = await mkdtemp(path.join(project, 'tmp/release-key-policy-'));
  try {
    const child = spawn(
      path.resolve(process.env['ECHO_RELEASE_BINARY'] || 'target/release/echo-server'),
      ['--check-library'],
      {
        cwd: project,
        env: {
          ...process.env,
          TMPDIR: scratch,
          ECHO_DATA_DIR: path.join(scratch, 'library'),
          ECHO_TEST_MODE: '1',
          ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 81).toString('base64'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (streamValue: unknown) => {
      const chunk = bufferChunk(streamValue);
      return (output += String(chunk));
    });
    child.stderr.on('data', (streamValue: unknown) => {
      const chunk = bufferChunk(streamValue);
      return (output += String(chunk));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    }).finally(() => {
      clearTimeout(timer);
    });
    assert.notEqual(object(result)['code'], 0);
    assert.equal(object(result)['signal'], null);
    assert.match(output, /cannot unlock this library/);
    const files = await readdir(path.join(scratch, 'library')).catch((error: unknown) => {
      if (object(error)['code'] === 'ENOENT') return [] as string[];
      throw error;
    });
    assert.ok(
      !files.includes('workspace.sqlite'),
      'fixture key must never open a production database',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
