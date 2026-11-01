import type * as TestModule from '@playwright/test';
import { bufferChunk } from '../helpers/assertions.ts';
import { meetingRecord } from '../helpers/assertions.ts';
import { browserGuards } from '../helpers/browser-guards.ts';
import { object } from '../helpers/assertions.ts';
import { numeric } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
/**
 * Real Chromium microphone/MediaRecorder integration against the Rust server.
 * Prerequisites: cargo build -p echo-server && pnpm build:assets
 * Run: node tests/e2e/recorder-browser.e2e.ts
 * Optional: CHROMIUM_PATH=/path/to/chromium ECHO_TEST_PORT=3012
 * Release build: ECHO_TEST_BINARY=target/release/echo-server
 * Each run uses its own temporary data directory and stops its server on exit.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { Meeting } from '../../web/types/domain';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = resolve(project, process.env['ECHO_TEST_BINARY'] || 'target/debug/echo-server');
await access(binary);
await access(resolve(project, 'public/js/bridge.js'));
const port = Number(process.env['ECHO_TEST_PORT'] || 3012);
const origin = `http://localhost:${port}`;
await mkdir(resolve(project, 'tmp'), { recursive: true });
const dataDirectory = await mkdtemp(resolve(project, 'tmp', 'echo-recorder-e2e-'));
const server = spawn(binary, [], {
  cwd: project,
  env: {
    ...process.env,
    ECHO_TEST_MODE: '1',
    ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
    ECHO_BIND: `127.0.0.1:${port}`,
    ECHO_DATA_DIR: dataDirectory,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const getExitCode = () => server.exitCode;
let serverOutput = '';
server.stdout.on('data', (streamValue: unknown) => {
  const chunk = bufferChunk(streamValue);
  serverOutput += String(chunk);
});
server.stderr.on('data', (streamValue: unknown) => {
  const chunk = bufferChunk(streamValue);
  serverOutput += String(chunk);
});
let browser: TestModule.Browser | undefined;
let passed = false;
const delay = (ms: number | undefined) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (getExitCode() !== null)
      throw new Error(
        'The isolated test server could not bind. Refusing to use any existing workspace.',
      );
    if (getExitCode() !== null) throw new Error(`Test server exited: ${serverOutput}`);
    try {
      if ((await fetch(`${origin}/api/settings`)).ok) return;
    } catch {
      /* The isolated server may still be starting; retry until the readiness deadline. */
    }
    await delay(100);
  }
  throw new Error(`Test server did not start: ${serverOutput}`);
}

