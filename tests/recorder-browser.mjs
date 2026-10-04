import { createServer as createPortReservation } from 'node:net';
/**
 * Real Chromium microphone/MediaRecorder integration against the Rust server.
 * Prerequisites: cargo build -p echo-server && npm run build:assets
 * Run: node tests/recorder-browser.mjs
 * Optional: CHROMIUM_PATH=/path/to/chromium ECHO_TEST_PORT=3012
 * Release build: ECHO_TEST_BINARY=target/release/echo-server
 * Each run uses its own temporary data directory and stops its server on exit.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(project, process.env.ECHO_TEST_BINARY || 'target/debug/echo-server');
await access(binary);
await access(resolve(project, 'public/js/bridge.js'));
const port = Number(process.env.ECHO_TEST_PORT || 3012);
const origin = `http://127.0.0.1:${port}`;
const dataDirectory = await mkdtemp(resolve(tmpdir(), 'echo-recorder-e2e-'));
const server = spawn(binary, [], {
  cwd: project,
  env: { ...process.env, ECHO_BIND: `127.0.0.1:${port}`, ECHO_DATA_DIR: dataDirectory },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });
let browser;
let passed = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) { if(server.exitCode !== null)throw new Error('The isolated test server could not bind. Refusing to use any existing workspace.');
    if (server.exitCode !== null) throw new Error(`Test server exited: ${serverOutput}`);
    try { if ((await fetch(`${origin}/api/settings`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Test server did not start: ${serverOutput}`);
}

try {
  await ready();
  const settings = await fetch(`${origin}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoTranscribe: false, onboardingComplete: true }),
  });
  assert.equal(settings.status, 200, await settings.text());
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__captureTest = { micCalls: 0, streams: [], uploads: [], states: [], saved: [], contexts: [] };
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__captureTest.micCalls++;
      const stream = await originalGetUserMedia(constraints);
      window.__captureTest.streams.push(stream);
      return stream;
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/audio') && init?.body instanceof FormData) {
        window.__captureTest.uploads.push({
          url: String(url), sequence: init.body.get('sequence'), bytes: init.body.get('file').size,
        });
      }
      return originalFetch(url, init);
    };
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, args) {
        const audioContext = Reflect.construct(target, args);
        window.__captureTest.contexts.push(audioContext);
        return audioContext;
      },
    });
    window.addEventListener('echo-recorder-state', (event) => window.__captureTest.states.push(event.detail));
    window.addEventListener('echo-recording-saved', (event) => window.__captureTest.saved.push(event.detail));
  });
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.echoRecorder?.start === 'function');
  await delay(500);
  assert.equal(await page.evaluate(() => window.__captureTest.micCalls), 0);
  console.log('PASS: loading the real application does not request microphone access');

  async function createMeeting(title) {
    return page.evaluate(async (title) => {
      const response = await fetch('/api/meetings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, mode: 'in-person', consent: true }),
      });
      const meeting = await response.json();
      if (!response.ok) throw new Error(meeting.error);
      return meeting;
    }, title);
  }

  async function assertReleased() {
    const released = await page.evaluate(() => ({
      tracks: window.__captureTest.streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)),
      contexts: window.__captureTest.contexts.map((context) => context.state),
    }));
    assert.ok(released.tracks.length > 0);
    assert.ok(released.tracks.every((state) => state === 'ended'), JSON.stringify(released));
    assert.ok(released.contexts.every((state) => state === 'closed'), JSON.stringify(released));
  }

  async function decodeSaved(meeting) {
    return page.evaluate(async (meeting) => {
      const response = await fetch(meeting.tracks[0].url);
      if (!response.ok) throw new Error(`Audio playback returned ${response.status}`);
      const encoded = await response.arrayBuffer();
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(encoded);
        const samples = decoded.getChannelData(0);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value));
        return { bytes: encoded.byteLength, duration: decoded.duration, channels: decoded.numberOfChannels, peak };
      } finally { await context.close(); }
    }, meeting);
  }

  const meeting = await createMeeting('Browser capture integration');
  const started = Date.now();
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), meeting);
  await page.waitForFunction((id) => window.__captureTest.uploads.some((item) => item.url.includes(id)), meeting.id, { timeout: 10000 });
  const recording = await (await fetch(`${origin}/api/meetings/${meeting.id}`)).json();
  assert.equal(recording.status, 'recording');
  await page.waitForFunction(async (id) => {
    const saved = await (await fetch(`/api/meetings/${id}`)).json();
    return saved.tracks[0]?.bytes > 0;
  }, meeting.id);
  console.log('PASS: explicit microphone start persists a real periodic audio chunk to the Rust server');

  await page.evaluate(() => window.echoRecorder.toggleMute());
  assert.equal(await page.evaluate(() => window.__captureTest.streams.at(-1).getAudioTracks()[0].enabled), false);
  await delay(600);
  await page.evaluate(() => window.echoRecorder.pause());
  const pausedElapsed = await page.evaluate(() => window.echoRecorder.state.elapsed);
  const pausedAt = Date.now();
  await delay(1200);
  assert.equal(await page.evaluate(() => window.echoRecorder.state.elapsed), pausedElapsed);
  await page.evaluate(() => window.echoRecorder.resume());
  const pausedMs = Date.now() - pausedAt;
  await delay(400);
  await page.evaluate(() => window.echoRecorder.toggleMute());
  await delay(350);
  const saved = await page.evaluate(() => window.echoRecorder.stop());
  const wallSeconds = (Date.now() - started) / 1000;
  assert.equal(saved.status, 'saved');
  assert.equal(saved.tracks.length, 1);
  assert.equal(saved.gaps.length, 1);
  assert.equal(saved.gaps[0].reason, 'Microphone muted');
  assert.ok(saved.gaps[0].end - saved.gaps[0].start >= 0.9);
  assert.ok(saved.gaps[0].end - saved.gaps[0].start < 1.7);
  assert.ok(Math.abs(saved.duration - (wallSeconds - pausedMs / 1000)) < 0.7, `timeline duration=${saved.duration}, wall=${wallSeconds}, paused=${pausedMs}`);
  const uploads = await page.evaluate((id) => window.__captureTest.uploads.filter((item) => item.url.includes(id)), meeting.id);
  assert.ok(uploads.length >= 2, 'Expected periodic and final chunks');
  assert.deepEqual(uploads.map((item) => Number(item.sequence)), uploads.map((_, index) => index));
  assert.equal(saved.tracks[0].bytes, uploads.reduce((sum, upload) => sum + upload.bytes, 0));
  const audio = await decodeSaved(saved);
  assert.ok(audio.duration > 5 && audio.channels > 0 && audio.peak > 0);
  assert.ok(Math.abs(audio.duration - saved.duration) < 0.7, `decoded=${audio.duration}, metadata=${saved.duration}`);
  await assertReleased();
  console.log(`PASS: pause/mute/resume, final chunk, browser audio decode (${audio.duration.toFixed(2)}s), and resource release`);

  const interrupted = await createMeeting('Source disconnection integration');
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), interrupted);
  await delay(700);
  await page.evaluate(() => window.__captureTest.streams.at(-1).getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForFunction((id) => window.__captureTest.saved.some((meeting) => meeting.id === id), interrupted.id);
  const interruptedSaved = await (await fetch(`${origin}/api/meetings/${interrupted.id}`)).json();
  assert.equal(interruptedSaved.status, 'interrupted');
  assert.ok((await decodeSaved(interruptedSaved)).duration > 0);
  await assertReleased();
  console.log('PASS: a simulated source-ended event flushes real captured audio and marks the meeting interrupted');

  let rejectUploads = true;
  await page.route('**/api/meetings/*/audio', async (route) => {
    if (route.request().method() === 'POST' && rejectUploads) await route.abort('connectionfailed');
    else await route.continue();
  });
  const retryMeeting = await createMeeting('Upload retry integration');
  await page.evaluate((meeting) => window.echoRecorder.start({ meeting }), retryMeeting);
  await page.waitForFunction(() => window.echoRecorder.state.status === 'error', null, { timeout: 15000 });
  assert.match(await page.evaluate(() => window.echoRecorder.state.error), /retained in this tab/);
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  rejectUploads = false;
  const recovered = await page.evaluate(() => window.echoRecorder.retry());
  assert.equal(recovered.status, 'interrupted');
  const retriedUploads = await page.evaluate((id) => window.__captureTest.uploads.filter((item) => item.url.includes(id)), retryMeeting.id);
  assert.deepEqual(retriedUploads.map((item) => item.sequence), ['0', '0', '0', '0', '1']);
  assert.equal(recovered.tracks[0].bytes, retriedUploads[3].bytes + retriedUploads[4].bytes);
  assert.ok((await decodeSaved(recovered)).duration > 5);
  await assertReleased();
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  console.log('PASS: network failure stops capture, retains chunks, protects unload, and retries without duplicated audio');
  passed = true;
  console.log('Recorder browser integration: 5 checks passed.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGINT');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (passed) await rm(dataDirectory, { recursive: true, force: true });
  else console.error(`Recorder test data retained at ${dataDirectory}\n${serverOutput}`);
}
