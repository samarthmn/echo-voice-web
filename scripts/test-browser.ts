import { record } from '../web/guards.ts';
import { serverPort } from './guards.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { stopTestServer, removeTestDirectory } from '../tests/helpers/server-cleanup.ts';
import { resolveChromium } from './browser-path.ts';

const browserPath = await resolveChromium();

const scratch = path.resolve('tmp');
await mkdir(scratch, { recursive: true });
const runRoot = await mkdtemp(path.join(scratch, 'echo-browser-suite-'));
const data = path.join(runRoot, 'data');
await mkdir(data);
const artifacts = path.join(runRoot, 'artifacts');
let passed = false;
const socket = createServer();
await new Promise<void>((resolve, reject: (reason?: unknown) => void) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', resolve);
});
const port = serverPort(socket);
await new Promise((resolve) => socket.close(resolve));
const base = `http://localhost:${port}`;
const server = spawn(process.env['ECHO_TEST_BINARY'] || 'target/debug/echo-server', [], {
  env: {
    ...process.env,
    ECHO_TEST_MODE: '1',
    ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
    TMPDIR: scratch,
    ECHO_DATA_DIR: data,
    ECHO_BIND: `127.0.0.1:${port}`,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
  stdio: 'inherit',
});
let serverError: Error | undefined,
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
        if (response.ok) storage = record(record((await response.json()) as unknown) as unknown);
      }
    } catch {}
    requireServer();
    if (storage) {
      if (
        typeof storage['path'] !== 'string' ||
        path.resolve(storage['path']) !== path.resolve(data)
      ) {
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
async function run(script: string) {
  requireServer();
  await new Promise<void>((resolve, reject: (reason?: unknown) => void) => {
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
    'tests/e2e/recorder-browser.e2e.ts',
    'tests/e2e/import-browser.e2e.ts',
    'tests/e2e/workspace.e2e.ts',
    'tests/e2e/accessibility.e2e.ts',
    'tests/e2e/settings.e2e.ts',
    'tests/e2e/review.e2e.ts',
    'tests/e2e/calendar-connection.e2e.ts',
    'tests/e2e/extension-connect.e2e.ts',
    'tests/e2e/onboarding.e2e.ts',
  ])
    await run(script);
  passed = true;
} finally {
  await shutdown();
}