try {
  await ready();
  const settings = await fetch(`${origin}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoTranscribe: false, onboardingComplete: true }),
  });
  assert.equal(settings.status, 200, await settings.text());
  browser = await chromium.launch({
    executablePath: process.env['CHROMIUM_PATH'] || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript({ content: browserGuards });
  await page.addInitScript(() => {
    window.__captureTest = {
      micCalls: 0,
      streams: [],
      uploads: [],
      states: [],
      saved: [],
      contexts: [],
    };
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__captureTest.micCalls++;
      const stream = await originalGetUserMedia(constraints);
      window.__captureTest.streams.push(stream);
      return stream;
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
          '/audio',
        ) &&
        init?.body instanceof FormData
      ) {
        window.__captureTest.uploads.push({
          url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
          sequence: init.body.get('sequence'),
          bytes: (() => {
            const file = init.body.get('file');
            if (!(file instanceof File)) throw new Error('Expected upload file');
            return file.size;
          })(),
        });
      }
      return originalFetch(url, init);
    };
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args: ConstructorParameters<typeof AudioContext>) {
        const audioContext: AudioContext = Reflect.construct(target, args);
        window.__captureTest.contexts.push(audioContext);
        return audioContext;
      },
    });
    window.addEventListener('echo-recorder-state', (event) =>
      window.__captureTest.states.push(event.detail),
    );
    window.addEventListener('echo-recording-saved', (event) =>
      window.__captureTest.saved.push(event.detail),
    );
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => typeof (window as Partial<Window>).echoRecorder?.start === 'function',
  );
  await delay(500);
  assert.equal(await page.evaluate(() => window.__captureTest.micCalls), 0);
  console.log('PASS: loading the real application does not request microphone access');

  async function createMeeting(title: string) {
    return page.evaluate(async (title) => {
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }

      function object(v: unknown): Record<string, unknown> {
        if (v === null || typeof v !== 'object') throw new Error('Expected object');
        return v as Record<string, unknown>;
      }

      const response = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, mode: 'in-person', consent: true }),
      });
      const meeting = object((await response.json()) as unknown);
      if (!response.ok) throw new Error(text(meeting['error']));
      return testMeeting(meeting);
    }, title);
  }

  async function assertReleased() {
    const released = await page.evaluate(() => ({
      tracks: window.__captureTest.streams.flatMap((stream) =>
        stream.getTracks().map((track) => track.readyState),
      ),
      contexts: window.__captureTest.contexts.map((context) => context.state),
    }));
    assert.ok(released.tracks.length > 0);
    assert.ok(
      released.tracks.every((state: string) => state === 'ended'),
      JSON.stringify(released),
    );
    assert.ok(
      released.contexts.every((state: string) => state === 'closed'),
      JSON.stringify(released),
    );
  }

  async function decodeSaved(meeting: Meeting) {
    return page.evaluate(async (meeting) => {
      function defined<T>(value: T): NonNullable<T> {
        if (value === undefined || value === null)
          throw new Error('Expected fixture value to be present.');
        return value;
      }

      const response = await fetch(defined(defined(meeting.tracks[0]).url));
      if (!response.ok) throw new Error(`Audio playback returned ${response.status}`);
      const encoded = await response.arrayBuffer();
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(encoded);
        const samples = decoded.getChannelData(0);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value));
        return {
          bytes: encoded.byteLength,
          duration: decoded.duration,
          channels: decoded.numberOfChannels,
          peak,
        };
      } finally {
        await context.close();
      }
    }, meeting);
  }

  const meeting = await createMeeting('Browser capture integration');
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), meeting);
  const started = Date.now();
  await page.waitForFunction(
    (id) => {
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }
      return window.__captureTest.uploads.some((item: { url: string | unknown[] }) =>
        item.url.includes(text(id)),
      );
    },
    meeting.id,
    { timeout: 10000 },
  );
  const recording = object(
    (await (await fetch(`${origin}/api/meetings/${meeting.id}`)).json()) as unknown,
  );
  assert.equal(recording['status'], 'recording');
  await page.waitForFunction(async (id) => {
    function object(v: unknown): Record<string, unknown> {
      if (v === null || typeof v !== 'object') throw new Error('Expected object');
      return v as Record<string, unknown>;
    }

    const saved = object((await (await fetch(`/api/meetings/${id}`)).json()) as unknown);
    return (testMeeting(saved).tracks[0]?.bytes ?? 0) > 0;
  }, meeting.id);
  console.log(
    'PASS: explicit microphone start persists a real periodic audio chunk to the Rust server',
  );

  await page.evaluate(() => {
    window.echoRecorder.toggleMute();
  });
  assert.equal(
    await page.evaluate(() => {
      function defined<T>(v: T): NonNullable<T> {
        if (v === undefined || v === null) throw new Error('Expected fixture value to be present.');
        return v;
      }
      return defined(defined(window.__captureTest.streams.at(-1)).getAudioTracks()[0]).enabled;
    }),
    false,
  );
  await delay(600);
  await page.evaluate(() => {
    window.echoRecorder.pause();
  });
  const pausedElapsed = await page.evaluate(() => window.echoRecorder.state.elapsed);
  const pausedAt = Date.now();
  await delay(1200);
  assert.equal(await page.evaluate(() => window.echoRecorder.state.elapsed), pausedElapsed);
  await page.evaluate(() => {
    window.echoRecorder.resume();
  });
  const pausedMs = Date.now() - pausedAt;
  await delay(400);
  await page.evaluate(() => {
    window.echoRecorder.toggleMute();
  });
  await delay(350);
  const wallSeconds = (Date.now() - started) / 1000;
  const saved = await page.evaluate(() => window.echoRecorder.stop());
  assert.equal(saved.status, 'saved');
  assert.equal(saved.tracks.length, 1);
  assert.equal(defined(saved.gaps).length, 1);
  assert.equal(defined(defined(saved.gaps)[0]).reason, 'Microphone muted');
  assert.ok(defined(defined(saved.gaps)[0]).end - defined(defined(saved.gaps)[0]).start >= 0.9);
  assert.ok(defined(defined(saved.gaps)[0]).end - defined(defined(saved.gaps)[0]).start < 1.7);
  assert.ok(
    Math.abs(defined(saved.duration) - (wallSeconds - pausedMs / 1000)) < 0.7,
    `timeline duration=${saved.duration}, wall=${wallSeconds}, paused=${pausedMs}`,
  );
  const uploads = await page.evaluate((id) => {
    function text(v: unknown): string {
      if (typeof v !== 'string') throw new Error('Expected text');
      return v;
    }
    return window.__captureTest.uploads.filter((item: { url: string | unknown[] }) =>
      item.url.includes(text(id)),
    );
  }, meeting.id);
  assert.ok(uploads.length >= 2, 'Expected periodic and final chunks');
  assert.deepEqual(
    uploads.map((item: { sequence: unknown }) => Number(item.sequence)),
    uploads.map((_: unknown, index: unknown) => index),
  );
  assert.equal(
    defined(saved.tracks[0]).bytes,
    uploads.reduce(
      (sum: unknown, upload: { bytes: unknown }) => numeric(sum) + numeric(upload.bytes),
      0,
    ),
  );
  const audio = await decodeSaved(saved);
  assert.ok(audio.duration > 5 && audio.channels > 0 && audio.peak > 0);
  assert.ok(
    Math.abs(audio.duration - defined(saved.duration)) < 0.7,
    `decoded=${audio.duration}, metadata=${saved.duration}`,
  );
  await assertReleased();
  console.log(
    `PASS: pause/mute/resume, final chunk, browser audio decode (${audio.duration.toFixed(2)}s), and resource release`,
  );

  const interrupted = await createMeeting('Source disconnection integration');
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), interrupted);
  await delay(700);
  await page.evaluate(() => {
    function defined<T>(v: T): NonNullable<T> {
      if (v === undefined || v === null) throw new Error('Expected fixture value to be present.');
      return v;
    }
    return defined(defined(window.__captureTest.streams.at(-1)).getAudioTracks()[0]).dispatchEvent(
      new Event('ended'),
    );
  });
  await page.waitForFunction(
    (id) => window.__captureTest.saved.some((meeting: { id: unknown }) => meeting.id === id),
    interrupted.id,
  );
  const interruptedSaved = meetingRecord(
    (await (await fetch(`${origin}/api/meetings/${interrupted.id}`)).json()) as unknown,
  );
  assert.equal(interruptedSaved.status, 'interrupted');
  assert.ok((await decodeSaved(interruptedSaved)).duration > 0);
  await assertReleased();
  console.log(
    'PASS: a simulated source-ended event flushes real captured audio and marks the meeting interrupted',
  );

  let rejectUploads = true;
  await page.route('**/api/meetings/*/audio', async (route) => {
    if (route.request().method() === 'POST' && rejectUploads) await route.abort('connectionfailed');
    else await route.continue();
  });
  const retryMeeting = await createMeeting('Upload retry integration');
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), retryMeeting);
  await page.waitForFunction(() => window.echoRecorder.state.status === 'error', null, {
    timeout: 15000,
  });
  assert.match(
    defined(await page.evaluate(() => window.echoRecorder.state.error)),
    /retained in this tab/,
  );
  assert.equal(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
  );
  rejectUploads = false;
  const recovered = await page.evaluate(() => window.echoRecorder.retry());
  assert.equal(recovered.status, 'interrupted');
  const retriedUploads = await page.evaluate((id) => {
    function text(v: unknown): string {
      if (typeof v !== 'string') throw new Error('Expected text');
      return v;
    }
    return window.__captureTest.uploads.filter((item: { url: string | unknown[] }) =>
      item.url.includes(text(id)),
    );
  }, retryMeeting.id);
  assert.deepEqual(
    retriedUploads.map((item: { sequence: unknown }) => item.sequence),
    ['0', '0', '0', '0', '1'],
  );
  assert.equal(
    defined(recovered.tracks[0]).bytes,
    defined(retriedUploads[3]).bytes + defined(retriedUploads[4]).bytes,
  );
  assert.ok((await decodeSaved(recovered)).duration > 5);
  await assertReleased();
  assert.equal(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    false,
  );
  console.log(
    'PASS: network failure stops capture, retains chunks, protects unload, and retries without duplicated audio',
  );
  passed = true;
  console.log('Recorder browser integration: 5 checks passed.');
} finally {
  await browser?.close();
  if (getExitCode() === null) {
    server.kill('SIGINT');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
    if (getExitCode() === null) server.kill('SIGKILL');
  }
  if (passed) await rm(dataDirectory, { recursive: true, force: true });
  else console.error(`Recorder test data retained at ${dataDirectory}\n${serverOutput}`);
}
