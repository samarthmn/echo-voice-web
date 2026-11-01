import { bufferChunk } from '../helpers/assertions.ts';
import { text } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import { serverPort } from '../../scripts/guards.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = process.cwd();
const binary = path.resolve(process.env['ECHO_TEST_BINARY'] || 'target/debug/echo-server');
const clientId = 'synthetic-web-client.apps.googleusercontent.com',
  secret = 'synthetic-web-secret';
const delay = (ms: number | undefined) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t: test.TestContext, { configured = true } = {}) {
  await mkdir(path.join(project, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(project, 'tmp/google-web-'));
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = serverPort(socket);
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`,
    origin = `http://localhost:${port}`;
  const redirect = `${origin}/api/integrations/google/callback`,
    data = path.join(root, 'library');
  await writeFile(
    path.join(root, 'echo.config.json'),
    JSON.stringify({
      bind: `127.0.0.1:${port}`,
      dataDir: data,
      googleRedirectUri: redirect,
    }),
  );
  // This isolated source folder contains no personal .env, accounts or recording library.
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TMPDIR: root,
      ECHO_TEST_MODE: '1',
      ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
      ECHO_DATA_DIR: data,
      ECHO_BIND: `127.0.0.1:${port}`,
      ECHO_CONFIG_FILE: path.join(root, 'echo.config.json'),
      GOOGLE_CLIENT_ID: configured ? clientId : '',
      GOOGLE_CLIENT_SECRET: configured ? secret : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '',
    failure: Error | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (streamValue: unknown) => {
      const bytes = bufferChunk(streamValue);
      logs = (logs + String(bytes)).slice(-8192);
    });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped: Promise<unknown[]> = once(child, 'exit');
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error('Synthetic source server exited');
    try {
      const response = await fetch(`${base}/api/storage`);
      if (response.ok) {
        assert.equal(object((await response.json()) as unknown)['path'], data);
        return { root, data, base, origin, redirect, logs: () => logs };
      }
    } catch {
      /* The isolated server may still be starting; retry until the readiness deadline. */
    }
    await delay(30);
  }
  throw new Error('Synthetic source server did not start');
}
const get = (base: string, route: string, headers = {}) =>
  fetch(base + route, { redirect: 'manual', headers, signal: AbortSignal.timeout(3000) });
void test('web OAuth remains optional and reports maintainer configuration without exposing secrets', async (t) => {
  const s = await fixture(t, { configured: false });
  const status = object((await (await get(s.base, '/api/integrations/status')).json()) as unknown);
  assert.equal(object(status['google'])['mode'], 'source');
  assert.equal(object(status['google'])['configured'], false);
  assert.equal(object(status['google'])['connected'], false);
  const response = await get(s.origin, '/api/integrations/google/connect', {
    'Sec-Fetch-Mode': 'navigate',
  });
  assert.equal(response.status, 503);
  assert.match(text(object((await response.json()) as unknown)['error']), /not configured/);
  assert.ok(!s.logs().includes(secret));
});
void test('configured web OAuth uses its existing callback with PKCE and keeps denial and cancellation local', async (t) => {
  const s = await fixture(t);
  const status = object((await (await get(s.base, '/api/integrations/status')).json()) as unknown);
  assert.equal(object(status['google'])['configured'], true);
  assert.equal(object(status['google'])['mode'], 'source');
  assert.ok(!JSON.stringify(status).includes(secret));
  const canonical = await get(s.base, '/api/integrations/google/connect', {
    'Sec-Fetch-Mode': 'navigate',
  });
  assert.equal(canonical.status, 303);
  assert.equal(canonical.headers.get('location'), `${s.origin}/api/integrations/google/connect`);
  const started = await get(s.origin, '/api/integrations/google/connect', {
    'Sec-Fetch-Mode': 'navigate',
  });
  assert.equal(started.status, 303);
  const authorization = new URL(defined(started.headers.get('location')));
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('redirect_uri'), s.redirect);
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    authorization.searchParams.get('scope'),
    'openid email https://www.googleapis.com/auth/calendar.readonly',
  );
  assert.ok(!authorization.searchParams.has('client_secret'));
  assert.ok(!authorization.searchParams.has('code_verifier'));
  assert.ok(!authorization.href.includes(secret));
  const cookie = defined(
    started.headers.getSetCookie().find((value) => !value.includes('Max-Age=0')),
  ).split(';')[0];
  const state = authorization.searchParams.get('state');
  assert.ok(state);
  assert.ok(!defined(cookie).includes(state));
  const forged = await get(
    s.origin,
    `/api/integrations/google/callback?state=wrong&error=access_denied`,
    { Cookie: cookie, 'Sec-Fetch-Mode': 'navigate' },
  );
  assert.equal(forged.status, 400);
  const denied = await get(
    s.origin,
    `/api/integrations/google/callback?state=${encodeURIComponent(state)}&error=access_denied`,
    { Cookie: cookie, 'Sec-Fetch-Mode': 'navigate' },
  );
  assert.equal(denied.status, 303);
  assert.ok(defined(denied.headers.get('location')).startsWith(`${s.origin}/?calendar=error`));
  assert.ok(!defined(denied.headers.get('location')).includes(secret));
  await get(s.origin, '/api/integrations/google/connect', { 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(
    object(
      object((await (await get(s.base, '/api/integrations/status')).json()) as unknown)['google'],
    )['pending'],
    true,
  );
  const cancelled = await fetch(`${s.base}/api/integrations/google/cancel`, {
    method: 'POST',
    headers: { Origin: s.base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(cancelled.status, 200);
  assert.equal(object((await cancelled.json()) as unknown)['cancelled'], true);
  assert.equal(
    object(
      object((await (await get(s.base, '/api/integrations/status')).json()) as unknown)['google'],
    )['pending'],
    false,
  );
  await assert.rejects(
    readFile(path.join(s.data, 'credentials/google.json')),
    (error) => object(error)['code'] === 'ENOENT',
  );
  assert.ok(!s.logs().includes(secret));
});
