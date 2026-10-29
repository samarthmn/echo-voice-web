import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target/debug/echo-server');
const key = Buffer.alloc(32, 42).toString('base64');
async function listener() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', resolve).once('error', reject),
  );
  return server;
}
function start(dir, port, extra = {}) {
  const child = spawn(binary, [], {
    cwd: '/',
    env: {
      ...process.env,
      TMPDIR: path.join(root, 'tmp'),
      ECHO_TEST_MODE: '1',
      ECHO_TEST_STORAGE_KEY: key,
      ECHO_DATA_DIR: dir,
      ECHO_BIND: `127.0.0.1:${port}`,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, exit };
}
test('server lifecycle and startup errors', async () => {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp/server-lifecycle-'));
  let child;
  try {
    const socket = await listener();
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const running = start(path.join(dir, 'library'), port);
    child = running.child;
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(response, 'server started');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/i);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/meetings`)).status, 200);
    const shutdownStarted = performance.now();
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      running.exit,
      delay(15000, undefined, { ref: false }).then(() => {
        throw new Error('shutdown exceeded 15 seconds');
      }),
    ]);
    assert.ok(performance.now() - shutdownStarted < 15000, 'shutdown finished within 15 seconds');
    assert.equal(stopped.code, 0, stopped.output);
    child = undefined;
    const config = path.join(dir, 'broken.json');
    await writeFile(config, '{');
    const invalid = await start(path.join(dir, 'invalid'), port, { ECHO_CONFIG_FILE: config }).exit;
    assert.notEqual(invalid.code, 0);
    assert.ok(invalid.output.includes(config), invalid.output);
    const occupied = await listener();
    try {
      const busyPort = occupied.address().port;
      const busy = await start(path.join(dir, 'busy'), busyPort).exit;
      assert.notEqual(busy.code, 0);
      assert.ok(busy.output.includes(`Port ${busyPort} is already in use`), busy.output);
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
