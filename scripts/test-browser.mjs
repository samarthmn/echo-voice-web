import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const data = await mkdtemp(path.join(tmpdir(), 'echo-browser-suite-'));
const socket = createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server', [], {
  env: { ...process.env, ECHO_DATA_DIR: data, ECHO_BIND: `127.0.0.1:${port}`, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
  stdio: 'inherit',
});
let serverError, serverExited = false;
const exit = new Promise(resolve => {
  server.once('error', error => { serverError = error; serverExited = true; resolve(); });
  server.once('exit', () => { serverExited = true; resolve(); });
});
function requireServer() {
  if (serverError) throw new Error(`The isolated browser-test server could not start: ${serverError.message}`);
  if (serverExited) throw new Error(`The isolated browser-test server exited (${server.exitCode ?? server.signalCode}). Refusing to use another workspace.`);
}
async function ready() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    requireServer();
    let storage;
    try {
      const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) {
        const response = await fetch(`${base}/api/storage`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) storage = await response.json();
      }
    } catch {}
    requireServer();
    if (storage) {
      if (typeof storage.path !== 'string' || path.resolve(storage.path) !== path.resolve(data)) {
        throw new Error('The test port belongs to a different data folder. Refusing to run browser tests against it.');
      }
      return;
    }
    await delay(100);
  }
  throw new Error('The isolated browser-test server did not become ready within 15 seconds.');
}
async function run(script) {
  requireServer();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ECHO_E2E_URL: base, ECHO_TEST_URL: base }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed (${code})`)));
  });
  requireServer();
}
async function shutdown() {
  if (!serverExited) server.kill('SIGINT');
  await Promise.race([exit, delay(2000, undefined, { ref: false })]);
  if (!serverExited) {
    server.kill('SIGKILL');
    await Promise.race([exit, delay(1000, undefined, { ref: false })]);
  }
  if (serverExited) await rm(data, { recursive: true, force: true });
  else console.error(`Test server did not exit; its isolated data was preserved at ${data}.`);
}

try {
  await ready();
  for (const script of [
    'scripts/smoke-speakers.mjs',
    'tests/recorder-browser.mjs',
    'tests/import-browser.mjs',
    'tests/workspace.e2e.mjs',
    'tests/accessibility.e2e.mjs',
    'tests/settings.e2e.mjs',
    'tests/review.e2e.mjs',
    'tests/review-chatgpt.e2e.mjs',
    'tests/chatgpt-connection.e2e.mjs',
  ]) await run(script);
} finally { await shutdown(); }
