import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';

const executable = resolve(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function rawGet(url, headers) { return new Promise((resolve, reject) => { const request = httpRequest(url, { headers }, response => { const parts = []; response.on('data', p => parts.push(p)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(parts).toString() })); }); request.on('error', reject); request.end(); }); }
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function launch(directory, port) {
  const env = { ...process.env, ECHO_DATA_DIR: directory, ECHO_BIND: `127.0.0.1:${port}`, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' };
  const child = spawn(executable, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; let failure; child.on('error', error => { failure = error; });
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${logs}`);
    try { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(200) }); if (response.ok) return { child, base, logs: () => logs }; } catch {}
    await pause(100);
  }
  child.kill('SIGKILL'); throw new Error(`Server did not become ready: ${logs}`);
}
async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit'); server.child.kill('SIGINT');
  let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { server.child.kill('SIGKILL'); resolve(); }, 3000); })]); clearTimeout(timer);
}
function wavFixture() {
  const data = Buffer.alloc(64); data.write('RIFF'); data.writeUInt32LE(56, 4); data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(20, 40); return data;
}

test('real Rust REST server preserves meeting lifecycle, audio, history, privacy and backups', { timeout: 60000 }, async () => {
  await access(executable);
  const directory = await mkdtemp(join(tmpdir(), 'echo-rest-')); const port = await freePort(); let server;
  try {
    server = await launch(directory, port);
    const api = async (path, { method = 'GET', body, status = 200, headers = {} } = {}) => {
      const response = await fetch(`${server.base}/api${path}`, { method, headers: { ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    };
    assert.equal((await api('/health')).storage, 'local');
    assert.deepEqual((await api('/meetings')).meetings, []);
    assert.match((await api('/meetings', { headers: { Origin: 'https://hostile.example' }, status: 403 })).error, /another website/i);
    const rebinding = await rawGet(`${server.base}/api/meetings`, { Host: 'dns-rebinding.example' }); assert.equal(rebinding.status, 403); assert.match(JSON.parse(rebinding.text).error, /blocked/i);
    await api('/meetings', { method: 'POST', body: { title: 'Without consent', mode: 'in-person', consent: false }, status: 400 });
    await api('/settings', { method: 'PATCH', body: { ollamaUrl: 'http://169.254.169.254' }, status: 400 });
    await api('/settings', { method: 'PATCH', body: { name: null }, status: 400 });
    const settings = await api('/settings', { method: 'PATCH', body: { name: 'Asha', language: 'en', onboardingComplete: true } }); assert.equal(settings.name, 'Asha');
    const word = await api('/vocabulary', { method: 'POST', body: { term: 'Echo Voice', aliases: ['echo boys'] }, status: 201 });
    assert.equal(word.enabled, true); await api(`/vocabulary/${word.id}`, { method: 'PATCH', body: { aliases: ['echo boys', 'echo voice'] } });
    const meeting = await api('/meetings', { method: 'POST', body: { title: 'Product review', mode: 'in-person', consent: true, liveTranscription: true }, status: 201 });
    const id = meeting.id; const wav = wavFixture(); const tail = Buffer.from('extra-audio-samples');
    const upload = async (bytes, sequence, status = 201) => {
      const form = new FormData(); form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'room.wav'); form.append('trackId', 'room'); form.append('label', 'Room microphone'); form.append('sequence', String(sequence)); return api(`/meetings/${id}/audio`, { method: 'POST', body: form, status });
    };
    const firstUpload = await upload(wav, 0); assert.deepEqual(await upload(wav, 0), firstUpload);
    await upload(Buffer.from('different bytes'), 0, 409); await upload(tail, 2, 409); const track = await upload(tail, 1); assert.equal(track.bytes, wav.length + tail.length);
    const fullAudio = await fetch(`${server.base}${track.url}`); assert.equal(fullAudio.status, 200); assert.deepEqual(Buffer.from(await fullAudio.arrayBuffer()), Buffer.concat([wav, tail]));
    const ranged = await fetch(`${server.base}${track.url}`, { headers: { Range: 'bytes=60-70' } }); assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), `bytes 60-70/${track.bytes}`); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), Buffer.concat([wav, tail]).subarray(60, 71));
    const invalidRange = await fetch(`${server.base}${track.url}`, { headers: { Range: 'bytes=999-' } }); assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers.get('content-range'), `bytes */${track.bytes}`);
    const download = await fetch(`${server.base}${track.url}?download=1`); assert.match(download.headers.get('content-disposition'), /Room-microphone.wav/); await download.arrayBuffer();
    const first = await api(`/meetings/${id}/transcripts`, { method: 'POST', body: { model: 'local-test-model', passages: [{ id: 'p1', start: 0, end: 2, text: 'We will ship Friday.', speaker: 'Speaker 1' }] } });
    assert.equal(first.transcripts[0].vocabulary[0].term, 'Echo Voice');
    const notes = { model: 'local-test-notes', transcriptVersionId: first.activeTranscriptId, summary: [{ id: 'n1', text: 'A Friday release was agreed.', passageIds: ['p1'] }], decisions: [], actions: [{ id: 'n2', text: 'Prepare the release.', owner: 'Asha', passageIds: ['p1'], done: false }] };
    const withNotes = await api(`/meetings/${id}/notes`, { method: 'POST', body: notes }); assert.equal(withNotes.notes.length, 1);
    await api(`/meetings/${id}/notes`, { method: 'POST', body: { ...notes, summary: [{ id: 'bad', text: 'Invented note', passageIds: ['invented'] }] }, status: 400 });
    const edited = await api(`/meetings/${id}/transcripts`, { method: 'POST', body: { model: 'local-test-model', label: 'Edited transcript', vocabulary: [], passages: [{ id: 'p1', start: 0, end: 2, text: 'We will ship next Friday.', speaker: 'Asha' }] } });
    assert.equal(edited.transcripts.length, 2); assert.equal(edited.notes[0].transcriptVersionId, first.activeTranscriptId); assert.equal(edited.transcripts[0].passages[0].text, 'We will ship Friday.');
    await api(`/meetings/${id}`, { method: 'PATCH', body: { activeTranscriptId: 'another-meeting-version' }, status: 400 });
    const marked = await api(`/meetings/${id}/moments`, { method: 'POST', body: { time: 1, label: 'Release date', passageId: 'p1', kind: 'highlight' } }); const moment = marked.moments[0];
    const renamed = await api(`/meetings/${id}/moments/${moment.id}`, { method: 'PATCH', body: { label: 'Verify release date' } }); assert.equal(renamed.moments[0].label, 'Verify release date');
    await api(`/meetings/${id}`, { method: 'PATCH', body: { duration: 3, liveTranscription: false, gaps: [{ start: 2, end: 3, reason: 'Microphone muted' }] } });
    await api(`/meetings/${id}`, { method: 'PATCH', body: { liveTranscription: true }, status: 409 });
    const markdown = await (await fetch(`${server.base}/api/meetings/${id}/export?format=md`)).text(); assert.match(markdown, /earlier transcript version/); assert.match(markdown, /Verify release date/); assert.match(markdown, /Microphone muted/);
    const srt = await (await fetch(`${server.base}/api/meetings/${id}/export?format=srt`)).text(); assert.match(srt, /00:00:00,000 --> 00:00:02,000/); assert.match(srt, /Asha: We will ship next Friday/);
    const backup = await api('/storage/export'); assert.equal(backup.format, 'echo-voice-web'); assert.equal(backup.audio.length, 2); assert.equal(backup.settings.ollamaUrl, undefined);
    await api('/storage/import', { method: 'POST', body: backup, status: 409 });
    await api(`/meetings/${id}`, { method: 'PATCH', body: { status: 'recording' } }); await api(`/meetings/${id}`, { method: 'DELETE', status: 409 });
    await assert.rejects(() => launch(directory, port + 1), /Another Echo Voice server/);
    assert.equal((await api(`/meetings/${id}`)).status, 'recording');
    await stop(server); server = await launch(directory, port);
    const recovered = await api(`/meetings/${id}`); assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.transcripts.length, 2); assert.equal(recovered.tracks[0].bytes, track.bytes); assert.match(recovered.error, /interrupted/i);
    const botDirectory = join(directory, 'bot', id); await mkdir(botDirectory, { recursive: true }); await writeFile(join(botDirectory, 'session.json'), JSON.stringify({ status: 'waiting' }));
    await api(`/meetings/${id}`, { method: 'DELETE', status: 409 }); await writeFile(join(botDirectory, 'session.json'), JSON.stringify({ status: 'completed' }));
    await api(`/meetings/${id}`, { method: 'DELETE' }); await api(`/vocabulary/${word.id}`, { method: 'DELETE' });
    await assert.rejects(access(botDirectory)); await assert.rejects(access(join(directory, 'audio', id)));
    const unsafePath = structuredClone(backup); unsafePath.meetings[0].id = '../credentials'; await api('/storage/import', { method: 'POST', body: unsafePath, status: 400 });
    const unsafeUrl = structuredClone(backup); unsafeUrl.meetings[0].meetingUrl = 'javascript:alert(1)'; await api('/storage/import', { method: 'POST', body: unsafeUrl, status: 400 });
    const credentials = structuredClone(backup); credentials.credentials = { oauthToken: 'never-import' }; await api('/storage/import', { method: 'POST', body: credentials, status: 400 });
    const executable = structuredClone(backup); executable.audio[0].data = Buffer.from('#!/bin/sh\ncommand').toString('base64'); await api('/storage/import', { method: 'POST', body: executable, status: 415 });
    assert.equal((await api('/meetings')).meetings.length, 0);
    const imported = await api('/storage/import', { method: 'POST', body: backup }); assert.equal(imported.meetings, 1); assert.equal(imported.vocabulary, 1);
    const restored = await api(`/meetings/${id}`); assert.equal(restored.transcripts.length, 2); assert.equal(restored.notes.length, 1); assert.equal(restored.moments.length, 1);
    const restoredAudio = await fetch(`${server.base}${track.url}`); assert.deepEqual(Buffer.from(await restoredAudio.arrayBuffer()), Buffer.concat([wav, tail]));
    const storage = await api('/storage'); assert.equal(storage.meetings, 1); assert.ok(storage.bytes > track.bytes); assert.ok(storage.availableBytes > 0); assert.equal(storage.path, directory);
    const absentRunner = await api('/integrations/status'); assert.equal(absentRunner.runner.configured, true); assert.equal(absentRunner.runner.reachable, false); assert.equal(absentRunner.google.configured, false);
    await api('/integrations/bot', { method: 'POST', body: { meetingId: id, consent: false, url: 'https://meet.google.com/abc-defg-hij' }, status: 422 });
    const csrfCallback = await rawGet(`${server.base}/api/integrations/google/callback?code=fake&state=fake`, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }); assert.equal(csrfCallback.status, 303); assert.match(csrfCallback.headers.location, /calendar=error/);
    // Exercise the route-specific multipart and archive limits above the 8 MB JSON default.
    const largeMeeting = await api('/meetings', { method: 'POST', body: { title: 'Longer recording', mode: 'import', consent: false }, status: 201 });
    const large = Buffer.alloc(9 * 1024 * 1024); wav.copy(large); large.writeUInt32LE(large.length - 8, 4); large.writeUInt32LE(large.length - 44, 40);
    const largeForm = new FormData(); largeForm.append('file', new Blob([large], { type: 'audio/wav' }), 'longer.wav');
    const largeTrack = await api(`/meetings/${largeMeeting.id}/audio`, { method: 'POST', body: largeForm, status: 201 }); assert.equal(largeTrack.bytes, large.length);
    const largeBackup = await api('/storage/export');
    await api(`/meetings/${id}`, { method: 'DELETE' }); await api(`/meetings/${largeMeeting.id}`, { method: 'DELETE' }); await api(`/vocabulary/${word.id}`, { method: 'DELETE' });
    const importedLarge = await api('/storage/import', { method: 'POST', body: largeBackup }); assert.equal(importedLarge.meetings, 2);
    assert.equal((await api(`/meetings/${largeMeeting.id}`)).tracks[0].bytes, large.length);
    assert.equal((await readFile(join(directory, 'workspace.sqlite'))).subarray(0, 15).toString(), 'SQLite format 3');
  } finally { await stop(server); await rm(directory, { recursive: true, force: true }); }
});
