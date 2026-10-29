import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension } from '../scripts/build-extension.mjs';
const project = process.cwd();
const scratch = path.join(project, 'tmp', 'extension-protection');
const executablePath =
  process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const bundle = await build({
  stdin: {
    contents:
      "import * as journal from './extension/src/storage.ts';import * as settings from './extension/src/settings.ts';globalThis.testAPI={journal,settings};",
    resolveDir: project,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'chrome120',
});
const row = (id) => ({
  recordingId: id,
  title: 'Confidential budget planning',
  provider: 'meet',
  meetingUrl: 'https://meet.google.com/abc-defg-hij?secret=meeting',
  consent: true,
  liveTranscription: true,
  sampleRate: 16000,
  channels: 1,
  createdAt: '2026-10-09T00:00:00Z',
  libraryId: null,
  chunkCount: 0,
  totalFrames: 0,
  captureState: 'recording',
  transferState: 'saved-local',
  gaps: [],
  interrupted: false,
});
async function launch(output, profile) {
  return chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    args: [`--disable-extensions-except=${output.outdir}`, `--load-extension=${output.outdir}`],
    env: { ...process.env, TMPDIR: path.join(project, 'tmp') },
  });
}
async function testPage(context, output) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${output.extensionId}/protection-test.html`);
  await page.evaluate(bundle.outputFiles[0].text);
  return page;
}
async function dump(page) {
  return page.evaluate(async () => {
    const db = await testAPI.journal.database();
    const get = (store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    return {
      rows: await get('recordings'),
      chunks: await get('chunks'),
      meta: await get('meta'),
      local: await chrome.storage.local.get(null),
    };
  });
}
test('device-key journal survives restart, records offline, and never stores plaintext metadata or credentials', async () => {
  await mkdir(scratch, { recursive: true });
  const output = await buildExtension({ outdir: path.join(scratch, 'extension') });
  await writeFile(
    path.join(output.outdir, 'protection-test.html'),
    '<!doctype html><title>Protection test</title>',
  );
  const profile = path.join(scratch, 'profile');
  let context;
  try {
    context = await launch(output, profile);
    let page = await testPage(context, output);
    const id = crypto.randomUUID();
    await page.evaluate(async (value) => {
      await testAPI.journal.createRecording(value);
      await Promise.all([
        testAPI.journal.appendChunk(value.recordingId, 0, new Uint8Array([1, 2, 3, 4]).buffer),
        testAPI.journal.updateRecording(value.recordingId, {
          title: 'Confidential renamed meeting',
        }),
      ]);
      await testAPI.journal.updateRecording(value.recordingId, { captureState: 'stopped' });
      await testAPI.settings.saveLink({
        state: 'connected',
        libraryId: '22222222-2222-4222-8222-222222222222',
        credential: 'secret-auth-credential',
        endpoint: 'http://localhost:1',
      });
    }, row(id));
    const raw = await dump(page);
    assert.equal(raw.rows[0].version, 3);
    assert.equal(raw.rows[0].keyContext, 'device');
    assert.equal(raw.rows[0].title, undefined);
    assert.equal(raw.rows[0].chunkCount, 1);
    assert.equal(raw.chunks[0].pcm, undefined);
    assert.ok(!JSON.stringify(raw).includes('Confidential'));
    assert.ok(!JSON.stringify(raw).includes('secret=meeting'));
    assert.ok(!JSON.stringify(raw).includes('secret-auth-credential'));
    const tampered = await page.evaluate(async (id) => {
      const db = await testAPI.journal.database();
      const original = await new Promise((resolve) => {
        const request = db.transaction('recordings').objectStore('recordings').get(id);
        request.onsuccess = () => resolve(request.result);
      });
      const put = (value) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('recordings', 'readwrite');
          tx.objectStore('recordings').put(value);
          tx.oncomplete = resolve;
          tx.onerror = reject;
        });
      await put({ ...original, libraryId: 'another-library' });
      const error = await testAPI.journal.recording(id).then(
        () => null,
        (error) => error.message,
      );
      await put(original);
      return { error, retained: !!(await testAPI.journal.getChunk(id, 0)) };
    }, id);
    assert.match(tampered.error, /integrity check/);
    assert.equal(tampered.retained, true);
    await context.close();
    context = await launch(output, profile);
    page = await testPage(context, output);
    const restarted = await page.evaluate(
      async (id) => ({
        title: (await testAPI.journal.recording(id)).title,
        listed: (await testAPI.journal.allRecordings())[0],
        pcm: [...new Uint8Array((await testAPI.journal.getChunk(id, 0)).pcm)],
        credential: (await testAPI.settings.readLink()).credential,
      }),
      id,
    );
    assert.equal(restarted.title, 'Confidential renamed meeting');
    assert.equal(restarted.listed.title, '', 'lists never decrypt metadata');
    assert.equal(restarted.listed.locked, false);
    assert.deepEqual(restarted.pcm, [1, 2, 3, 4]);
    assert.equal(restarted.credential, 'secret-auth-credential');
    const offline = crypto.randomUUID();
    await page.evaluate(async (value) => {
      await testAPI.journal.createRecording(value);
      await testAPI.journal.appendChunk(value.recordingId, 0, new Uint8Array([5, 6]).buffer);
      await testAPI.journal.updateRecording(value.recordingId, { captureState: 'stopped' });
    }, row(offline));
    const exported = await page.evaluate(
      async (ids) => {
        const result = [];
        for (const id of ids) {
          const parts = [];
          for await (const part of testAPI.journal.exportParts(id))
            parts.push([...new Uint8Array(await part.blob.arrayBuffer())]);
          result.push(parts);
        }
        return result;
      },
      [id, offline],
    );
    assert.deepEqual(exported[0][0].slice(44), [1, 2, 3, 4]);
    assert.deepEqual(exported[1][0].slice(44), [5, 6]);
    const corrupted = await page.evaluate(async (id) => {
      const db = await testAPI.journal.database();
      const current = await new Promise((resolve) => {
        const request = db.transaction('chunks').objectStore('chunks').get([id, 0]);
        request.onsuccess = () => resolve(request.result);
      });
      const changed = structuredClone(current);
      changed.encrypted.ciphertext =
        (changed.encrypted.ciphertext[0] === 'A' ? 'B' : 'A') +
        changed.encrypted.ciphertext.slice(1);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(changed);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      const error = await testAPI.journal.getChunk(id, 0).then(
        () => null,
        (error) => error.name,
      );
      return { error, count: (await testAPI.journal.recording(id)).chunkCount };
    }, id);
    assert.equal(corrupted.error, 'OperationError');
    assert.equal(corrupted.count, 1);
    assert.equal((await dump(page)).chunks.length, 2);
    await page.goto(`chrome-extension://${output.extensionId}/setup.html`);
    const safe = await page.evaluate(async () => {
      const state = (await chrome.runtime.sendMessage({ type: 'STATE' })).value;
      return JSON.stringify(state);
    });
    assert.ok(!safe.includes('secret-auth-credential'));
    assert.ok(!safe.includes('Confidential'));
  } finally {
    await context?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});
