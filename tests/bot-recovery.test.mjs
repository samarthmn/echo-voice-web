import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { resolve, join } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Allocate an independent loopback listener without touching a developer's running server. */
async function freePort() {
  const listener = netServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}

/** Launch a real workspace against a controlled runner that never joins a meeting. */
async function harness(t, mode = 'success') {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/bot-recovery-'));
  const data = join(root, 'data'); const port = await freePort();
  const calls = []; const sessions = new Map(); let rejectCancel = false;
  let releaseStop;
  let stopReceived;
  const stopRequested = new Promise(resolve => { stopReceived = resolve; });
  const runner = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const url = new URL(request.url, 'http://localhost');
    calls.push({ method: request.method, path: url.pathname, requestId: url.searchParams.get('requestId'), body });
    const token = await readFile(join(data, 'credentials/runner-token'), 'utf8');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const reply = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.method === 'POST') {
      const session = { meetingId: body.meetingId, requestId: body.requestId, status: 'joining' };
      sessions.set(body.meetingId, session);
      if (mode === 'lost-response' || mode === 'cancel-offline') { rejectCancel = mode === 'cancel-offline'; request.socket.destroy(); return; }
      if (mode === 'persistence-failure') await chmod(join(data, 'bot-starts'), 0o500);
      reply(202, session);
    } else if (request.method === 'DELETE') {
      if (mode === 'slow-stop' && !url.searchParams.has('requestId')) {
        const stopped = new Promise(resolve => { releaseStop = resolve; });
        stopReceived();
        await stopped;
      }
      if (rejectCancel) { reply(503, { error: 'Fixture runner cancellation unavailable' }); return; }
      const id = url.pathname.split('/').at(-1); const session = sessions.get(id);
      if (session && session.requestId === url.searchParams.get('requestId')) session.status = 'stopping';
      reply(202, { meetingId: id, requestId: url.searchParams.get('requestId'), status: session?.status || 'completed' });
    } else { reply(200, { ready: true }); }
  });
  runner.listen(0, '127.0.0.1'); await once(runner, 'listening');
  const config = JSON.parse(await readFile('echo.config.json'));
  config.runner.url = `http://127.0.0.1:${runner.address().port}`;
  const configFile = join(root, 'echo.config.json'); await writeFile(configFile, JSON.stringify(config));
  let child; let logs = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGINT');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer);
  };
  t.after(async () => {
    releaseStop?.();
    await stop(); runner.closeAllConnections(); await new Promise(resolve => runner.close(resolve));
    await chmod(join(data, 'bot-starts'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    child = spawn(resolve(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server'), [], { env: { ...process.env, TMPDIR: resolve('tmp'), ECHO_DATA_DIR: data, ECHO_BIND: `127.0.0.1:${port}`, ECHO_CONFIG_FILE: configFile, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, logs);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await pause(50);
    }
    throw new Error(`Workspace startup timed out: ${logs}`);
  };
  await start();
  const api = async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const meeting = await api('/meetings', 'POST', { title: 'Runner recovery fixture', mode: 'online', consent: true }, 201);
  const startBot = (expected = 202) => api('/integrations/bot', 'POST', { meetingId: meeting.id, url: 'https://meet.google.com/abc-defg-hij', consent: true }, expected);
  return { root, data, calls, sessions, meeting, startBot, api, start, stop, stopRequested, releaseStop: () => releaseStop?.(), allowCancel: () => { rejectCancel = false; } };
}

/** A slow stop without a reservation must not serialize unrelated recording starts. */
test('a stalled plain stop does not block a new recording start', { timeout: 8000 }, async t => {
  const h = await harness(t, 'slow-stop');
  await h.startBot();
  const other = await h.api('/meetings', 'POST', { title: 'Independent recording', mode: 'online', consent: true }, 201);
  const stopping = h.api(`/integrations/bot?meetingId=${h.meeting.id}`, 'DELETE');
  await h.stopRequested;
  let timer;
  try {
    const started = await Promise.race([
      h.api('/integrations/bot', 'POST', { meetingId: other.id, url: 'https://meet.google.com/abc-defg-hij', consent: true }, 202),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A plain stop held the recording-start lock')), 2000); }),
    ]);
    assert.equal(started.meetingId, other.id);
  } finally {
    clearTimeout(timer);
    h.releaseStop();
    await stopping;
  }
});

/** Confirm that successful acceptance leaves no unresolved start reservation. */
test('recording acceptance publishes a stable start ID and shares a generated credential', async t => {
  const h = await harness(t); const session = await h.startBot();
  assert.equal(session.meetingId, h.meeting.id); assert.match(session.requestId, /^[a-f0-9-]{36}$/);
  await assert.rejects(access(join(h.data, 'bot-starts', `${h.meeting.id}.json`)));
  const token = await readFile(join(h.data, 'credentials/runner-token'), 'utf8');
  const pythonToken = execFileSync('python3', ['-c', 'import sys; sys.path.insert(0,"runner"); from config import runner_token; from pathlib import Path; print(runner_token(Path(sys.argv[1])))', h.data], { encoding: 'utf8' }).trim();
  assert.equal(pythonToken, token);
});

/** A lost acceptance response must stop the same attempt before reporting failure. */
test('lost recording-start response triggers an authenticated scoped cancellation', async t => {
  const h = await harness(t, 'lost-response'); await h.startBot(503);
  assert.equal(h.sessions.get(h.meeting.id).status, 'stopping');
  assert.equal(h.calls.at(-1).requestId, h.calls[0].body.requestId);
  await assert.rejects(access(join(h.data, 'bot-starts', `${h.meeting.id}.json`)));
});

/** Failure to finalize durable state compensates even after a valid runner response. */
test('post-acceptance filesystem failure cancels the recording and retains recoverable intent', async t => {
  const h = await harness(t, 'persistence-failure'); await h.startBot(500);
  assert.equal(h.sessions.get(h.meeting.id).status, 'stopping');
  await access(join(h.data, 'bot-starts', `${h.meeting.id}.json`));
  await chmod(join(h.data, 'bot-starts'), 0o700);
  await h.api(`/integrations/bot?meetingId=${h.meeting.id}`, 'DELETE', undefined, 200);
});

/** Ambiguous starts remain stoppable and cannot be deleted while cancellation is offline. */
test('offline cancellation preserves intent, blocks deletion, and remains reachable through Stop bot', async t => {
  const h = await harness(t, 'cancel-offline');
  assert.match((await h.startBot(503)).error, /may still be active/);
  await access(join(h.data, 'bot-starts', `${h.meeting.id}.json`));
  await h.api(`/meetings/${h.meeting.id}`, 'DELETE', undefined, 409);
  h.allowCancel(); await h.api(`/integrations/bot?meetingId=${h.meeting.id}`, 'DELETE');
  assert.equal(h.sessions.get(h.meeting.id).status, 'stopping');
});

/** Pending intent written by an interrupted process is cancelled on the next startup. */
test('server restart reconciles an ambiguous recording start before serving requests', async t => {
  const h = await harness(t); await h.stop();
  const requestId = 'interrupted-attempt'; h.sessions.set(h.meeting.id, { requestId, status: 'joining' });
  await mkdir(join(h.data, 'bot-starts'), { recursive: true });
  await writeFile(join(h.data, 'bot-starts', `${h.meeting.id}.json`), JSON.stringify({ meetingId: h.meeting.id, requestId }));
  await h.start(); assert.equal(h.sessions.get(h.meeting.id).status, 'stopping');
  await assert.rejects(access(join(h.data, 'bot-starts', `${h.meeting.id}.json`)));
});

/** No guest may start when its durable reservation cannot be saved. */
test('failure to persist a start reservation prevents contacting the runner', async t => {
  const h = await harness(t);
  await writeFile(join(h.data, 'bot-starts'), 'Fixture storage obstruction');
  await h.startBot(500);
  assert.equal(h.calls.length, 0);
});

/** An offline runner returning later is reconciled without requiring another user action. */
test('background recovery retries cancellation when the runner returns', { timeout: 12000 }, async t => {
  const h = await harness(t, 'cancel-offline'); await h.startBot(503); h.allowCancel();
  for (let attempt = 0; attempt < 70; attempt++) {
    if (h.sessions.get(h.meeting.id).status === 'stopping') return;
    await pause(100);
  }
  assert.fail('Pending recording cancellation was not retried');
});
