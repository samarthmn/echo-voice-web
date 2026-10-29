import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

test('release server rejects fixture key injection before opening a library', async () => {
  const project = process.cwd();
  await mkdir(path.join(project, 'tmp'), { recursive: true });
  const scratch = await mkdtemp(path.join(project, 'tmp/release-key-policy-'));
  try {
    const child = spawn(
      path.resolve(process.env.ECHO_RELEASE_BINARY || 'target/release/echo-server'),
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
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(output, /cannot unlock this library/);
    const files = await readdir(path.join(scratch, 'library')).catch((error) => {
      if (error.code === 'ENOENT') return [];
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
