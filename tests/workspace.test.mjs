import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
const notes = await import('../web/notes.js');
const files = await import('../web/files.js');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('notes pulls retain streamed progress across page visits and reuse one active request', async () => {
  let stream, requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  };
  const pull = notes.downloadModel('qwen2.5:3b');
  try {
  assert.equal(notes.downloadModel('other-model'), pull);
  await turn();
  stream.enqueue(new TextEncoder().encode('{"status":"pulling weights","completed":57,"total":100}\n'));
  await turn();
  assert.deepEqual(notes.getDownloadState(), { status: 'downloading', model: 'qwen2.5:3b', progress: 57, detail: 'pulling weights' });
  const snapshot = notes.getDownloadState(); snapshot.progress = 100;
  assert.equal(notes.getDownloadState().progress, 57);
  stream.enqueue(new TextEncoder().encode('{"status":"suc'));
  stream.enqueue(new TextEncoder().encode('cess"}'));
  stream.close();
  await pull;
  assert.equal(requests, 1);
  assert.equal(notes.getDownloadState().status, 'completed');
  } finally {
    try { stream?.close(); } catch { /* The successful path already closes it. */ }
    await pull.catch(() => {});
  }
});

test('notes pulls reject truncated streams without success and retain failure for returning pages', async () => {
  globalThis.fetch = async () => new Response('{"status":"pulling weights","completed":1,"total":2}\n');
  await assert.rejects(notes.downloadModel('qwen2.5:3b'), /before Ollama confirmed success/);
  assert.equal(notes.getDownloadState().status, 'failed');
  assert.match(notes.getDownloadState().error, /Retry the download/);
  globalThis.fetch = async () => new Response('{"status":"success"}\n');
  await notes.downloadModel('qwen2.5:3b');
  assert.equal(notes.getDownloadState().status, 'completed');
});

test('notes pulls preserve server errors and streamed Ollama errors', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Ollama is not reachable.' }), { status: 503 });
  await assert.rejects(notes.downloadModel('qwen2.5:3b'), /Ollama is not reachable/);
  globalThis.fetch = async () => new Response('{"error":"Disk is full"}\n');
  await assert.rejects(notes.downloadModel('qwen2.5:3b'), /Disk is full/);
  assert.equal(notes.getDownloadState().error, 'Disk is full');
});

function picker() {
  const inputs = [];
  class Input extends EventTarget {
    style = {}; files = []; isConnected = false;
    setAttribute() {}
    click() { assert.ok(this.isConnected, 'the native picker requires an attached input'); }
    remove() { this.isConnected = false; }
  }
  globalThis.document = {
    createElement() { const input = new Input(); inputs.push(input); return input; },
    body: { appendChild(input) { input.isConnected = true; } },
  };
  return inputs;
}

test('JSON picker stays connected through selection and removes the node after successful parsing', async () => {
  const inputs = picker();
  const selected = files.chooseJsonFile();
  const input = inputs[0];
  assert.ok(input.isConnected);
  input.files = [{ name: 'backup.json', size: 20, text: async () => '{"format":"echo-voice-web"}' }];
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(await selected, { name: 'backup.json', value: { format: 'echo-voice-web' } });
  assert.equal(input.isConnected, false);
});

test('JSON picker cancels cleanly and removes oversized or invalid files', async () => {
  const inputs = picker();
  const cancelled = files.chooseJsonFile(); inputs[0].dispatchEvent(new Event('cancel'));
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.equal(inputs[0].isConnected, false);
  const invalid = files.chooseJsonFile();
  inputs[1].files = [{ name: 'bad.json', size: 5, text: async () => 'bad' }];
  inputs[1].dispatchEvent(new Event('change'));
  assert.match((await invalid).error, /not valid JSON/);
  assert.equal(inputs[1].isConnected, false);
  const oversized = files.chooseJsonFile();
  inputs[2].files = [{ name: 'large.json', size: 257 * 1024 * 1024, text: async () => { throw new Error('must not read oversized files'); } }];
  inputs[2].dispatchEvent(new Event('change'));
  assert.match((await oversized).error, /smaller than 256 MB/);
  assert.equal(inputs[2].isConnected, false);
});

test('JSON picker removes its temporary input when the document leaves', async () => {
  const inputs = picker();
  const selected = files.chooseJsonFile(); window.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(await selected, { cancelled: true });
  assert.equal(inputs[0].isConnected, false);
});
