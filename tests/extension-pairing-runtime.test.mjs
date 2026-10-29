import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  bundle,
  pairingBundle,
  library,
  endpoint,
  reply,
} from './extension-test-helpers.mjs';
const requestId = '11111111-1111-4111-8111-111111111111';
async function harness() {
  const h = fixture();
  h.api = await bundle(h, pairingBundle);
  h.approved = false;
  h.fetch = async (url, options) => {
    if (url.endsWith('/hello'))
      return reply({ service: 'echo-voice', protocolVersion: 2, libraryId: library });
    if (url.endsWith('/pair'))
      return reply({
        requestId,
        status: h.approved ? 'approved' : 'pending',
        libraryId: library,
        expiresAt: Math.floor(h.now / 1000) + 600,
      });
    if (url.endsWith('/claim')) {
      if (h.loseClaim) {
        h.loseClaim = false;
        throw Error('lost response');
      }
      return reply(
        h.approved
          ? { status: 'approved', libraryId: library, credential: 'a'.repeat(64) }
          : { status: 'pending' },
      );
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return reply({
      libraryId: library,
      appVersion: '0.1.0',
      storageProtectionVersion: 1,
      recordingReceiptVersion: 1,
    });
  };
  return h;
}
test('parallel discovery respects saved, announced, then candidate priority and 700ms timeout', async () => {
  const h = await harness();
  await h.api.saveLink({ state: 'connected', endpoint, libraryId: library, credential: 'a' });
  h.local.echoOrigin = 'http://localhost:3222';
  const pending = [];
  h.fetch = (url, options) => new Promise((resolve) => pending.push({ url, options, resolve }));
  const discovery = h.api.discover();
  while (pending.length < 9) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending[0].url, endpoint + '/extension/v1/hello');
  assert.match(pending[1].url, /3222/);
  assert.match(pending[2].url, /127.0.0.1:3000/);
  for (const item of pending.slice(1))
    item.resolve(reply({ service: 'echo-voice', protocolVersion: 2, libraryId: library }));
  pending[0].resolve(reply({ service: 'other' }));
  assert.equal(await discovery, h.local.echoOrigin);
  h.fetch = (_url, options) =>
    new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(Error('timeout'))),
    );
  const keepAlive = setTimeout(() => {}, 1000);
  const started = Date.now();
  await assert.rejects(h.api.discover(), /Echo isn't running/);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started >= 650 && Date.now() - started < 1500);
});
test('pair → sealed waiting → approved claim → connected; owned approval tab closes', async () => {
  const h = await harness();
  await h.api.beginPairing(endpoint);
  assert.equal((await h.api.readLink()).state, 'waiting');
  assert.ok(!JSON.stringify(h.local).includes((await h.api.readLink()).claimSecret));
  assert.equal(h.tabs[0].url, `${endpoint}/extension-connect.html#request=${requestId}`);
  h.approved = true;
  assert.equal((await h.api.resumePairing()).phase, 'connected');
  assert.deepEqual(h.removed, [1]);
  assert.equal((await h.api.readLink()).credential, 'a'.repeat(64));
});
test('lost claim reply retries identical body; existing approval tab remains open', async () => {
  const h = await harness();
  h.tabs.push({ id: 20, url: `${endpoint}/extension-connect.html#request=${requestId}` });
  await h.api.beginPairing(endpoint);
  h.approved = true;
  h.loseClaim = true;
  await assert.rejects(h.api.resumePairing());
  assert.equal((await h.api.readLink()).state, 'waiting');
  await h.api.resumePairing();
  const bodies = h.calls
    .filter(([url]) => url.endsWith('/claim'))
    .map(([, options]) => options.body);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(h.removed, []);
});
test('lost reservation response reuses durable claim secret on retry', async () => {
  const h = await harness();
  const wire = h.fetch;
  let first = true;
  h.fetch = async (...args) => {
    if (args[0].endsWith('/pair') && first) {
      first = false;
      throw Error('lost');
    }
    return wire(...args);
  };
  await assert.rejects(h.api.beginPairing(endpoint));
  await h.api.beginPairing();
  const bodies = h.calls
    .filter(([url]) => url.endsWith('/pair'))
    .map(([, options]) => options.body);
  assert.equal(bodies[0], bodies[1]);
});
test('expiry returns none with notice; cancel uses idempotent DELETE', async () => {
  const h = await harness();
  await h.api.beginPairing(endpoint);
  h.now += 601000;
  assert.equal((await h.api.resumePairing()).phase, 'none');
  assert.match((await h.api.pairingView()).notice, /expired/);
  await h.api.beginPairing(endpoint);
  await h.api.cancelPairing();
  await h.api.cancelPairing();
  assert.ok(
    h.calls.some(
      ([url, options]) => url.endsWith('/pair/' + requestId) && options.method === 'DELETE',
    ),
  );
});
test('401 on any authenticated call clears credential and records revoked state', async () => {
  const h = await harness();
  h.approved = true;
  await h.api.beginPairing(endpoint);
  const wire = h.fetch;
  h.fetch = (...args) =>
    args[0].endsWith('/hello') ? wire(...args) : Promise.resolve(reply({}, 401));
  assert.equal((await h.api.connectionStatus()).status, 'revoked');
  assert.equal((await h.api.readLink()).state, 'none');
  assert.equal(h.local.revoked, true);
  await h.api.saveLink({ state: 'connected', endpoint, libraryId: library, credential: 'b' });
  await assert.rejects(h.api.jsonRequest(endpoint, '/recordings/a', {}, 'b'));
  assert.equal((await h.api.connectionStatus()).status, 'revoked');
});
test('ECHO messages require verified loopback sender origin; approval claims immediately; intent skips tab', async () => {
  const h = await harness();
  const sender = { origin: endpoint };
  const present = await h.api.externalMessage(
    { type: 'ECHO_PRESENT', origin: 'https://evil.invalid' },
    sender,
  );
  assert.equal(present.installed, true);
  assert.equal(h.local.echoOrigin, endpoint);
  for (const origin of ['https://evil.invalid', 'http://localhost.evil.invalid', undefined])
    await assert.rejects(h.api.externalMessage({ type: 'ECHO_PRESENT' }, { origin }));
  const wire = h.fetch;
  h.fetch = async () => reply({ service: 'impostor' });
  await assert.rejects(h.api.externalMessage({ type: 'ECHO_PRESENT' }, sender));
  h.fetch = wire;
  await h.api.beginPairing(endpoint);
  h.approved = true;
  await h.api.externalMessage({ type: 'ECHO_APPROVED', requestId }, sender);
  assert.equal((await h.api.readLink()).state, 'connected');
  await h.api.saveLink({ state: 'none' });
  h.tabs.length = 0;
  assert.equal(
    (await h.api.externalMessage({ type: 'ECHO_CONNECT', intent: 'c'.repeat(64) }, sender)).ok,
    true,
  );
  assert.equal(h.tabs.length, 0);
  assert.equal(
    JSON.parse(h.calls.filter(([url]) => url.endsWith('/pair')).at(-1)[1].body).intent,
    'c'.repeat(64),
  );
});
test('Echo-initiated connect replaces a waiting request; approval from another Echo origin claims', async () => {
  const h = await harness();
  let connected = 0;
  h.api.whenConnected(() => connected++);
  await h.api.beginPairing(endpoint);
  h.approved = true;
  const sender = { origin: 'http://localhost:3222' };
  const reply = await h.api.externalMessage(
    { type: 'ECHO_CONNECT', intent: 'd'.repeat(64) },
    sender,
  );
  assert.equal(reply.ok, true);
  const pairs = h.calls
    .filter(([url]) => url.endsWith('/pair'))
    .map(([, options]) => JSON.parse(options.body));
  assert.equal(pairs.length, 2);
  assert.equal(pairs[1].intent, 'd'.repeat(64));
  assert.notEqual(pairs[0].claimSecret, pairs[1].claimSecret);
  assert.equal(connected, 1);
  await h.api.saveLink({ state: 'none' });
  h.approved = false;
  await h.api.beginPairing(endpoint);
  h.approved = true;
  await h.api.externalMessage({ type: 'ECHO_APPROVED', requestId }, sender);
  assert.equal((await h.api.readLink()).endpoint, endpoint);
  assert.equal(connected, 2);
});
test('cancel ends waiting locally even when Echo is offline; malformed Echo messages are rejected', async () => {
  const h = await harness();
  await h.api.beginPairing(endpoint);
  const wire = h.fetch;
  h.fetch = async () => {
    throw new Error('offline');
  };
  assert.equal((await h.api.cancelPairing()).phase, 'none');
  h.fetch = wire;
  for (const message of [
    undefined,
    { type: 'ECHO_CONNECT', intent: 'not-hex' },
    { type: 'ECHO_APPROVED' },
    { type: 'PAIR_BEGIN' },
  ])
    await assert.rejects(h.api.externalMessage(message, { origin: endpoint }), /Unsupported/);
  await assert.rejects(
    h.api.externalMessage({ type: 'ECHO_PRESENT' }, { origin: endpoint, id: 'other-extension' }),
    /Unverified/,
  );
});