test('v1 plaintext migration is resumable after asynchronous encryption failure and retains every committed chunk', async () => {
  const root = path.join(project, 'tmp', 'extension-protection-migration');
  await mkdir(root, { recursive: true });
  const output = await buildExtension({ outdir: path.join(root, 'extension') });
  await writeFile(
    path.join(output.outdir, 'protection-test.html'),
    '<!doctype html><title>Migration test</title>',
  );
  let context;
  try {
    context = await launch(output, path.join(root, 'profile'));
    const page = await testPage(context, output);
    const id = crypto.randomUUID();
    await page.evaluate(async (value) => {
      const pcm = new Uint8Array([10, 20, 30, 40]).buffer;
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pcm)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const db = await testAPI.journal.database();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite');
        tx.objectStore('recordings').put({
          ...value,
          chunkCount: 2,
          totalFrames: 4,
          captureState: 'stopped',
        });
        for (let sequence = 0; sequence < 2; sequence++)
          tx.objectStore('chunks').put({
            recordingId: value.recordingId,
            sequence,
            frames: 2,
            pcm,
            sha256,
          });
        tx.objectStore('meta').put({ key: 'pendingBytes', value: 8 });
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
    }, row(id));
    const failure = await page.evaluate(async () => {
      const original = crypto.subtle.encrypt.bind(crypto.subtle);
      let calls = 0;
      crypto.subtle.encrypt = async (...args) => {
        if (++calls === 4) throw new Error('injected encryption failure');
        return original(...args);
      };
      try {
        return await testAPI.journal.migrateRecordings().then(
          () => null,
          (error) => error.message,
        );
      } finally {
        crypto.subtle.encrypt = original;
      }
    });
    assert.match(failure, /injected encryption failure/);
    const partial = await dump(page);
    assert.equal(partial.chunks.length, 2);
    assert.equal(partial.rows[0].migrating, true);
    assert.equal(partial.rows[0].title, undefined);
    assert.ok(partial.chunks.some((chunk) => chunk.pcm));
    await page.evaluate(() => testAPI.journal.migrateRecordings());
    const done = await dump(page);
    assert.equal(done.rows[0].migrating, undefined);
    assert.ok(done.chunks.every((chunk) => chunk.encrypted && !chunk.pcm));
    const exported = await page.evaluate(async (id) => {
      const pieces = [];
      for await (const part of testAPI.journal.exportParts(id))
        pieces.push([...new Uint8Array(await part.blob.arrayBuffer())].slice(44));
      return pieces;
    }, id);
    assert.deepEqual(exported, [[10, 20, 30, 40, 10, 20, 30, 40]]);
  } finally {
    await context?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
