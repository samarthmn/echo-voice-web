import { createServer as createPortReservation } from 'node:net';
// Run after cargo build -p echo-server and npm run build:assets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
const data = await mkdtemp(join(process.cwd(), 'tmp', 'echo-import-browser-'));
const reservation=createPortReservation();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const freePort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const port = process.env.ECHO_IMPORT_TEST_PORT || String(freePort);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.env.ECHO_TEST_BINARY || './target/debug/echo-server', [], { env: { ...process.env, ECHO_BIND: `127.0.0.1:${port}`, ECHO_DATA_DIR: data }, stdio: 'pipe' });
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { if(server.exitCode !== null)throw new Error('The isolated test server could not bind. Refusing to use any existing workspace.'); try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {} if (attempt === 99) throw new Error('Test server did not start.'); await delay(100); }
  await fetch(`${origin}/api/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoTranscribe: false }) });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.echo && window.echoInference);
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  const sequences = [];
  let failOnce = true;
  await page.route('**/api/meetings/*/audio', async route => {
    const sequence = Number(route.request().postDataBuffer().toString('latin1').match(/name="sequence"\r\n\r\n(\d+)/)?.[1]);
    sequences.push(sequence);
    await page.getByRole('status').filter({hasText:'Saving recording…'}).waitFor();
    assert.equal(await page.getByRole('progressbar', {name:'Saving chunked-import.wav'}).count(), 1);
    if (sequence === 1 && failOnce) { failOnce = false; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Injected import failure' }) }); }
    await route.continue();
  });
  const first = await page.evaluate(async () => {
    const dataBytes = 17 * 1024 * 1024;
    const header = new ArrayBuffer(44); const view = new DataView(header);
    const str = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, dataBytes + 36, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, dataBytes, true);
    window.__importFile = new File([header, new Uint8Array(dataBytes)], 'chunked-import.wav', { type: 'audio/wav', lastModified: 1234 });
    window.__progress = [];
    window.addEventListener('echo-upload-progress', event => window.__progress.push(event.detail));
    const input = { files: [window.__importFile], value: 'selected' };
    try { await window.echo.upload(input); return { error: null }; }
    catch (error) { return { error: error.message, inputValue: input.value, meetingId: window.__progress.at(-1).meetingId, bytes: window.__progress.at(-1).bytes }; }
  });
  await page.waitForFunction(() => !document.querySelector('.upload-progress'));
  assert.match(first.error, /Injected import failure/);
  assert.equal(first.inputValue, ''); assert.equal(first.bytes, 8 * 1024 * 1024);
  const failed = await (await fetch(`${origin}/api/meetings/${first.meetingId}`)).json();
  assert.equal(failed.status, 'error'); assert.equal(failed.tracks[0].bytes, 8 * 1024 * 1024);
  const saved = await page.evaluate(async () => window.echo.upload({ files: [window.__importFile], value: 'selected-again' }));
  await page.waitForFunction(() => !document.querySelector('.upload-progress'));
  assert.equal(saved.id, first.meetingId); assert.equal(saved.status, 'saved');
  assert.equal(saved.tracks[0].bytes, 17 * 1024 * 1024 + 44);
  assert.ok(saved.duration > 550 && saved.duration < 560);
  assert.deepEqual(sequences, [0, 1, 1, 2]);
  const fullAudio = new Uint8Array(await (await fetch(`${origin}${saved.tracks[0].url}`)).arrayBuffer());
  assert.equal(fullAudio.length, 17 * 1024 * 1024 + 44); assert.equal(new TextDecoder().decode(fullAudio.slice(0, 4)), 'RIFF');
  const library = await (await fetch(`${origin}/api/meetings`)).json(); assert.equal(library.meetings.length, 1);
  console.log('PASS: 17 MB import uses ordered 8 MB chunks; failure preserves status and acknowledged bytes; retry resumes one meeting/track; full byte count and duration match.');
  await page.unroute('**/api/meetings/*/audio');

  const auto = await page.evaluate(async () => {
    const request = async enabled => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoTranscribe: enabled }) });
    const speechModel = 'onnx-community/whisper-large-v3-turbo';
    // Queue execution rechecks the durable meeting to honor cancellation. Use
    // real saved fixtures so that check exercises the API rather than a 404.
    const meeting = async title => {
      const created = await fetch('/api/meetings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,mode:'import',consent:true,speechModel})});
      if(!created.ok) throw new Error(`Fixture meeting failed (${created.status}).`);
      const row = await created.json();
      const header = await window.__importFile.slice(0,44).arrayBuffer(); const view = new DataView(header);
      view.setUint32(4,100,true); view.setUint32(40,64,true);
      const form = new FormData(); form.append('audio',new Blob([header,new Uint8Array(64)],{type:'audio/wav'}),'auto-fixture.wav');
      form.append('trackId','auto-fixture'); form.append('sequence','0'); form.append('label',title);
      const uploaded = await fetch(`/api/meetings/${row.id}/audio`,{method:'POST',body:form});
      if(!uploaded.ok) throw new Error(`Fixture audio failed (${uploaded.status}).`);
      const saved = await fetch(`/api/meetings/${row.id}`);
      if(!saved.ok) throw new Error(`Fixture read failed (${saved.status}).`);
      return saved.json();
    };
    const disabled = await meeting('Automatic disabled');
    const missing = await meeting('Automatic missing model');
    const ready = await meeting('Automatic ready');
    let calls = 0; const calledIds = []; const skipped = [];
    window.addEventListener('echo-auto-transcription-skipped', event => skipped.push(event.detail));
    window.echoInference.transcribeMeeting = async id => { calls++; calledIds.push(id); };
    window.echoInference.getDownloadedModels = async () => ['onnx-community/whisper-large-v3-turbo'];
    await window.echo.autoTranscribeMeeting(disabled); const disabledCalls = calls;
    await request(true);
    window.echoInference.getDownloadedModels = async () => [];
    await window.echo.autoTranscribeMeeting(missing); const noModelCalls = calls;
    window.echoInference.getDownloadedModels = async () => ['onnx-community/whisper-large-v3-turbo'];
    await Promise.all([window.echo.autoTranscribeMeeting(ready), window.echo.autoTranscribeMeeting(ready)]);
    return { disabledCalls, noModelCalls, totalCalls: calls, calledIds, readyId:ready.id, skipped };
  });
  assert.equal(auto.disabledCalls, 0); assert.equal(auto.noModelCalls, 0); assert.equal(auto.totalCalls, 1);
  assert.deepEqual(auto.calledIds,[auto.readyId]);
  assert.ok(auto.skipped.some(event => event.reason === 'model-not-downloaded'));
  console.log('PASS: auto-transcription honors disabled setting, skips missing models without download, and runs once for a ready saved recording.');
} finally {
  await browser?.close();
  server.kill('SIGINT');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(data, { recursive: true, force: true });
}
