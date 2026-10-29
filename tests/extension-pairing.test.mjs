import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';

const project = resolve(import.meta.dirname, '..');
const scratch = join(project, 'tmp');
const executable = resolve(
  process.env.ECHO_TEST_BINARY || join(project, 'target/debug/echo-server'),
);
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherOrigin = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attempt = (overrides = {}) => ({
  requestId: randomUUID(),
  installationId: randomUUID(),
  name: 'My browser',
  claimSecret: randomBytes(32).toString('hex'),
  ...overrides,
});

async function isolated(t) {
  await access(executable);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'pairing-http-'));
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
      }),
    ]);
    clearTimeout(timer);
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    child = spawn(executable, [], {
      cwd: project,
      env: {
        ...process.env,
        ECHO_TEST_MODE: '1',
        ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
        TMPDIR: scratch,
        ECHO_DATA_DIR: directory,
        ECHO_BIND: `127.0.0.1:${port}`,
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure;
    let logs = '';
    child.on('error', (error) => {
      failure = error;
    });
    for (const output of [child.stdout, child.stderr])
      output.on('data', (bytes) => {
        logs = (logs + bytes).slice(-4000);
      });
    for (let i = 0; i < 80; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Isolated server exited: ${logs}`);
      try {
        const response = await fetch(`${base}/api/storage`, { signal: AbortSignal.timeout(200) });
        if (response.ok) {
          assert.equal((await response.json()).path, directory);
          return;
        }
      } catch {}
      await delay(50);
    }
    throw new Error(`Isolated pairing server did not start: ${logs}`);
  }
  async function request(
    path,
    {
      method = 'POST',
      body,
      status = 200,
      requestOrigin = path.startsWith('/api/') ? base : origin,
      credential,
      headers = {},
    } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: requestOrigin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const value = await response.json().catch(() => ({}));
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
    if (path.startsWith('/extension/')) assert.equal(value.protocolVersion, 1);
    return value;
  }
  const begin = (a, options = {}) =>
    request('/extension/v1/pairing/begin', { body: a, ...options });
  const claim = (a, options = {}) =>
    request('/extension/v1/pairing/claim', {
      body: { requestId: a.requestId, installationId: a.installationId, code: a.claimSecret },
      ...options,
    });
  const activate = (a, libraryId, options = {}) =>
    request('/extension/v1/pairing/activate', {
      body: {
        requestId: a.requestId,
        installationId: a.installationId,
        claimSecret: a.claimSecret,
        libraryId,
      },
      ...options,
    });
  const cancel = (a, options = {}) =>
    request('/extension/v1/pairing/cancel', {
      body: {
        requestId: a.requestId,
        installationId: a.installationId,
        claimSecret: a.claimSecret,
      },
      ...options,
    });
  const approve = (a, options = {}) =>
    request(`/api/extensions/requests/${a.requestId}/approve`, { body: {}, ...options });
  const connection = (credential, status = 200) =>
    request('/extension/v1/connection', { method: 'GET', credential, status });
  async function manual(installationId = randomUUID(), deferredActivation = false) {
    const code = await request('/api/extensions/pairing', { body: {} });
    const pending = await request('/extension/v1/pairing/request', {
      body: {
        code: code.code,
        installationId,
        name: 'Manual browser',
        ...(deferredActivation ? { deferredActivation: true } : {}),
      },
    });
    const a = { ...pending, installationId, claimSecret: code.code };
    await approve(a);
    return { a, receipt: await claim(a) };
  }
  function sql(statement, params = []) {
    return JSON.parse(
      execFileSync(
        'cargo',
        ['run', '--quiet', '--locked', '-p', 'echo-server', '--example', 'storage-fixture'],
        {
          cwd: project,
          input: JSON.stringify({
            path: join(directory, 'workspace.sqlite'),
            sql: statement,
            params,
          }),
          env: {
            ...process.env,
            TMPDIR: scratch,
            ECHO_TEST_MODE: '1',
            ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
          },
          encoding: 'utf8',
        },
      ),
    );
  }
  await start();
  return {
    base,
    request,
    begin,
    claim,
    activate,
    cancel,
    approve,
    connection,
    manual,
    sql,
    stop,
    start,
  };
}

test('browser_pair_requires_explicit_approval', async (t) => {
  const s = await isolated(t);
  const a = attempt({ name: '<script>unverified</script>' });
  const pending = await s.begin(a);
  assert.equal(pending.status, 'pending');
  assert.equal(
    (await s.request('/api/extensions/connections', { method: 'GET' })).connections.length,
    0,
  );
  assert.equal(
    (await s.request('/api/extensions/connections', { method: 'GET' })).requests.length,
    0,
  );
  const metadata = await s.request(`/api/extensions/requests/${a.requestId}`, { method: 'GET' });
  assert.equal(metadata.name, a.name);
  assert.equal(metadata.origin, origin);
  assert.equal(metadata.status, 'pending');
  for (const key of ['claimSecret', 'code', 'code_hash', 'credential', 'credential_hash'])
    assert.equal(metadata[key], undefined);
  assert.equal((await s.claim(a)).status, 'pending');
  await s.activate(a, pending.libraryId, { status: 409 });
  await s.approve(a);
  await s.approve(a);
  const prepared = await s.claim(a);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.activationRequired, true);
  await s.connection(prepared.credential, 401);
  assert.equal((await s.claim(a)).credential, prepared.credential);
  const activated = await s.activate(a, pending.libraryId);
  assert.equal(activated.status, 'claimed');
  assert.equal(activated.credential, prepared.credential);
  await s.connection(prepared.credential);
  assert.equal((await s.cancel(a)).status, 'claimed');
  await s.connection(prepared.credential);
});

test('browser vault keys are scoped, durable, immutable and inaccessible after revocation', async (t) => {
  const s = await isolated(t);
  const first = await s.manual();
  const credential = first.receipt.credential;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const vaultId = randomUUID();
  const value = {
    vaultId,
    privateMaterial: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    descriptor: {
      version: 1,
      vaultId,
      publicKey: Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
      ]).toString('base64'),
      recovery: {
        version: 1,
        nonce: randomBytes(12).toString('base64'),
        ciphertext: randomBytes(154).toString('base64'),
      },
    },
  };
  const route = `/extension/v1/vault?vaultId=${vaultId}`;
  await s.request(route, { method: 'GET', credential, status: 404 });
  const saved = await s.request('/extension/v1/vault', { method: 'PUT', credential, body: value });
  assert.equal(saved.registered, true);
  assert.equal(saved.privateMaterial, undefined);
  await s.request('/extension/v1/vault', { method: 'PUT', credential, body: value });
  const loaded = await s.request(route, { method: 'GET', credential });
  assert.equal(loaded.privateMaterial, value.privateMaterial);
  assert.deepEqual(loaded.descriptor, value.descriptor);
  await s.request(route, { method: 'GET', status: 401 });
  await s.request(route, { method: 'GET', credential, requestOrigin: otherOrigin, status: 401 });
  const second = await s.manual();
  await s.request(route, { method: 'GET', credential: second.receipt.credential, status: 404 });
  await s.request('/extension/v1/vault', {
    method: 'PUT',
    credential,
    body: { ...value, privateMaterial: randomBytes(100).toString('base64') },
    status: 409,
  });
  await s.request(`/extension/v1/vault?vaultId=${randomUUID()}`, {
    method: 'GET',
    credential,
    status: 409,
  });
  await s.stop();
  await s.start();
  assert.equal(
    (await s.request(route, { method: 'GET', credential })).privateMaterial,
    value.privateMaterial,
  );
  await s.request(`/api/extensions/connections/${first.a.installationId}`, { method: 'DELETE' });
  await s.request(route, { method: 'GET', credential, status: 401 });
});

test('begin_retry_preserves_expiry_and_rejects_conflicts_and_bad_bindings', async (t) => {
  const s = await isolated(t);
  const a = attempt();
  const first = await s.begin(a);
  assert.deepEqual(await s.begin(a), first);
  await s.begin({ ...a, name: 'Changed name' }, { status: 409 });
  await s.begin({ ...a, claimSecret: 'b'.repeat(64) }, { status: 409 });
  await s.begin(a, { status: 409, requestOrigin: otherOrigin });
  await s.begin(attempt({ claimSecret: 'A'.repeat(64) }), { status: 400 });
  await s.begin(attempt({ requestId: 'not-a-uuid' }), { status: 400 });
  await s.begin(attempt({ claimSecret: '' }), { status: 400 });
  await s.begin(attempt({ name: 'a'.repeat(101) }), { status: 400 });
  await s.begin({ ...attempt(), returnUrl: 'https://example.com' }, { status: 400 });
  await s.begin(attempt(), { status: 403, requestOrigin: 'https://hostile.example' });
  await s.begin(attempt(), {
    status: 413,
    headers: { 'X-Test': 'bounded-body' },
    body: { ...attempt(), name: 'a'.repeat(300000) },
  });
  await s.claim({ ...a, claimSecret: '0'.repeat(64) }, { status: 403 });
  await s.claim({ ...a, installationId: randomUUID() }, { status: 403 });
  await s.claim(a, { status: 403, requestOrigin: otherOrigin });
  await s.cancel(a, { status: 403, requestOrigin: otherOrigin });
  await s.request('/extension/v1/pairing/cancel', {
    body: { requestId: a.requestId, installationId: a.installationId },
    status: 400,
  });
  await s.approve(a);
  await s.claim(a);
  await s.activate(a, first.libraryId, { status: 403, requestOrigin: otherOrigin });
  await s.activate({ ...a, claimSecret: '0'.repeat(64) }, first.libraryId, { status: 403 });
  await s.activate(a, randomUUID(), { status: 409 });
  assert.equal((await s.cancel(a)).status, 'cancelled');
  assert.equal((await s.cancel(a)).status, 'cancelled');
  assert.equal((await s.claim(a)).status, 'cancelled');
  await s.activate(a, first.libraryId, { status: 409 });
});

test('lost_claim_then_cancel_preserves_previous_connection_and_manual_compatibility', async (t) => {
  const s = await isolated(t);
  const previous = await s.manual();
  assert.equal(previous.receipt.status, 'approved');
  await s.connection(previous.receipt.credential);
  const a = attempt({ installationId: previous.a.installationId });
  await s.begin(a);
  await s.approve(a);
  const prepared = await s.claim(a);
  await s.connection(previous.receipt.credential);
  await s.connection(prepared.credential, 401);
  await s.cancel(a);
  await s.connection(previous.receipt.credential);
  await s.connection(prepared.credential, 401);
  const staged = await s.manual(previous.a.installationId, true);
  assert.equal(staged.receipt.status, 'prepared');
  await s.connection(previous.receipt.credential);
  await s.connection(staged.receipt.credential, 401);
  await s.activate(staged.a, staged.receipt.libraryId);
  await s.connection(previous.receipt.credential, 401);
  await s.connection(staged.receipt.credential);
});

test('committed_activation_reconciles_after_expiry_restart_and_cleanup', async (t) => {
  const s = await isolated(t);
  const a = attempt();
  const pending = await s.begin(a);
  await s.approve(a);
  const prepared = await s.claim(a);
  await s.activate(a, pending.libraryId);
  await s.stop();
  s.sql('UPDATE extension_pairing SET expires=1 WHERE request_id=?', [a.requestId]);
  await s.start();
  await s.request('/api/extensions/pairing', { body: {} });
  assert.equal((await s.activate(a, pending.libraryId)).credential, prepared.credential);
  assert.equal((await s.claim(a)).credential, prepared.credential);
  await s.connection(prepared.credential);
  const rows = s.sql('SELECT code_hash,credential_hash FROM extension_pairing WHERE request_id=?', [
    a.requestId,
  ]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0][0], a.claimSecret);
  assert.notEqual(rows[0][1], prepared.credential);
});

test('restart_preserves_pending_approval_and_prepared_receipt_without_activating', async (t) => {
  const s = await isolated(t);
  const previous = await s.manual();
  const a = attempt({ installationId: previous.a.installationId });
  const pending = await s.begin(a);
  await s.stop();
  await s.start();
  assert.equal((await s.begin(a)).expiresAt, pending.expiresAt);
  assert.equal((await s.claim(a)).status, 'pending');
  await s.approve(a);
  const prepared = await s.claim(a);
  await s.stop();
  await s.start();
  assert.equal((await s.claim(a)).credential, prepared.credential);
  await s.connection(previous.receipt.credential);
  await s.connection(prepared.credential, 401);
  await s.activate(a, pending.libraryId);
  await s.connection(prepared.credential);
});

test('stale_claim_cannot_restore_revoked_connection', async (t) => {
  const s = await isolated(t);
  const a = attempt();
  const pending = await s.begin(a);
  await s.approve(a);
  const old = await s.claim(a);
  await s.activate(a, pending.libraryId);
  const replacement = await s.manual(a.installationId, true);
  await s.activate(replacement.a, replacement.receipt.libraryId);
  await s.activate(a, pending.libraryId, { status: 403 });
  await s.claim(a, { status: 403 });
  await s.connection(old.credential, 401);
  await s.request(`/api/extensions/connections/${a.installationId}`, { method: 'DELETE' });
  await s.activate(replacement.a, replacement.receipt.libraryId, { status: 403 });
  await s.claim(replacement.a, { status: 403 });
  await s.connection(replacement.receipt.credential, 401);
});

test('uncommitted_expiry_rejection_and_disconnect_never_activate_a_prepared_credential', async (t) => {
  const s = await isolated(t);
  const old = await s.manual();
  const a = attempt({ installationId: old.a.installationId });
  const pending = await s.begin(a);
  await s.approve(a);
  const prepared = await s.claim(a);
  await s.stop();
  s.sql('UPDATE extension_pairing SET expires=1 WHERE request_id=?', [a.requestId]);
  await s.start();
  await s.activate(a, pending.libraryId, { status: 403 });
  await s.claim(a, { status: 403 });
  await s.connection(old.receipt.credential);
  const rejected = attempt();
  await s.begin(rejected);
  await s.request(`/api/extensions/requests/${rejected.requestId}/reject`, { body: {} });
  assert.equal(
    (await s.request(`/api/extensions/requests/${rejected.requestId}/reject`, { body: {} })).status,
    'rejected',
  );
  assert.equal((await s.claim(rejected)).status, 'rejected');
  await s.approve(rejected, { status: 409 });
  const revoked = attempt({ installationId: old.a.installationId });
  const current = await s.begin(revoked);
  await s.approve(revoked);
  await s.claim(revoked);
  await s.request('/extension/v1/connection', {
    method: 'DELETE',
    credential: old.receipt.credential,
  });
  await s.activate(revoked, current.libraryId, { status: 409 });
  await s.connection(prepared.credential, 401);
});

test('ordinary_api_still_rejects_extension_origin', async (t) => {
  const s = await isolated(t);
  const a = attempt();
  await s.begin(a);
  for (const path of ['/api/meetings', `/api/extensions/requests/${a.requestId}`])
    await s.request(path, { method: 'GET', requestOrigin: origin, status: 403 });
  for (const action of ['approve', 'reject'])
    await s.request(`/api/extensions/requests/${a.requestId}/${action}`, {
      requestOrigin: origin,
      body: {},
      status: 403,
    });
  assert.equal((await s.claim(a)).status, 'pending');
});

test('reservations_enforce_per_origin_browser_and_global_limits_without_eviction', async (t) => {
  const s = await isolated(t);
  const rows = [];
  for (const letter of ['a', 'b', 'c', 'd']) {
    const requestOrigin = `chrome-extension://${letter.repeat(32)}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const a = attempt();
        const response = await fetch(`${s.base}/extension/v1/pairing/begin`, {
          method: 'POST',
          headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
          body: JSON.stringify(a),
        });
        return { a, status: response.status, receipt: await response.json() };
      }),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 429]);
    // Four reservations from each origin fill the browser budget. Terminal ones still count.
    for (const { a, status, receipt } of results) {
      if (status === 429) continue;
      rows.push({ a, receipt, requestOrigin });
      if (rows.length % 4 === 1) await s.cancel(a, { requestOrigin });
      if (rows.length % 4 === 2)
        await s.request(`/api/extensions/requests/${a.requestId}/reject`, { body: {} });
    }
  }
  await s.begin(attempt(), {
    requestOrigin: 'chrome-extension://eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    status: 429,
  });
  assert.equal((await s.begin(rows[1].a)).expiresAt, rows[1].receipt.expiresAt);
  for (let i = 0; i < 4; i++) await s.request('/api/extensions/pairing', { body: {} });
  await s.request('/api/extensions/pairing', { body: {}, status: 429 });
  assert.equal(s.sql('SELECT count(*) FROM extension_pairing')[0][0], 20);
});
