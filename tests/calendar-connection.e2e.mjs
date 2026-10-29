// Build current WASM/assets first. Every Google endpoint is mocked; external traffic is blocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const project = process.cwd();
await mkdir(path.join(project, 'tmp'), { recursive: true });
const scratch = await mkdtemp(path.join(project, 'tmp', 'calendar-connection-'));
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = scratch;
const data = path.join(scratch, 'data');
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://localhost:${port}`;
const child = spawn(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server', [], {
  cwd: project,
  env: {
    ...process.env,
    ECHO_TEST_MODE: '1',
    ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
    ECHO_DATA_DIR: data,
    ECHO_BIND: `127.0.0.1:${port}`,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let exited = false,
  startupError,
  log = '',
  browser;
const exit = new Promise((resolve) => {
  child.once('error', (error) => {
    startupError = error;
    exited = true;
    resolve();
  });
  child.once('exit', () => {
    exited = true;
    resolve();
  });
});
for (const output of [child.stdout, child.stderr])
  output.on('data', (value) => {
    log = (log + value).slice(-8000);
  });
function requireServer() {
  if (exited) throw new Error(`Isolated Calendar server exited: ${startupError?.message || log}`);
}
async function ready() {
  for (let i = 0; i < 150; i++) {
    requireServer();
    let storage;
    try {
      const response = await fetch(`${base}/api/storage`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) storage = await response.json();
    } catch {}
    requireServer();
    if (storage) {
      assert.equal(path.resolve(storage.path), data, 'Only use the owned synthetic library.');
      return;
    }
    await delay(100);
  }
  throw new Error(`Isolated Calendar server did not start: ${log}`);
}
const disconnected = () => ({
  mode: 'source',
  configured: true,
  connected: false,
  pending: false,
  reconnectRequired: false,
});
const connected = () => ({
  ...disconnected(),
  connected: true,
  email: 'calendar-fixture@example.test',
});
let state = { ...disconnected(), configured: false };
let nextFailure;
const calls = [],
  unexpected = [],
  runtimeErrors = [];
try {
  await ready();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const reply = (value, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== base) {
      unexpected.push(key);
      return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/integrations/')) {
      calls.push(key);
      if (nextFailure === key) {
        nextFailure = undefined;
        if (key === 'GET /api/integrations/calendar')
          state = { ...disconnected(), reconnectRequired: true };
        return reply({ error: 'Synthetic connection failure. Try again.' }, 503);
      }
      if (key === 'GET /api/integrations/status') return reply({ google: state });
      if (key === 'GET /api/integrations/calendar')
        return reply({
          events: [
            {
              title: 'Synthetic upcoming meeting',
              start: '2026-10-09T12:00:00Z',
              provider: 'google-meet',
              url: '',
            },
          ],
        });
      if (key === 'POST /api/integrations/google/cancel') {
        assert.deepEqual(request.postDataJSON(), {});
        state = { ...state, pending: false };
        return reply({ ok: true });
      }
      if (key === 'POST /api/integrations/google/disconnect') {
        assert.deepEqual(request.postDataJSON(), {});
        state = disconnected();
        return reply({ ok: true });
      }
      if (key === 'GET /api/integrations/google/connect')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Mock Google sign-in</title><h1>Mock Google sign-in</h1>',
        });
      unexpected.push(key);
      return route.abort('blockedbyclient');
    }
    if (key === 'GET /api/settings')
      return reply({ onboardingComplete: true, notesProvider: 'ollama' });
    if (!['GET', 'HEAD'].includes(request.method())) {
      unexpected.push(key);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const calendar = page.locator('.calendar-page');
  const refresh = calendar.getByRole('button', { name: 'Refresh', exact: true });
  const cancel = calendar.getByRole('button', { name: 'Cancel sign-in', exact: true });
  const connect = calendar.getByRole('button', { name: 'Connect calendar', exact: true });
  const reconnect = calendar.getByRole('button', { name: 'Reconnect calendar', exact: true });
  const disconnect = calendar.getByRole('button', { name: 'Disconnect calendar', exact: true });
  const openCalendar = async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await page.locator('.sidebar').getByRole('button', { name: 'Calendar', exact: true }).click();
    await expect(refresh).toBeEnabled();
  };
  const refreshState = async (next) => {
    state = next;
    const response = page.waitForResponse(`${base}/api/integrations/status`);
    await refresh.click();
    await response;
    await expect(refresh).toBeEnabled();
  };

  await openCalendar();
  await connect.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Ask the person who runs this Echo workspace');
  await expect(dialog.locator('code')).not.toBeVisible();
  await expect(dialog).not.toContainText('localhost:3000');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(connect).toBeFocused();

  await refreshState({ ...disconnected(), mode: 'source', configured: false });
  await connect.click();
  await dialog.getByText('Developer configuration', { exact: true }).click();
  await expect(dialog.locator('code')).toBeVisible();
  await expect(dialog).toContainText('GOOGLE_CLIENT_ID');
  await expect(dialog.getByRole('link', { name: 'Developer setup guide' })).toHaveAttribute(
    'href',
    /docs\/integrations\.md#configure-the-local-server$/,
  );
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  await refreshState({
    ...disconnected(),
    configured: false,
    configurationError: 'Calendar configuration is unavailable.',
  });
  await expect(calendar).toContainText('Calendar configuration is unavailable.');
  await refreshState({ ...disconnected(), reconnectRequired: true });
  await expect(reconnect).toBeEnabled();
  await expect(calendar).toContainText('Your recorded meetings are unchanged.');

  await refreshState({ ...disconnected(), pending: true });
  await expect(cancel).toBeEnabled();
  await expect(connect).toHaveCount(0);
  nextFailure = 'POST /api/integrations/google/cancel';
  await cancel.click();
  await expect(calendar.getByRole('alert')).toContainText('Synthetic connection failure');
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(connect).toBeEnabled();

  await refreshState({ ...connected(), pending: true });
  await expect(calendar).toContainText('Your current calendar stays connected');
  await expect(disconnect).toBeDisabled();
  await cancel.click();
  await expect(disconnect).toBeEnabled();
  await expect(calendar).toContainText('calendar-fixture@example.test');
  await expect(calendar.getByRole('heading', { name: 'Synthetic upcoming meeting' })).toBeVisible();

  nextFailure = 'GET /api/integrations/calendar';
  await refreshState(connected());
  await expect(reconnect).toBeEnabled();
  await expect(calendar.getByRole('heading', { name: 'Synthetic upcoming meeting' })).toHaveCount(
    0,
  );
  await expect(disconnect).toHaveCount(0);

  nextFailure = 'GET /api/integrations/status';
  await refreshState(disconnected());
  await expect(connect).toBeDisabled();
  await expect(
    calendar.getByRole('heading', { name: 'Calendar status unavailable' }),
  ).toBeVisible();

  state = { ...disconnected(), pending: true };
  await openCalendar();
  await expect(cancel).toBeEnabled();
  state = connected();
  await expect(disconnect).toBeEnabled({ timeout: 6000 });
  await disconnect.click();
  await expect(connect).toBeEnabled();

  await page.setViewportSize({ width: 320, height: 844 });
  await refreshState({ ...disconnected(), pending: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Pending controls fit a narrow screen.',
  );
  await cancel.click();
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(page.getByRole('heading', { name: 'Mock Google sign-in' })).toBeVisible();
  assert.equal(calls.filter((key) => key === 'GET /api/integrations/google/connect').length, 1);
  assert.deepEqual(unexpected, [], 'No real sign-in, external traffic, or unrelated writes.');
  assert.deepEqual(runtimeErrors, []);
  console.log(
    'PASS: Calendar web setup guidance, reconnect, pending polling, cancel/retry, connection preservation, stale-state recovery, narrow layout, and mocked sign-in navigation.',
  );
} finally {
  await browser?.close();
  if (!exited) child.kill('SIGINT');
  await Promise.race([exit, delay(2000, undefined, { ref: false })]);
  if (!exited) {
    child.kill('SIGKILL');
    await Promise.race([exit, delay(1000, undefined, { ref: false })]);
  }
  if (exited) await rm(scratch, { recursive: true, force: true });
  else console.error(`Isolated Calendar server did not exit; preserved ${scratch}.`);
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
}
