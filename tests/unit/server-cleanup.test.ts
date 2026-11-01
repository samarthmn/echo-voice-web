import { array } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { stopTestServer, assertNoMountedDirectory } from '../helpers/server-cleanup.ts';

async function processFixture(t: test.TestContext, handler: string) {
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGINT', ${handler}); setInterval(() => {}, 1000); console.log('ready');`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  return child;
}

void test('graceful cleanup waits beyond the former two-second kill deadline', async (t) => {
  const child = await processFixture(t, '() => setTimeout(() => process.exit(0), 2200)');
  await stopTestServer(child, { graceMs: 5000 });
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

void test('forced termination is reaped and reports preservation instead of allowing removal', async (t) => {
  const child = await processFixture(t, '() => {}');
  await assert.rejects(stopTestServer(child, { graceMs: 20 }), /forced termination.*preserved/);
  assert.equal(child.signalCode, 'SIGKILL');
});

void test('cleanup refuses to traverse a mounted filesystem', async () => {
  const root = path.resolve('tmp/synthetic-cleanup-guard');
  const mounted = path.join(root, 'mounted-volume');
  const visited: unknown = [];
  await assert.rejects(
    assertNoMountedDirectory(root, {
      inspect: async (location) => ({
        dev: location === mounted ? 2 : 1,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      entries: async (location) => {
        array(visited).push(location);
        return location === root ? ['mounted-volume'] : [];
      },
    }),
    /mounted filesystem.*preserved/,
  );
  assert.deepEqual(visited, [root], 'Never enumerate or remove the mounted contents.');
});
