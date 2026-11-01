import type { Recording } from '../../extension/src/core.ts';
import type { Page } from '@playwright/test';
import { array } from '../helpers/assertions.ts';
import { object } from '../helpers/assertions.ts';
import { text } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExtension } from '../../scripts/build-extension.ts';
const project = process.cwd();
const scratch = path.join(project, 'tmp', 'extension-protection');
const executablePath =
  process.env['CHROMIUM_PATH'] || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
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
const row = (id: string): Recording => ({
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
async function launch(
  output: { outdir: unknown; extensionId?: string; version?: unknown },
  profile: string,
) {
  return chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    args: [`--disable-extensions-except=${output.outdir}`, `--load-extension=${output.outdir}`],
    env: { ...process.env, TMPDIR: path.join(project, 'tmp') },
  });
}
async function testPage(
  context: BrowserContext,
  output: { outdir?: string; extensionId: unknown; version?: unknown },
) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${output.extensionId}/protection-test.html`);
  await page.evaluate(defined(bundle.outputFiles[0]).text);
  return page;
}
async function dump(page: Page) {
  return page.evaluate(async () => {
    const db = await testAPI.journal.database();
    const get = (store: string) =>
      new Promise<unknown[]>((resolve, reject) => {
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
  let context: import('@playwright/test').BrowserContext | undefined;
  try {
    context = await launch(output, profile);
    let page = await testPage(context, output);
    const id = crypto.randomUUID();
    await page.evaluate(async (value: Recording) => {
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }

      await testAPI.journal.createRecording(value);
      await Promise.all([
        testAPI.journal.appendChunk(
          text(value.recordingId),
          0,
          new Uint8Array([1, 2, 3, 4]).buffer,
        ),
        testAPI.journal.updateRecording(text(value.recordingId), {
          title: 'Confidential renamed meeting',
        }),
      ]);
      await testAPI.journal.updateRecording(text(value.recordingId), { captureState: 'stopped' });
      await testAPI.settings.saveLink({
        state: 'connected',
        libraryId: '22222222-2222-4222-8222-222222222222',
        credential: 'secret-auth-credential',
        endpoint: 'http://localhost:1',
      });
    }, row(id));
    const raw = await dump(page);
    assert.equal(object(object(object(raw)['rows'])[0])['version'], 3);
    assert.equal(object(object(object(raw)['rows'])[0])['keyContext'], 'device');
    assert.equal(object(object(object(raw)['rows'])[0])['title'], undefined);
    assert.equal(object(object(object(raw)['rows'])[0])['chunkCount'], 1);
    assert.equal(object(object(object(raw)['chunks'])[0])['pcm'], undefined);
    assert.ok(!JSON.stringify(raw).includes('Confidential'));
    assert.ok(!JSON.stringify(raw).includes('secret=meeting'));
    assert.ok(!JSON.stringify(raw).includes('secret-auth-credential'));
    const tampered = await page.evaluate(async (id: string) => {
      function object(v: unknown): Record<string, unknown> {
        if (v === null || typeof v !== 'object') throw new Error('Expected object');
        return v as Record<string, unknown>;
      }

      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }

      const db = await testAPI.journal.database();
      const original = await new Promise<unknown>((resolve) => {
        const request = db.transaction('recordings').objectStore('recordings').get(id);
        request.onsuccess = () => resolve(request.result);
      });
      const put = (value: unknown) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('recordings', 'readwrite');
          tx.objectStore('recordings').put(value);
          tx.oncomplete = resolve;
          tx.onerror = reject;
        });
      await put({ ...object(original), libraryId: 'another-library' });
      const error = await testAPI.journal.recording(text(id)).then(
        () => null,
        (error: { message: unknown }) => error.message,
      );
      await put(original);
      return { error, retained: !!(await testAPI.journal.getChunk(text(id), 0)) };
    }, id);
    assert.match(text(tampered.error), /integrity check/);
    assert.equal(tampered.retained, true);
    await context.close();
    context = await launch(output, profile);
    page = await testPage(context, output);
    const restarted = await page.evaluate(async (id: string) => {
      function defined<T>(v: T): NonNullable<T> {
        if (v === undefined || v === null) throw new Error('Expected fixture value to be present.');
        return v;
      }
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }
      return {
        title: defined(await testAPI.journal.recording(text(id))).title,
        listed: (await testAPI.journal.allRecordings())[0],
        pcm: [...new Uint8Array(defined(await testAPI.journal.getChunk(text(id), 0)).pcm)],
        credential: await testAPI.settings.readLink().then((link) => {
          if (link.state !== 'connected') throw new Error('Expected connected link');
          return link.credential;
        }),
      };
    }, id);
    assert.equal(restarted.title, 'Confidential renamed meeting');
    assert.equal(defined(restarted.listed).title, '', 'lists never decrypt metadata');
    assert.ok(!('locked' in defined(restarted.listed)));
    assert.deepEqual(restarted.pcm, [1, 2, 3, 4]);
    assert.equal(restarted.credential, 'secret-auth-credential');
    const offline = crypto.randomUUID();
    await page.evaluate(async (value: Recording) => {
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }

      await testAPI.journal.createRecording(value);
      await testAPI.journal.appendChunk(text(value.recordingId), 0, new Uint8Array([5, 6]).buffer);
      await testAPI.journal.updateRecording(text(value.recordingId), { captureState: 'stopped' });
    }, row(offline));
    const exported = await page.evaluate(
      async (ids: string[]) => {
        const result: number[][][] = [];
        for (const id of ids) {
          const parts: number[][] = [];
          for await (const part of testAPI.journal.exportParts(id))
            parts.push([...new Uint8Array(await part.blob.arrayBuffer())]);
          result.push(parts);
        }
        return result;
      },
      [id, offline],
    );
    assert.deepEqual(defined(defined(exported[0])[0]).slice(44), [1, 2, 3, 4]);
    assert.deepEqual(defined(defined(exported[1])[0]).slice(44), [5, 6]);
    const corrupted = await page.evaluate(async (id: string) => {
      function text(v: unknown): string {
        if (typeof v !== 'string') throw new Error('Expected text');
        return v;
      }
      function object(v: unknown): Record<string, unknown> {
        if (v === null || typeof v !== 'object') throw new Error('Expected object');
        return v as Record<string, unknown>;
      }

      function defined<T>(value: T): NonNullable<T> {
        if (value === undefined || value === null)
          throw new Error('Expected fixture value to be present.');
        return value;
      }

      const db = await testAPI.journal.database();
      const current = await new Promise<unknown>((resolve) => {
        const request = db.transaction('chunks').objectStore('chunks').get([id, 0]);
        request.onsuccess = () => resolve(request.result);
      });
      const changed = structuredClone(current);
      const encrypted = object(object(changed)['encrypted']);
      const ciphertext = text(encrypted['ciphertext']);
      encrypted['ciphertext'] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put(changed);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      const error = await testAPI.journal.getChunk(text(id), 0).then(
        () => null,
        (error: { name: unknown }) => error.name,
      );
      return { error, count: defined(await testAPI.journal.recording(text(id))).chunkCount };
    }, id);
    assert.equal(corrupted.error, 'OperationError');
    assert.equal(corrupted.count, 1);
    assert.equal(array(object(await dump(page))['chunks']).length, 2);
    await page.goto(`chrome-extension://${output.extensionId}/setup.html`);
    const safe = await page.evaluate(async () => {
      function object(v: unknown): Record<string, unknown> {
        if (v === null || typeof v !== 'object') throw new Error('Expected object');
        return v as Record<string, unknown>;
      }

      const state = object((await chrome.runtime.sendMessage({ type: 'STATE' })) as unknown)[
        'value'
      ];
      return JSON.stringify(state);
    });
    assert.ok(!safe.includes('secret-auth-credential'));
    assert.ok(!safe.includes('Confidential'));
  } finally {
    await context?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
});
