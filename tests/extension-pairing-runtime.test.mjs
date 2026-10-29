import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { access } from 'node:fs/promises';
const library = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
let built;
async function harness(shared) {
  if (!built)
    built = await build({
      entryPoints: ['extension/src/pairing.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'api',
      plugins: [
        {
          name: 'journal',
          setup(b) {
            b.onResolve(
              { filter: /^\.\/(storage|device-secrets|settings|vault-manager)$/ },
              (args) => ({ path: args.path.slice(2), namespace: 'mock' }),
            );
            b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
              contents:
                args.path === 'device-secrets'
                  ? 'export const sealSecret=async value=>value;export const openSecret=async value=>value;'
                  : args.path === 'settings'
                    ? 'export const settings=async()=>globalThis.fixtureStore.settings;export const saveSettings=async patch=>globalThis.fixtureStore.settings={...globalThis.fixtureStore.settings,...(typeof patch==="function"?patch(globalThis.fixtureStore.settings):patch)};'
                    : args.path === 'vault-manager'
                      ? 'export const lockEchoIdentity=async()=>{};'
                      : 'export const allRecordings=async()=>globalThis.rows; export const recording=async()=>undefined;export const getChunk=async()=>undefined;export const updateRecording=async()=>undefined;export const retainReceiptAndRemovePCM=async()=>undefined;',
            }));
          },
        },
      ],
    });
  const store = shared ?? {
    settings: {
      installationId: crypto.randomUUID(),
      endpoint: 'http://localhost:3000',
      activeLibraryId: null,
      pairs: {},
      enabledProviders: [],
      micGranted: false,
    },
  };
  const h = {
    store,
    rows: [],
    calls: [],
    tabs: [],
    now: Date.now(),
    approved: false,
    committed: false,
    loseActivation: false,
    failBegin: 0,
    failTab: false,
    loseBegin: false,
    loseClaim: false,
    legacy: false,
    activationDenied: 0,
    manualError: 0,
    claimWait: null,
    activationWait: null,
  };
  const context = {
    fixtureStore: store,
    URL,
    Headers,
    Response,
    AbortSignal,
    Uint8Array,
    crypto: webcrypto,
    Date: class extends Date {
      static now() {
        return h.now;
      }
    },
    rows: h.rows,
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (key) =>
            typeof key === 'string'
              ? { [key]: structuredClone(store[key]) }
              : structuredClone(store),
          set: async (value) => Object.assign(store, structuredClone(value)),
          remove: async (key) => {
            delete store[key];
          },
        },
      },
      tabs: {
        create: async (value) => {
          if (h.failTab) throw Error('tab');
          h.tabs.push(value);
        },
      },
    },
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : {};
      h.calls.push({ url, body });
      const attempt = store.pairingAttempt?.encrypted;
      if (url.endsWith('/request')) {
        if (h.manualError) return new Response('{}', { status: h.manualError });
        if (h.legacy && body.deferredActivation !== undefined)
          return new Response('{}', { status: 400 });
        return reply({
          requestId: crypto.randomUUID(),
          libraryId: library,
          status: 'pending',
          expiresAt: Math.floor(h.now / 1000) + 300,
          ...(h.legacy ? {} : { activationRequired: true }),
        });
      }
      if (url.endsWith('/begin')) {
        if (!body.requestId) return new Response('{}', { status: h.legacy ? 404 : 400 });
        assert.equal(attempt.claimSecret, body.claimSecret, 'secret persisted before request');
        if (h.loseBegin) {
          h.loseBegin = false;
          throw Error('lost begin');
        }
        if (h.failBegin) return new Response('{}', { status: h.failBegin });
        return reply({
          requestId: body.requestId,
          libraryId: library,
          status: 'pending',
          expiresAt: Math.floor(h.now / 1000) + 300,
        });
      }
      if (url.endsWith('/claim')) {
        if (h.claimWait) await h.claimWait;
        if (h.loseClaim) {
          h.loseClaim = false;
          throw Error('lost claim');
        }
        return reply(
          h.approved
            ? {
                requestId: body.requestId,
                installationId: store.settings.installationId,
                libraryId: library,
                status: h.legacy ? 'approved' : 'prepared',
                credential: 'synthetic-prepared-token',
                activationRequired: !h.legacy,
                expiresAt: Math.floor(h.now / 1000) + 300,
              }
            : {
                requestId: body.requestId,
                installationId: store.settings.installationId,
                libraryId: library,
                status: 'pending',
              },
        );
      }
      if (url.endsWith('/activate')) {
        if (h.activationDenied) return new Response('{}', { status: h.activationDenied });
        assert.equal(attempt.phase, 'activation-sent');
        assert.equal(attempt.stagedCredential, 'synthetic-prepared-token');
        h.committed = true;
        if (h.activationWait) await h.activationWait;
        if (h.loseActivation) throw Error('lost');
        return reply({
          requestId: body.requestId,
          installationId: store.settings.installationId,
          libraryId: library,
          status: 'claimed',
          credential: 'synthetic-prepared-token',
          activationRequired: false,
        });
      }
      if (url.endsWith('/cancel')) return reply({ status: 'cancelled' });
      if (url.endsWith('/connection')) return reply({ status: 'disconnected' });
      throw Error('Unexpected path ' + url);
    },
  };
  function reply(body) {
    return new Response(JSON.stringify({ protocolVersion: 1, ...body }));
  }
  vm.runInNewContext(built.outputFiles[0].text, context);
  h.api = context.api;
  return h;
}
test('persistent pairing controller exists', async () => {
  await assert.doesNotReject(access('extension/src/pairing.ts'));
});
test('attempt is persisted before begin, concurrent Connect reuses it, and view never contains secrets', async () => {
  const h = await harness();
  const views = await Promise.all([
    h.api.beginPairing('http://localhost:3000', 'Browser'),
    h.api.beginPairing('http://localhost:3000', 'Browser'),
  ]);
  assert.equal(views[0].requestId, views[1].requestId);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/begin')).length, 1);
  assert.equal(h.tabs.length, 1);
  assert.match(h.store.pairingAttempt.encrypted.claimSecret, /^[0-9a-f]{64}$/);
  assert.equal(
    h.tabs[0].url,
    `http://localhost:3000/extension-connect.html#request=${views[0].requestId}`,
  );
  assert.ok(!JSON.stringify(views).includes(h.store.pairingAttempt.encrypted.claimSecret));
});
test('worker restart resumes approval with staged credential durable before activation', async () => {
  const h = await harness();
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  const restarted = await harness(h.store);
  restarted.approved = true;
  const view = await restarted.api.resumePairing();
  assert.equal(view.phase, 'connected');
  assert.equal(restarted.store.settings.activeLibraryId, library);
  assert.equal(restarted.tabs.length, 0);
  assert.ok(!JSON.stringify(view).includes('synthetic-prepared-token'));
});
test('lost activation acknowledgement reconciles after expiry without a second approval', async () => {
  const h = await harness();
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.approved = true;
  h.loseActivation = true;
  assert.equal((await h.api.resumePairing()).phase, 'activation-sent');
  assert.equal(h.store.settings.activeLibraryId, null);
  const restarted = await harness(h.store);
  restarted.now += 600000;
  const view = await restarted.api.resumePairing();
  assert.equal(view.phase, 'connected');
  assert.equal(restarted.store.settings.pairs[library].credential, 'synthetic-prepared-token');
  assert.equal(restarted.calls.filter((c) => c.url.endsWith('/claim')).length, 0);
});
test('unassigned and other-library pending audio require confirmation even after disconnect', async () => {
  for (const bound of [null, other]) {
    const h = await harness();
    h.rows.push({ recordingId: 'row', libraryId: bound, chunkCount: 1 });
    h.store.settings.pairs[other] = {
      libraryId: other,
      endpoint: 'http://localhost:3001',
      credential: 'old-token',
    };
    await h.api.beginPairing('http://localhost:3000', 'Browser');
    h.approved = true;
    const view = await h.api.resumePairing();
    assert.equal(view.phase, 'confirm-library');
    assert.equal(h.committed, false);
    await h.api.confirmPairingLibrary(view.requestId);
    assert.equal(h.store.settings.activeLibraryId, library);
    assert.equal(h.rows[0].libraryId, bound);
    assert.equal(h.store.settings.pairs[other].credential, 'old-token');
  }
});
test('cancel before activation preserves existing connection and cannot activate later', async () => {
  const h = await harness();
  h.store.settings.activeLibraryId = other;
  h.store.settings.pairs[other] = { credential: 'old-token' };
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  await h.api.cancelPairing();
  h.approved = true;
  assert.equal((await h.api.resumePairing()).phase, 'cancelled');
  assert.equal(h.committed, false);
  assert.equal(h.store.settings.activeLibraryId, other);
});
test('cancel after uncertain activation reconciles before revoking the new credential', async () => {
  const h = await harness();
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.approved = true;
  h.loseActivation = true;
  await h.api.resumePairing();
  assert.equal((await h.api.cancelPairing()).phase, 'activation-sent');
  assert.equal(h.store.settings.activeLibraryId, null);
  h.loseActivation = false;
  assert.equal((await h.api.resumePairing()).phase, 'cancelled');
  assert.equal(h.store.settings.activeLibraryId, null);
  assert.ok(h.calls.some((c) => c.url.endsWith('/connection')));
});
test('old server and network failure differ; failed approval tab is retryable', async () => {
  for (const code of [404, 405, 429, 503]) {
    const h = await harness();
    h.failBegin = code;
    const view = await h.api.beginPairing('http://localhost:3000', 'Browser');
    assert.equal(
      view.error,
      code === 404 || code === 405 ? 'old-server' : code === 429 ? 'rate-limited' : 'unavailable',
    );
  }
  const h = await harness();
  h.failTab = true;
  const view = await h.api.beginPairing('http://localhost:3000', 'Browser');
  assert.equal(view.error, 'tab-open-failed');
  h.failTab = false;
  await h.api.openPairingApproval(view.requestId);
  assert.equal(h.tabs.length, 1);
});
test('lost begin and claim replies resume the identical saved attempt', async () => {
  const h = await harness();
  h.loseBegin = true;
  const first = await h.api.beginPairing('http://localhost:3000', 'Browser');
  assert.equal(first.error, 'unavailable');
  const secret = h.store.pairingAttempt.encrypted.claimSecret;
  await h.api.resumePairing();
  assert.equal(h.store.pairingAttempt.encrypted.requestId, first.requestId);
  assert.equal(h.store.pairingAttempt.encrypted.claimSecret, secret);
  h.approved = true;
  h.loseClaim = true;
  assert.equal((await h.api.resumePairing()).phase, 'pending');
  assert.equal((await h.api.resumePairing()).phase, 'connected');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/begin')).length, 2);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/activate')).length, 1);
});
test('expired uncommitted attempts never restart without Connect and revoked activation never restores a credential', async () => {
  const h = await harness();
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.now += 600000;
  assert.equal((await h.api.resumePairing()).phase, 'expired');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/begin')).length, 1);
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.approved = true;
  h.loseActivation = true;
  await h.api.resumePairing();
  h.activationDenied = 403;
  h.now += 600000;
  assert.equal((await h.api.resumePairing()).phase, 'expired');
  assert.equal(h.store.settings.activeLibraryId, null);
});
test('manual pairing uses deferred activation and explicitly identifies legacy compatibility', async () => {
  for (const legacy of [false, true]) {
    const h = await harness();
    h.legacy = legacy;
    await h.api.requestManualPairing('http://localhost:3000', 'Browser', 'manual-secret');
    assert.equal(h.calls[0].body.deferredActivation, true);
    assert.equal(h.tabs.length, 0);
    h.approved = true;
    const result = await h.api.resumePairing();
    assert.equal(result.phase, 'connected');
    assert.equal(result.legacy, legacy);
    assert.equal(h.calls.filter((c) => c.url.endsWith('/activate')).length, legacy ? 0 : 1);
    assert.ok(!JSON.stringify(result).includes('manual-secret'));
  }
});
test('a manual error on a server with begin support never downgrades deferred activation', async () => {
  const h = await harness();
  h.manualError = 400;
  const view = await h.api.requestManualPairing('http://localhost:3000', 'Browser', 'bad-code');
  assert.equal(view.phase, 'beginning');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/request')).length, 1);
  assert.equal(h.calls[0].body.deferredActivation, true);
  assert.equal(h.store.settings.activeLibraryId, null);
});
test('known old-server fallback sends the old manual schema without the unsupported field', async () => {
  const h = await harness();
  h.failBegin = 404;
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.legacy = true;
  const result = await h.api.requestManualPairing('http://localhost:3000', 'Browser', 'old-code');
  assert.equal(result.phase, 'pending');
  assert.deepEqual(Object.keys(h.calls.find((c) => c.url.endsWith('/request')).body).sort(), [
    'code',
    'installationId',
    'name',
  ]);
});
test('Cancel during a delayed claim preserves the prior credential and never activates its replacement', async () => {
  const h = await harness();
  h.store.settings.activeLibraryId = library;
  h.store.settings.pairs[library] = {
    libraryId: library,
    endpoint: 'http://localhost:3000',
    credential: 'old-token',
  };
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.approved = true;
  let release;
  h.claimWait = new Promise((resolve) => {
    release = resolve;
  });
  const resume = h.api.resumePairing();
  while (!h.calls.some((c) => c.url.endsWith('/claim')))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.store.pairingAttempt.encrypted.phase, 'pending');
  const cancellation = h.api.cancelPairing();
  release();
  await Promise.all([resume, cancellation]);
  assert.equal(
    h.calls.some((c) => c.url.endsWith('/activate')),
    false,
  );
  assert.equal(h.store.settings.pairs[library].credential, 'old-token');
  assert.equal(h.store.settings.activeLibraryId, library);
  assert.equal(h.store.pairingAttempt.encrypted.phase, 'cancelled');
});
test('Cancel during an already-sent activation waits for its result then revokes it', async () => {
  const h = await harness();
  await h.api.beginPairing('http://localhost:3000', 'Browser');
  h.approved = true;
  let release;
  h.activationWait = new Promise((resolve) => {
    release = resolve;
  });
  const resume = h.api.resumePairing();
  while (!h.calls.some((c) => c.url.endsWith('/activate')))
    await new Promise((resolve) => setImmediate(resolve));
  const cancellation = h.api.cancelPairing();
  release();
  await Promise.all([resume, cancellation]);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/activate')).length, 1);
  assert.ok(h.calls.some((c) => c.url.endsWith('/connection')));
  assert.equal(h.store.settings.activeLibraryId, null);
});
