import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const built = await build({
  entryPoints: ['extension/src/vault-manager.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'vault',
  plugins: [
    {
      name: 'session-race-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(vault-db|vault-crypto|settings)$/ }, (args) => ({
          path: args.path.slice(2),
          namespace: 'mock',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: {
            'vault-db':
              'export async function readMeta(){return globalThis.fixture.descriptor};export async function writeMeta(){};export const storageLock=(id,work)=>globalThis.fixture.lock(id,work);',
            'vault-crypto':
              'export async function createVault(){};export async function recoverIdentity(){};export async function importPrivateIdentity(){await globalThis.fixture.importKey();return {}};',
            settings:
              'export async function settings(){return structuredClone(globalThis.fixture.prefs)};',
          }[args.path],
        }));
      },
    },
  ],
});
function held() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture() {
  const pair = {
    libraryId: 'library',
    credential: 'credential',
    endpoint: 'http://localhost:3000',
  };
  const f = {
    descriptor: { vaultId: 'vault' },
    prefs: { activeLibraryId: 'library', pairs: { library: pair } },
    saved: {},
    importKey: async () => {},
    beforeSet: async () => {},
    afterSet: async () => {},
    locks: new Map(),
  };
  f.lock = (id, work) => {
    const pending = (f.locks.get(id) ?? Promise.resolve()).then(work);
    f.locks.set(
      id,
      pending.catch(() => {}),
    );
    return pending;
  };
  f.body = {
    protocolVersion: 1,
    vaultId: 'vault',
    libraryId: 'library',
    privateMaterial: 'private',
  };
  f.fetch = async () => ({ ok: true, status: 200, json: async () => f.body });
  return f;
}
function worker(f) {
  const context = {
    fixture: f,
    structuredClone,
    Headers,
    URL,
    AbortSignal,
    fetch: (...args) => f.fetch(...args),
    chrome: {
      runtime: { getURL: () => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' },
      storage: {
        session: {
          setAccessLevel: async () => {},
          get: async (key) => ({ [key]: structuredClone(f.saved[key]) }),
          set: async (patch) => {
            await f.beforeSet(patch);
            Object.assign(f.saved, structuredClone(patch));
            await f.afterSet(patch);
          },
          remove: async (key) => {
            delete f.saved[key];
          },
        },
      },
    },
  };
  vm.runInNewContext(built.outputFiles[0].text, context);
  return context.vault;
}
for (const boundary of ['response JSON', 'private key import'])
  for (const invalidate of ['disconnect', 'revocation'])
    test(`late ${boundary} cannot restore identity after ${invalidate}`, async () => {
      const f = fixture();
      const api = worker(f);
      const entered = held();
      const delayed = held();
      if (boundary === 'response JSON')
        f.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => {
            entered.release();
            await delayed.promise;
            return f.body;
          },
        });
      else
        f.importKey = async () => {
          entered.release();
          await delayed.promise;
        };
      const pending = api.syncVaultWithEcho(true);
      await entered.promise;
      if (invalidate === 'disconnect') {
        f.prefs.pairs = {};
        await api.lockVault();
      } else await api.lockEchoIdentity();
      assert.equal((await api.vaultStatus()).unlocked, false);
      delayed.release();
      await pending;
      assert.equal((await api.vaultStatus()).unlocked, false);
      const restarted = worker(f);
      f.fetch = async () => ({ ok: false, status: 401 });
      await restarted.syncVaultWithEcho(true);
      assert.equal((await restarted.vaultStatus()).unlocked, false);
    });
test('lock waits for a pending storage publication then removes it, including across worker contexts', async () => {
  const f = fixture();
  const oldWorker = worker(f);
  const entered = held();
  const delayed = held();
  f.beforeSet = async (patch) => {
    if (patch.recordingVaultIdentity) {
      entered.release();
      await delayed.promise;
    }
  };
  const pending = oldWorker.syncVaultWithEcho(true);
  await entered.promise;
  const restarted = worker(f);
  const locking = restarted.lockVault();
  delayed.release();
  await Promise.all([pending, locking]);
  assert.equal((await restarted.vaultStatus()).unlocked, false);
  assert.equal(f.saved.recordingVaultIdentity, null);
});
test('invalidation generation survives worker restart and rejects a previous context response', async () => {
  const f = fixture();
  const oldWorker = worker(f);
  const entered = held();
  const delayed = held();
  f.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      entered.release();
      await delayed.promise;
      return f.body;
    },
  });
  const pending = oldWorker.syncVaultWithEcho(true);
  await entered.promise;
  const restarted = worker(f);
  await restarted.lockVault();
  delayed.release();
  await pending;
  assert.equal((await restarted.vaultStatus()).unlocked, false);
  assert.ok(f.saved.recordingVaultGeneration > 0);
});
test('pair replacement while the key imports cannot publish the previous pair identity', async () => {
  const f = fixture();
  const api = worker(f);
  const entered = held();
  const delayed = held();
  f.importKey = async () => {
    entered.release();
    await delayed.promise;
  };
  const pending = api.syncVaultWithEcho(true);
  await entered.promise;
  f.prefs.pairs.library.credential = 'new credential';
  delayed.release();
  await pending;
  assert.equal((await api.vaultStatus()).unlocked, false);
});

for (const invalidate of ['disconnect', 'revocation'])
  test(`worker termination after ${invalidate} commits no old Echo identity with the new generation`, async () => {
    const f = fixture();
    f.saved.recordingVaultIdentity = {
      vaultId: 'vault',
      privateMaterial: 'private',
      source: 'echo',
      libraryId: 'library',
    };
    const api = worker(f);
    let writes = 0;
    f.beforeSet = async (patch) => {
      writes++;
      assert.equal(patch.recordingVaultGeneration, 1);
      assert.equal(patch.recordingVaultIdentity, null);
    };
    f.afterSet = async () => {
      throw new Error('worker terminated after atomic session commit');
    };
    await assert.rejects(
      invalidate === 'disconnect' ? api.lockVault() : api.lockEchoIdentity(),
      /worker terminated/,
    );
    assert.equal(writes, 1);
    assert.equal(f.saved.recordingVaultGeneration, 1);
    assert.equal((await worker(f).vaultStatus()).unlocked, false);
  });
test('revocation preserves an explicitly recovered identity in the same invalidation commit', async () => {
  const f = fixture();
  const identity = { vaultId: 'vault', privateMaterial: 'private', source: 'recovery' };
  f.saved.recordingVaultIdentity = identity;
  await worker(f).lockEchoIdentity();
  assert.deepEqual(f.saved.recordingVaultIdentity, identity);
  assert.equal(f.saved.recordingVaultGeneration, 1);
});
