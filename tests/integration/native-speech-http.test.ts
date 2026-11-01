import { bufferChunk } from '../helpers/assertions.ts';
import type { Readable } from 'node:stream';
import type { OutgoingHttpHeaders } from 'node:http';
import { object } from '../helpers/assertions.ts';
import { text } from '../helpers/assertions.ts';
import { defined } from '../helpers/assertions.ts';
import { serverPort } from '../../scripts/guards.ts';
/** HTTP request/lifecycle fixtures only: sparse model files never qualify real inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stopTestServer, removeTestDirectory } from '../helpers/server-cleanup.ts';

const project = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(
  process.env['ECHO_TEST_BINARY'] ?? path.join(project, 'target/debug/echo-server'),
);
const MODEL = 'onnx-community/whisper-large-v3';
const CHECKPOINT = 'Xenova/whisper-large-v3';
const REVISION = '67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0';
const MAX_PCM = 7200 * 16000 * 4;
function jobPath(id: string, operation = 'transcribe') {
  return `/api/speech/jobs?${new URLSearchParams({ jobId: id, modelId: MODEL, operation, language: 'en' })}`;
}
async function until<T>(
  work: () => T | Promise<T>,
  message: string | Error | undefined,
  milliseconds = 5000,
) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const value = await work();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}
async function fixture(t: test.TestContext, { native = true } = {}) {
  await access(binary);
  await mkdir(path.join(project, 'tmp'), { recursive: true });
  const root = await mkdtemp(path.join(project, 'tmp/native-speech-http-'));
  let child: ChildProcessByStdio<null, Readable, Readable>,
    exited: Promise<unknown[]>,
    logs = '';
  t.after(async () => {
    await stopTestServer(child);
    await removeTestDirectory(root);
  });
  for (const folder of ['scripts', 'web', 'public', 'tmp']) await mkdir(path.join(root, folder));
  for (const name of ['whisper-alignment.ts', 'speech-errors.ts', 'guards.ts'])
    await copyFile(path.join(project, 'web', name), path.join(root, 'web', name));
  await copyFile(
    path.join(project, 'scripts/native-speech.ts'),
    path.join(root, 'scripts/native-speech.ts'),
  );
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(
    path.join(root, 'public/index.html'),
    '<!doctype html><title>HTTP fixture</title>',
  );
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = serverPort(listener);
  await new Promise((resolve) => listener.close(resolve));
  const env = {
    PATH: native ? process.env['PATH'] : '',
    HOME: process.env['HOME'],
    TMPDIR: path.join(root, 'tmp'),
    ECHO_RESOURCE_ROOT: root,
    ECHO_TEST_MODE: '1',
    ECHO_TEST_STORAGE_KEY: Buffer.alloc(32, 42).toString('base64'),
    ECHO_BIND: `127.0.0.1:${port}`,
    ECHO_DATA_DIR: path.join(root, 'data'),
  };
  function start(extra = {}, timeout = 0) {
    const process = spawn(binary, [], {
      cwd: root,
      timeout,
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.on('error', () => {});
    for (const stream of [process.stdout, process.stderr])
      stream.on('data', (streamValue: unknown) => {
        const bytes = bufferChunk(streamValue);
        logs = (logs + String(bytes)).slice(-8192);
      });
    return process;
  }
  function connect(method: string, route: string, headers = {}) {
    const request = httpRequest({ hostname: '127.0.0.1', port, method, path: route, headers });
    const response = new Promise<{ status: number | undefined; body: unknown }>(
      (resolve, reject) => {
        request.once('error', reject);
        request.once('response', (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (streamValue: unknown) => {
            const chunk = text(streamValue);
            body += chunk;
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              resolve({ status: response.statusCode, body: JSON.parse(body) as unknown });
            } catch (error) {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original API/runtime rejection value and its identity for existing error handling.
              reject(error);
            }
          });
        });
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error('HTTP fixture request timed out')));
    // Aborted uploads intentionally reject before anyone awaits their response.
    void response.catch(() => {});
    return { request, response };
  }
  async function request(method: string, route: string, body?: string | Buffer, headers = {}) {
    if (body !== undefined) headers = { 'Content-Length': Buffer.byteLength(body), ...headers };
    const pending = connect(method, route, headers);
    pending.request.end(body);
    return pending.response;
  }
  async function rejectHeaders(route: string, headers?: OutgoingHttpHeaders) {
    // Keep the declared body unsent so an early rejection cannot race a body write.
    const pending = connect('POST', text(route), { Expect: '100-continue', ...headers });
    pending.request.flushHeaders();
    try {
      return await pending.response;
    } finally {
      pending.request.destroy();
    }
  }
  async function ready() {
    await until(async () => {
      assert.equal(child.exitCode, null, logs);
      try {
        return object(await request('GET', '/api/health'))['status'] === 200;
      } catch {
        return false;
      }
    }, `Isolated native HTTP server did not start: ${logs}`);
  }
  child = start();
  exited = once(child, 'exit');
  await ready();
  async function waitJob(id: unknown, state: string) {
    return until(async () => {
      const response = await request('GET', `/api/speech/jobs/${String(id)}`);
      return (
        object(response)['status'] === 200 &&
        object(object(response)['body'])['state'] === state &&
        object(response)['body']
      );
    }, `Job did not reach ${state}`);
  }
  return {
    root,
    request,
    rejectHeaders,
    waitJob,
    start,
    async pendingUpload(id: string, operation = 'transcribe') {
      const headers =
        operation === 'download'
          ? { 'Transfer-Encoding': 'chunked' }
          : { 'Content-Type': 'application/octet-stream', 'Content-Length': 64 };
      const pending = connect('POST', jobPath(id, operation), headers);
      pending.request.flushHeaders();
      if (operation === 'transcribe') pending.request.write(Buffer.alloc(4));
      await waitJob(id, 'queued');
      return pending;
    },
    async idleClean() {
      await until(async () => {
        const state = object(await request('GET', '/api/speech'))['body'];
        const leftovers = (await readdir(path.join(root, 'tmp'))).filter((name) =>
          name.startsWith('native-speech-'),
        );
        return object(state)['activeJob'] === null && leftovers.length === 0;
      }, 'Owned job/upload did not release its slot and spool');
    },
    async restartAfterCrash() {
      child.kill('SIGKILL');
      await exited;
      child = start();
      exited = once(child, 'exit');
      await ready();
    },
    async seedProtocolFixture() {
      const cache = path.join(root, 'data/models/native-large-v3');
      const model = path.join(cache, CHECKPOINT, REVISION);
      await mkdir(path.join(model, 'onnx'), { recursive: true });
      const files: { path: string; size: number }[] = [];
      for (const [name, size] of [
        ['encoder_model_quantized.onnx', 645260435],
        ['decoder_model_merged_quantized.onnx', 915059840],
      ] satisfies [string, number][]) {
        const file = `onnx/${name}`;
        const handle = await open(path.join(model, file), 'w');
        try {
          await handle.truncate(defined(size));
        } finally {
          await handle.close();
        }
        files.push({ path: `${CHECKPOINT}/${REVISION}/${file}`, size });
      }
      for (const name of [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'preprocessor_config.json',
        'generation_config.json',
      ]) {
        await writeFile(path.join(model, name), '{}');
        files.push({ path: `${CHECKPOINT}/${REVISION}/${name}`, size: 2 });
      }
      await writeFile(
        path.join(cache, 'ready.json'),
        JSON.stringify({
          version: 1,
          modelId: MODEL,
          checkpoint: CHECKPOINT,
          revision: REVISION,
          forwardVerified: true,
          files,
        }),
      );
    },
  };
}

void test('native speech HTTP request and lifecycle boundaries', { timeout: 60000 }, async (t) => {
  const server = await fixture(t);
  assert.equal(
    object(object(await server.request('GET', '/api/speech'))['body'])['available'],
    true,
    'Install native dependencies and Node.js 22+',
  );
  await server.seedProtocolFixture();
  await t.test('cancel before POST fences late starts', async () => {
    const id = randomUUID();
    assert.equal(object(await server.request('DELETE', `/api/speech/jobs/${id}`))['status'], 200);
    const response = await server.request('POST', jobPath(id, 'download'));
    assert.equal(object(response)['status'], 409);
    assert.match(text(object(object(response)['body'])['error']), /cancelled/);
    await server.idleClean();
  });
  await t.test('oversized declared PCM is rejected before receiving audio', async () => {
    const response = await server.rejectHeaders(jobPath(randomUUID()), {
      'Content-Type': 'application/octet-stream',
      'Content-Length': MAX_PCM + 4,
    });
    assert.equal(object(response)['status'], 413);
    assert.match(text(object(object(response)['body'])['error']), /two hours/);
    await server.idleClean();
  });
  await t.test('malformed PCM length and content type are rejected', async () => {
    assert.equal(
      object(
        await server.request('POST', jobPath(randomUUID()), Buffer.from('123'), {
          'Content-Type': 'application/octet-stream',
        }),
      )['status'],
      400,
    );
    assert.equal(
      object(
        await server.request('POST', jobPath(randomUUID()), Buffer.from('1234'), {
          'Content-Type': 'application/json',
        }),
      )['status'],
      415,
    );
    await server.idleClean();
  });
  await t.test('actual helper rejects non-finite PCM before loading models', async () => {
    const id = randomUUID(),
      pcm = Buffer.alloc(4);
    pcm.writeFloatLE(NaN);
    assert.equal(
      object(
        await server.request('POST', jobPath(id), pcm, {
          'Content-Type': 'application/octet-stream',
        }),
      )['status'],
      202,
    );
    const job = await server.waitJob(id, 'failed');
    assert.match(text(object(job)['error']), /non-finite/);
    assert.equal('result' in job, false);
    await server.idleClean();
  });
  await t.test('cancelling an upload prevents child start and releases capacity', async () => {
    const id = randomUUID(),
      pending = await server.pendingUpload(id);
    try {
      assert.equal(
        object(await server.request('POST', jobPath(randomUUID(), 'download')))['status'],
        409,
      );
      assert.equal(object(await server.request('DELETE', `/api/speech/jobs/${id}`))['status'], 200);
      assert.equal(object(await pending.response)['status'], 409);
    } finally {
      pending.request.destroy();
    }
    assert.equal('result' in (await server.waitJob(id, 'cancelled')), false);
    await server.idleClean();
  });
  await t.test('aborting an upload releases its slot and owned spool', async () => {
    const id = randomUUID(),
      pending = await server.pendingUpload(id);
    pending.request.destroy();
    assert.equal('result' in (await server.waitJob(id, 'failed')), false);
    await server.idleClean();
  });
  await t.test('pending chunked download bodies are cancellable', async () => {
    const id = randomUUID(),
      pending = await server.pendingUpload(id, 'download');
    try {
      assert.equal(object(await server.request('DELETE', `/api/speech/jobs/${id}`))['status'], 200);
      assert.equal(object(await pending.response)['status'], 409);
    } finally {
      pending.request.destroy();
    }
    await server.waitJob(id, 'cancelled');
    await server.idleClean();
  });
  await t.test('downloads reject declared audio before reservation', async () => {
    const response = await server.rejectHeaders(jobPath(randomUUID(), 'download'), {
      'Content-Length': 64,
    });
    assert.equal(object(response)['status'], 400);
    assert.match(text(object(object(response)['body'])['error']), /does not accept an audio body/);
    await server.idleClean();
  });
  await t.test('crash recovery cleans only the locked library spool', async () => {
    const id = randomUUID(),
      pending = await server.pendingUpload(id);
    const data = await realpath(path.join(server.root, 'data'));
    const identity = createHash('sha256').update(data).digest('hex');
    const orphan = path.join(server.root, 'tmp', `native-speech-${identity}`, id);
    const otherData = path.join(server.root, 'other-library');
    await mkdir(otherData);
    const otherId = createHash('sha256')
      .update(await realpath(otherData))
      .digest('hex');
    const otherNamespace = path.join(server.root, 'tmp', `native-speech-${otherId}`);
    const otherJob = path.join(otherNamespace, randomUUID());
    await mkdir(otherJob, { recursive: true });
    await writeFile(path.join(otherJob, 'audio.f32'), 'other live library');
    try {
      await until(async () => {
        try {
          return (await readFile(path.join(orphan, 'audio.enc')))
            .subarray(0, 8)
            .equals(Buffer.from('ECHOPCM1'));
        } catch {
          return false;
        }
      }, 'Encrypted upload spool was not written');
      await assert.rejects(access(path.join(orphan, 'request.json')), { code: 'ENOENT' });
      const contender = server.start({ ECHO_BIND: '127.0.0.1:0' }, 5000);
      const [code] = (await once(contender, 'exit')) as unknown[];
      assert.notEqual(code, null, 'Competing server must fail the lock before its timeout');
      assert.notEqual(code, 0);
      await access(orphan);
      await server.restartAfterCrash();
      await assert.rejects(access(orphan), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(otherJob, 'audio.f32'), 'utf8'), 'other live library');
      assert.equal(
        object(object(await server.request('GET', '/api/speech'))['body'])['activeJob'],
        null,
      );
    } finally {
      pending.request.destroy();
      await rm(otherNamespace, { recursive: true, force: true });
      await rm(otherData, { recursive: true, force: true });
    }
    await server.idleClean();
  });
});

void test(
  'unavailable native runtime gives actionable HTTP errors and releases reservation',
  { timeout: 15000 },
  async (t) => {
    const server = await fixture(t, { native: false });
    const status = object(await server.request('GET', '/api/speech'))['body'];
    assert.equal(object(status)['available'], false);
    assert.equal(object(status)['ready'], false);
    assert.match(text(object(status)['detail']), /Node.js 22/);
    assert.equal(
      object(await server.request('POST', jobPath(randomUUID(), 'download')))['status'],
      503,
    );
    await server.idleClean();
  },
);
