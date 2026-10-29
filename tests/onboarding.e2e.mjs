// Build current WASM/assets first. Synthetic capabilities only; external traffic is blocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const project = process.cwd();
await mkdir(path.join(project, 'tmp'), { recursive: true });
const scratch = await mkdtemp(path.join(project, 'tmp', 'onboarding-'));
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
const base = `http://127.0.0.1:${port}`;
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
  if (exited) throw new Error(`Isolated onboarding server exited: ${startupError?.message || log}`);
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
  throw new Error(`Isolated onboarding server did not start: ${log}`);
}
let library = [];
const unexpected = [],
  runtimeErrors = [];
try {
  await ready();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const reply = (value) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== base) {
      unexpected.push(url.origin);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/meetings') return reply({ meetings: library });
    if (url.pathname === '/api/notes') return reply({ available: false, models: [] });
    if (url.pathname === '/api/chatgpt') return reply({ installed: false, connected: false });
    if (url.pathname === '/api/integrations/status')
      return reply({ google: { connected: false, configured: false } });
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto(base);
  const guide = page.getByRole('region', { name: 'First transcript setup' });
  await expect(guide).toBeVisible();
  await page.evaluate(() => {
    window.__onboarding = {
      installed: [],
      microphone: 'prompt',
      modelError: false,
      downloads: 0,
      captures: 0,
    };
    navigator.permissions.query = async () => ({ state: window.__onboarding.microphone });
    navigator.mediaDevices.getUserMedia = async () => {
      window.__onboarding.captures++;
      throw new Error('Permission was requested without Start');
    };
    window.echoInference.getDownloadedModels = async () => {
      if (window.__onboarding.modelError) throw new Error('Synthetic cache failure');
      return window.__onboarding.installed;
    };
    window.echoInference.downloadModel = () => {
      window.__onboarding.downloads++;
      throw new Error('Unexpected automatic download');
    };
  });
  async function recheck() {
    await expect(guide.getByRole('button', { name: 'Check again' })).toBeEnabled();
    await guide.getByRole('button', { name: 'Check again' }).click();
    await expect(guide.getByRole('button', { name: 'Check again' })).toBeEnabled();
  }
  await recheck();
  await expect(guide.getByText('Ready to record', { exact: true })).toBeVisible();
  await expect(guide.getByText('Speech model needed', { exact: true })).toBeVisible();
  await expect(guide.getByText(/~1.2 GB download and model storage/)).toBeVisible();
  await expect(guide.getByText(/Notes and Calendar are optional/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Record in person/ })).toBeEnabled();
  await page.getByRole('button', { name: /Record in person/ }).click();
  await expect(page.getByRole('dialog', { name: 'New meeting' })).toBeVisible();
  await page.getByRole('button', { name: 'Close new meeting' }).click();

  // A downloaded different model must not silently replace the selected model.
  await page.evaluate(() => {
    window.__onboarding.installed = ['onnx-community/whisper-large-v3'];
  });
  await recheck();
  await expect(guide.getByText('Speech model needed', { exact: true })).toBeVisible();
  for (const [status, message] of [
    ['cancelled', /download was cancelled/],
    ['failed', /download failed/],
  ]) {
    await page.evaluate(
      (status) =>
        window.dispatchEvent(
          new CustomEvent('echo-model-download-state', {
            detail: {
              status,
              modelId: 'onnx-community/whisper-large-v3-turbo',
              error: 'Synthetic interruption',
            },
          }),
        ),
      status,
    );
    await expect(guide.getByText(message)).toBeVisible();
    await expect(page.getByRole('button', { name: /Record in person/ })).toBeEnabled();
  }
  await guide.getByRole('button', { name: 'Retry in Models' }).click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download model', exact: true }).first(),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('echo-model-download-state', {
        detail: {
          status: 'downloading',
          modelId: 'onnx-community/whisper-large-v3-turbo',
          progress: 35,
        },
      }),
    ),
  );
  await expect(
    guide.getByRole('progressbar', { name: 'Speech model download progress' }),
  ).toHaveAttribute('value', '35');
  await expect(guide.getByRole('button', { name: 'View download' })).toBeVisible();

  await page.evaluate(() => {
    window.__onboarding.installed = ['onnx-community/whisper-large-v3-turbo'];
    window.dispatchEvent(
      new CustomEvent('echo-model-download-state', {
        detail: { status: 'completed', modelId: 'onnx-community/whisper-large-v3-turbo' },
      }),
    );
  });
  await expect(guide.getByText('Ready to transcribe', { exact: true })).toBeVisible();
  await expect(guide.getByText(/Record or upload audio, then open/)).toBeVisible();
  await page.evaluate(() => {
    window.__onboarding.modelError = true;
  });
  await recheck();
  await expect(guide.getByText('Model check unavailable', { exact: true })).toBeVisible();
  await expect(guide.getByText('Ready to transcribe', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.__onboarding.modelError = false;
    window.__onboarding.microphone = 'denied';
  });
  await recheck();
  await expect(guide.getByText('Microphone setup needed', { exact: true })).toBeVisible();
  await expect(guide.getByText(/You can still upload audio/)).toBeVisible();
  await expect(page.getByLabel('Upload a recording')).toBeEnabled();

  library = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Synthetic first recording',
      mode: 'in-person',
      status: 'saved',
      speechModel: 'onnx-community/whisper-large-v3-turbo',
      duration: 1,
      createdAt: '2026-10-09T00:00:00Z',
      tracks: [{ id: 'track', bytes: 32044, duration: 1, url: '/api/meetings/fixture/audio.wav' }],
      transcripts: [],
      notes: [],
      moments: [],
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('echo-library-changed')));
  await expect(guide.getByText(/Open “Synthetic first recording”/)).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => window.echoTheme.set(theme), theme);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${theme} onboarding fits ${width}px`,
      );
      const gap = await page.evaluate(
        () =>
          document.querySelector('#first-transcript').getBoundingClientRect().top -
          document.querySelector('.quick-actions').getBoundingClientRect().bottom,
      );
      assert.ok(
        gap >= 24,
        `${theme} onboarding has a 24px gap after quick actions at ${width}px (got ${gap})`,
      );
      await expect(guide.getByRole('button', { name: 'Open recording' })).toBeVisible();
    }
  }
  await guide.getByRole('button', { name: 'Open recording' }).click();
  await expect(
    page.getByRole('heading', { name: 'Synthetic first recording', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create transcript', exact: true }).first(),
  ).toBeEnabled();
  library[0].transcripts = [
    { id: 'final', passages: [{ text: 'Synthetic final transcript.', start: 0, end: 1 }] },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event('echo-library-changed')));
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(guide).toHaveCount(0);
  assert.deepEqual(
    await page.evaluate(() => ({
      downloads: window.__onboarding.downloads,
      captures: window.__onboarding.captures,
    })),
    { downloads: 0, captures: 0 },
  );
  assert.deepEqual(
    unexpected,
    [],
    'No external requests, account probes, settings changes, or processing starts.',
  );
  assert.deepEqual(runtimeErrors, []);
  console.log(
    'PASS: first-use recording/model readiness, optional services, interrupted/failed/check-failed states, current selected model, model progress/retry navigation, saved recording next action, completed guide removal, and light/dark 320px layouts.',
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
  else console.error(`Isolated onboarding server did not exit; preserved ${scratch}.`);
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
}
