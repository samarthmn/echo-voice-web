import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';

const executable = resolve(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server');
const fixture = resolve('tests/fixtures/codex-helper.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(t, initialControl = {}, helperBinary = fixture) {
  await access(executable);
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), 'echo-chatgpt-test-'));
  const home = join(directory, 'chatgpt');
  await mkdir(home);
  let settings = initialControl;
  const control = async patch => { settings = { ...settings, ...patch }; await writeFile(join(home, 'fixture-control.json'), JSON.stringify(settings)); };
  await control({});
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const localCalls = [];
  const localProvider = createHttpServer((request, response) => {
    localCalls.push(request.url); request.resume();
    response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Unexpected local-provider fallback' }));
  });
  localProvider.listen(0, '127.0.0.1'); await once(localProvider, 'listening');
  const env = { ...process.env, ECHO_DATA_DIR: directory, ECHO_BIND: `127.0.0.1:${port}`, ECHO_CODEX_BIN: helperBinary,
    ECHO_BOT_TOKEN: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    OPENAI_API_KEY: 'fixture-must-not-inherit', CODEX_API_KEY: 'fixture-must-not-inherit', CHATGPT_ACCESS_TOKEN: 'fixture-must-not-inherit',
    OPENAI_BASE_URL: 'https://fixture.invalid', CODEX_HOME: join(directory, 'unused-host-codex'), HOME: join(directory, 'unused-host-home') };
  delete env.ECHO_ALLOWED_ORIGIN;
  const child = spawn(executable, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; let failure;
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  child.on('error', error => { failure = error; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    }
    localProvider.closeAllConnections(); await new Promise(resolve => localProvider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/api`;
  for (let attempt = 0; ; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null || attempt === 80) throw new Error(`Server startup failed: ${logs}`);
    try { const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) }); if (response.ok) break; } catch {}
    await pause(50);
  }
  const api = async (path, { method = 'GET', body, status = 200 } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const value = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`); return value;
  };
  const protocol = async () => { try { return (await readFile(join(home, 'fixture-log.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  // Route any unexpected fallback into this test's loopback double, never a real
  // developer Ollama service that might happen to be listening on its usual port.
  await api('/settings', { method: 'PATCH', body: { ollamaUrl: `http://127.0.0.1:${localProvider.address().port}` } });
  const connect = async () => {
    const login = await api('/chatgpt/login', { method: 'POST' }); assert.equal(login.pending, true);
    assert.match(login.authUrl, /^https:\/\/auth\.openai\.com\//);
    await control({ completeLogin: true });
    const state = await api('/chatgpt'); assert.equal(state.connected, true); assert.equal(state.login.pending, false); return state;
  };
  const meeting = async () => {
    const created = await api('/meetings', { method: 'POST', status: 201, body: { title: 'Protocol fixture meeting', mode: 'in-person', consent: true } });
    return api(`/meetings/${created.id}/transcripts`, { method: 'POST', body: { model: 'fixture-transcriber', passages: [{ id: 'p1', start: 0, end: 2, speaker: 'Asha', text: 'We agreed to release Friday.' }] } });
  };
  const generate = (meetingId, options = {}) => api('/notes', { method: 'POST', body: { meetingId, provider: 'chatgpt', cloudConsent: true, ...(options.body || {}) }, status: options.status || 200 });
  return { directory, home, api, protocol, control, connect, meeting, generate, localCalls };
}

test('ChatGPT bridge requires per-request consent before launching the helper', { timeout: 15000 }, async t => {
  const h = await launch(t);
  for (const cloudConsent of [undefined, false]) {
    const body = { meetingId: 'not-accessed', provider: 'chatgpt', ...(cloudConsent === undefined ? {} : { cloudConsent }) };
    assert.match((await h.api('/notes', { method: 'POST', body, status: 403 })).error, /No transcript was sent/);
  }
  assert.deepEqual(await h.protocol(), []);
});

test('ChatGPT login, catalog, isolated generation, provenance, and logout use the pinned protocol', { timeout: 20000 }, async t => {
  const h = await launch(t);
  const initial = await h.api('/chatgpt'); assert.equal(initial.installed, true); assert.equal(initial.connected, false);
  await h.api('/chatgpt/models', { status: 401 });
  const login = await h.api('/chatgpt/login', { method: 'POST' }); assert.equal(login.pending, true);
  await h.api('/chatgpt/login', { method: 'POST', status: 409 });
  assert.equal((await h.api('/chatgpt/login', { method: 'DELETE' })).cancelled, true);
  const state = await h.connect(); assert.equal(state.account.planType, 'plus'); assert.equal(state.rateLimits.primary.usedPercent, 25);
  assert.equal(JSON.stringify(state).includes('do-not-expose'), false);
  assert.deepEqual((await h.api('/chatgpt/models')).models, [{ id: 'fixture-codex', displayName: 'Fixture Codex', isDefault: true }]);
  const meeting = await h.meeting();
  const saved = await h.generate(meeting.id);
  const notes = saved.notes.at(-1);
  assert.equal(notes.provider, 'chatgpt'); assert.equal(notes.model, 'fixture-codex'); assert.equal(notes.transcriptVersionId, meeting.activeTranscriptId);
  assert.deepEqual(notes.usage, { inputTokens: 123, outputTokens: 45, cachedInputTokens: 20 });
  assert.deepEqual(notes.summary[0].passageIds, ['p1']); assert.equal(notes.summary[0].text, 'Release Friday.');
  const records = await h.protocol();
  const spawn = records.find(entry => entry.event === 'spawn');
  assert.deepEqual(spawn.inheritedCredentialNames, []); assert.equal(spawn.home, h.home); assert.equal(spawn.cwd, join(h.home, 'work'));
  assert.deepEqual(spawn.argv, ['app-server', '--stdio', '--strict-config']);
  for (const setting of ['forced_login_method = "chatgpt"', 'model_provider = "openai"', 'shell_tool = false', 'apps = false', 'plugins = false', 'web_search = "disabled"']) assert.ok(spawn.config.includes(setting), setting);
  const thread = records.find(entry => entry.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.modelProvider, 'openai'); assert.equal(thread.model, 'fixture-codex');
  assert.equal(thread.allowProviderModelFallback, false); assert.deepEqual(thread.environments, []); assert.deepEqual(thread.dynamicTools, []);
  assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.sandbox, 'read-only');
  const turn = records.find(entry => entry.method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.environments, []); assert.match(turn.input[0].text, /We agreed to release Friday/);
  assert.equal(turn.outputSchema.additionalProperties, false); assert.deepEqual(turn.outputSchema.required, ['summary', 'decisions', 'actions']);
  const archive = await h.api('/storage/export'); assert.equal(JSON.stringify(archive).includes('fixture-login'), false); assert.equal(JSON.stringify(archive).includes('fixture@example.test'), false);
  await h.api('/chatgpt/logout', { method: 'POST' }); assert.equal((await h.api('/chatgpt')).connected, false);
  await h.generate(meeting.id, { status: 401 });
  assert.equal((await h.api(`/meetings/${meeting.id}`)).notes.length, 1);
});

test('ChatGPT accepts a final answer supplied only in turn completion', { timeout: 15000 }, async t => {
  const h = await launch(t, { mode: 'final-items-only' }); await h.connect(); const meeting = await h.meeting();
  assert.equal((await h.generate(meeting.id)).notes.at(-1).summary[0].text, 'Release Friday.');
});

test('ChatGPT accepts the supported nullable agent-message phase', { timeout: 15000 }, async t => {
  const h = await launch(t, { mode: 'null-phase' }); await h.connect(); const meeting = await h.meeting();
  assert.equal((await h.generate(meeting.id)).notes.at(-1).summary[0].text, 'Release Friday.');
});

test('immediate successful ChatGPT login does not remain pending', { timeout: 15000 }, async t => {
  const h = await launch(t, { immediateLogin: true });
  await h.api('/chatgpt/login', { method: 'POST' });
  const state = await h.api('/chatgpt'); assert.equal(state.connected, true); assert.equal(state.login.pending, false);
});

test('unsafe login destinations are cancelled without returning the destination', { timeout: 15000 }, async t => {
  const h = await launch(t, { unsafeAuthUrl: 'https://hostile.invalid/sign-in' });
  const result = await h.api('/chatgpt/login', { method: 'POST', status: 502 }); assert.equal(JSON.stringify(result).includes('hostile.invalid'), false);
  assert.ok((await h.protocol()).some(entry => entry.method === 'account/login/cancel'));
});

for (const [mode, status] of [['quota', 429], ['unknown-allowance', 503], ['quota-error', 429], ['crash', 502], ['tool-event', 502], ['tool-request', 502], ['tool-final-item', 502], ['bad-json', 502], ['bad-evidence', 502], ['commentary-only', 502], ['unsafe-environment', 503], ['unsafe-network', 503], ['wrong-model', 503]]) {
  test(`ChatGPT ${mode} fails without saving notes or falling back`, { timeout: 15000 }, async t => {
    const h = await launch(t, { mode }); await h.connect(); const meeting = await h.meeting();
    await h.generate(meeting.id, { status }); assert.equal((await h.api(`/meetings/${meeting.id}`)).notes.length, 0);
    assert.deepEqual(h.localCalls, []);
    const protocol = await h.protocol();
    assert.equal(protocol.filter(entry => entry.method === 'turn/start').length, ['quota', 'unknown-allowance', 'unsafe-environment', 'unsafe-network', 'wrong-model'].includes(mode) ? 0 : 1);
    assert.ok(protocol.filter(entry => entry.method === 'thread/start').every(entry => entry.params.modelProvider === 'openai' && entry.params.model === 'fixture-codex'));
    // The bridge kills the helper as it denies this request; the helper may not
    // get scheduled again to observe the negative response before it is killed.
    if (mode === 'tool-request') assert.equal(protocol.some(entry => entry.id === 'fixture-tool-request' && entry.result !== undefined), false);
  });
}

test('API-key account cannot satisfy ChatGPT subscription authentication', { timeout: 15000 }, async t => {
  const h = await launch(t, { apiKeyAccount: true }); const meeting = await h.meeting();
  const state = await h.api('/chatgpt'); assert.equal(state.connected, false); assert.match(state.error, /ChatGPT sign-in only/);
  await h.generate(meeting.id, { status: 401 });
  assert.deepEqual(h.localCalls, []);
  assert.equal((await h.protocol()).some(entry => entry.method === 'thread/start'), false);
});

test('model selection outside the account catalog fails before transcript submission', { timeout: 15000 }, async t => {
  const h = await launch(t); await h.connect(); const meeting = await h.meeting();
  await h.generate(meeting.id, { body: { model: 'unavailable-model' }, status: 422 });
  assert.equal((await h.protocol()).some(entry => entry.method === 'turn/start'), false);
});

test('unrecognized helper versions cannot begin sign-in or receive transcript data', { timeout: 15000 }, async t => {
  const h = await launch(t, { helperVersion: 'codex-cli 0.159.0' });
  const state = await h.api('/chatgpt'); assert.equal(state.connected, false); assert.match(state.error, /0\.160\.0/);
  await h.api('/chatgpt/login', { method: 'POST', status: 503 });
  const meeting = await h.meeting(); await h.generate(meeting.id, { status: 503 });
  assert.deepEqual(await h.protocol(), []);
});

test('an explicitly configured relative helper path resolves before the private working directory is set', { timeout: 15000 }, async t => {
  const h = await launch(t, {}, 'tests/fixtures/codex-helper.mjs');
  const state = await h.api('/chatgpt'); assert.equal(state.installed, true); assert.equal(state.error, null);
  assert.equal((await h.connect()).connected, true);
});

test('a crashed helper can restart for a later explicit generation', { timeout: 15000 }, async t => {
  const h = await launch(t, { mode: 'crash' }); await h.connect(); const meeting = await h.meeting();
  await h.generate(meeting.id, { status: 502 });
  await h.control({ mode: 'success' });
  assert.equal((await h.generate(meeting.id)).notes.length, 1);
  assert.equal((await h.protocol()).filter(entry => entry.event === 'spawn').length, 2);
});

test('an unsuccessful new generation preserves the previous saved notes exactly', { timeout: 15000 }, async t => {
  const h = await launch(t); await h.connect(); const meeting = await h.meeting();
  const first = await h.generate(meeting.id);
  await h.control({ mode: 'bad-evidence' }); await h.generate(meeting.id, { status: 502 });
  const preserved = await h.api(`/meetings/${meeting.id}`);
  assert.deepEqual(preserved.notes, first.notes); assert.equal(preserved.activeNotesId, first.activeNotesId);
});

test('ChatGPT connection changes are blocked while a generation is running', { timeout: 15000 }, async t => {
  const h = await launch(t, { delayMs: 350 }); await h.connect(); const meeting = await h.meeting();
  const generation = h.generate(meeting.id);
  for (let attempt = 0; ; attempt++) { if ((await h.protocol()).some(entry => entry.method === 'turn/start')) break; assert.ok(attempt < 60); await pause(10); }
  assert.equal((await h.api('/chatgpt')).busy, true);
  await h.api('/chatgpt/logout', { method: 'POST', status: 409 }); await h.api('/chatgpt/login', { method: 'DELETE', status: 409 });
  await generation; assert.equal((await h.api('/chatgpt')).busy, false);
});
