import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { stopTestServer, removeTestDirectory } from '../tests/helpers/server-cleanup.mjs';
import { resolveChromium } from './browser-path.mjs';

const browserPath = await resolveChromium();

const scratch = path.resolve('tmp');
await mkdir(scratch, { recursive: true });
const runRoot = await mkdtemp(path.join(scratch, 'echo-browser-suite-'));
const data = path.join(runRoot, 'data');
await mkdir(data);
const artifacts = path.join(runRoot, 'artifacts');
let passed = false;
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://localhost:${port}`;
const server = spawn(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server', [], {
  env: {
    ...process.env,
    ECHO_TEST_MODE: '1',
    ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
    ECHO_TEST_CHATGPT_RUNTIME: 'fixture',
    ECHO_CODEX_BIN: path.resolve('tests/fixtures/codex-helper.mjs'),
    TMPDIR: scratch,
    ECHO_DATA_DIR: data,
    ECHO_BIND: `127.0.0.1:${port}`,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
  stdio: 'inherit',
});
let serverError,
  serverExited = false;
server.once('error', (error) => {
  serverError = error;
  serverExited = true;
});
server.once('exit', () => {
  serverExited = true;
});
function requireServer() {
  if (serverError)
    throw new Error(`The isolated browser-test server could not start: ${serverError.message}`);
  if (serverExited)
    throw new Error(
      `The isolated browser-test server exited (${server.exitCode ?? server.signalCode}). Refusing to use another workspace.`,
    );
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
        throw new Error(
          'The test port belongs to a different data folder. Refusing to run browser tests against it.',
        );
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
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        TMPDIR: scratch,
        CHROMIUM_PATH: browserPath,
        ECHO_E2E_URL: base,
        ECHO_TEST_URL: base,
        ECHO_WORKSPACE_TEST_ARTIFACTS: path.join(artifacts, 'workspace'),
        ECHO_AUDIT_SCREENSHOTS: path.join(artifacts, 'accessibility'),
        ECHO_E2E_SCREENSHOTS: path.join(artifacts, 'settings'),
        ECHO_TEST_ARTIFACTS: path.join(artifacts, 'review'),
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} failed (${code})`)),
    );
  });
  requireServer();
}
async function shutdown() {
  try {
    await stopTestServer(server);
    await removeTestDirectory(data);
    if (passed) await removeTestDirectory(runRoot);
    else console.error(`Browser test failure evidence was preserved at ${artifacts}.`);
  } catch (error) {
    console.error(`Browser test data was preserved at ${data}.`);
    throw error;
  }
}

try {
  await ready();
  for (const script of [
    'tests/recorder-browser.mjs',
    'tests/import-browser.mjs',
    'tests/workspace.e2e.mjs',
    'tests/accessibility.e2e.mjs',
    'tests/settings.e2e.mjs',
    'tests/review.e2e.mjs',
    'tests/calendar-connection.e2e.mjs',
    'tests/extension-connect.e2e.mjs',
    'tests/onboarding.e2e.mjs',
  ])
    await run(script);
  passed = true;
} finally {
  await shutdown();
}
