/** Fixed, local CPU speech helper. Rust owns the private request file and stdin lease. */
import { readFile, writeFile, stat, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { correctWhisperAlignment, validatedWhisperWords } from '../web/whisper-alignment.js';

export const MODEL_ID = 'onnx-community/whisper-large-v3';
export const CHECKPOINT = 'Xenova/whisper-large-v3';
export const REVISION = '67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0';
export const WEIGHTS = {
  'encoder_model_quantized.onnx': 645260435,
  'decoder_model_merged_quantized.onnx': 915059840,
};
const REQUIRED_CONFIGS = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json'];
// This pinned Xenova export does not contain the original Large V3 alignment heads.
// Restore the original Large V3 metadata without changing generation or weights:
// https://huggingface.co/openai/whisper-large-v3/blob/06f233fe06e710322aca913c1bc4249a0d71fce1/generation_config.json
const LARGE_V3_ALIGNMENT_HEADS = [[7, 0], [10, 17], [12, 18], [13, 12], [16, 1], [17, 14], [19, 11], [21, 4], [24, 1], [25, 6]];

export function correctPinnedAlignment(model) {
  correctWhisperAlignment(model, LARGE_V3_ALIGNMENT_HEADS);
}

export const LANGUAGES = { en: 'english', es: 'spanish', fr: 'french', de: 'german', hi: 'hindi', ja: 'japanese', pt: 'portuguese', zh: 'chinese' };
const MAX_SAMPLES = 7200 * 16000;
const modelRoot = cache => path.join(cache, CHECKPOINT, REVISION);

async function cacheEntry(cache, relative) {
  const root = await lstat(cache);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Native model cache must be a private regular directory.');
  const parts = relative.split(/[\\/]/);
  let target = cache, entry;
  for (const [index, part] of parts.entries()) {
    if (!part || part === '..' || part === '.') throw new Error('Invalid native cache path.');
    target = path.join(target, part);
    try { entry = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) throw new Error('Native model cache cannot contain symbolic links.');
  }
  return entry;
}

export function validateRequest(request) {
  if (!request || !['download', 'transcribe'].includes(request.operation) || typeof request.cacheDir !== 'string' || !path.isAbsolute(request.cacheDir)) throw new Error('Invalid private native speech request.');
  if (Object.keys(request).some(key => !['operation', 'cacheDir', 'audioPath', 'language'].includes(key))) throw new Error('Unsupported native speech request field.');
  if (request.operation === 'transcribe' && (typeof request.audioPath !== 'string' || !path.isAbsolute(request.audioPath))) throw new Error('Native transcription requires a private PCM file.');
  if (request.language !== undefined && request.language !== 'auto' && !Object.hasOwn(LANGUAGES, request.language)) throw new Error('Unsupported recording language.');
  return request;
}

export function decodePCM(bytes) {
  if (!bytes.length || bytes.length % 4 || bytes.length / 4 > MAX_SAMPLES) throw new Error('Use nonempty 16 kHz mono Float32 audio shorter than two hours.');
  const audio = new Float32Array(bytes.length / 4);
  for (let index = 0; index < audio.length; index++) {
    const sample = bytes.readFloatLE(index * 4);
    if (!Number.isFinite(sample)) throw new Error('The decoded audio contains a non-finite sample.');
    audio[index] = sample;
  }
  return audio;
}

export const validatedWords = validatedWhisperWords;

/** Remove only partial files from this pinned model during an explicit download. */
export async function validateWeights(cache, removePartial = false) {
  for (const [name, expected] of Object.entries(WEIGHTS)) {
    const target = path.join(modelRoot(cache), 'onnx', name);
    const entry = await cacheEntry(cache, `${CHECKPOINT}/${REVISION}/onnx/${name}`);
    if (entry?.isSymbolicLink() || (entry && !entry.isFile())) throw new Error('Native model cache must contain regular files.');
    if (entry?.size !== expected) {
      if (!removePartial) throw new Error('Download the complete native Large V3 model before transcription.');
      if (entry) await rm(target);
    }
  }
}

async function readyFiles(cache) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push({ path: path.relative(cache, target).split(path.sep).join('/'), size: (await stat(target)).size });
      else throw new Error('Native model cache must contain regular files.');
    }
  }
  const entry = await cacheEntry(cache, `${CHECKPOINT}/${REVISION}`);
  if (!entry?.isDirectory()) throw new Error('The pinned native checkpoint is missing.');
  await visit(modelRoot(cache));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validateReady(cache) {
  let ready;
  try {
    const marker = await cacheEntry(cache, 'ready.json');
    if (!marker?.isFile() || marker.size > 65536) throw new Error('Invalid ready marker.');
    ready = JSON.parse(await readFile(path.join(cache, 'ready.json'), 'utf8'));
  } catch { throw new Error('Download and verify native Large V3 before transcription.'); }
  if (ready.version !== 1 || ready.modelId !== MODEL_ID || ready.checkpoint !== CHECKPOINT || ready.revision !== REVISION || ready.forwardVerified !== true || !Array.isArray(ready.files) || !ready.files.length || ready.files.length > 32) throw new Error('Native Large V3 requires a new execution check. Download it again.');
  const names = new Set();
  for (const file of ready.files) {
    if (typeof file.path !== 'string' || !file.path.startsWith(`${CHECKPOINT}/${REVISION}/`) || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === '..' || part === '.' || !part) || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Invalid native model readiness manifest.');
    names.add(file.path);
    const entry = await cacheEntry(cache, file.path);
    if (!entry?.isFile() || entry.size !== file.size) throw new Error('A verified native model file is missing or incomplete. Download it again.');
  }
  for (const [name, size] of Object.entries(WEIGHTS)) if (!ready.files.some(file => file.path === `${CHECKPOINT}/${REVISION}/onnx/${name}` && file.size === size)) throw new Error('Native readiness omitted a pinned model file.');
  for (const name of REQUIRED_CONFIGS) if (!ready.files.some(file => file.path === `${CHECKPOINT}/${REVISION}/${name}` && file.size > 0)) throw new Error('Native readiness omitted a required model configuration.');
  await validateWeights(cache);
}

export async function runNative(request, emit) {
  validateRequest(request);
  const downloading = request.operation === 'download';
  await mkdir(request.cacheDir, { recursive: true, mode: 0o700 });
  if (downloading) {
    await cacheEntry(request.cacheDir, 'ready.json');
    await rm(path.join(request.cacheDir, 'ready.json'), { force: true });
    await validateWeights(request.cacheDir, true);
  } else { await validateReady(request.cacheDir); }
  let audio;
  if (!downloading) {
    const entry = await lstat(request.audioPath);
    if (!entry.isFile() || !entry.size || entry.size > MAX_SAMPLES * 4) throw new Error('Invalid private PCM audio file.');
    audio = decodePCM(await readFile(request.audioPath));
  }
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = request.cacheDir;
  env.useFSCache = true; env.useBrowserCache = false;
  env.allowLocalModels = !downloading; env.allowRemoteModels = downloading;
  let transcriber;
  const progress = (status, amount = 0, file) => emit({ type: 'progress', progress: { status, progress: Math.max(0, Math.min(100, amount)), ...(file ? { file } : {}) } });
  const seen = new Map();
  try {
    progress(downloading ? 'Downloading native Large V3' : 'Loading native Large V3');
    transcriber = await pipeline('automatic-speech-recognition', CHECKPOINT, {
      revision: REVISION, device: 'cpu', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      cache_dir: request.cacheDir, local_files_only: !downloading,
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: 'sequential', logSeverityLevel: 2 },
      progress_callback: value => {
        if (value.status === 'progress') {
          const percent = Math.round(value.progress ?? 0);
          if (seen.get(value.file) === percent) return;
          seen.set(value.file, percent); progress('Downloading native model file', percent, value.file);
        } else if (value.status === 'done') progress('Native model file saved', 100, value.file);
      },
    });
    if (!transcriber.model.sessions.decoder_model_merged.outputNames.some(name => name.startsWith('cross_attentions.'))) throw new Error('The pinned native model cannot create word timestamps.');
    correctPinnedAlignment(transcriber.model);
    if (downloading) {
      await validateWeights(request.cacheDir);
      const forwarded = new Set();
      for (const [name, label] of [['model', 'Checking native encoder execution'], ['decoder_model_merged', 'Checking native decoder execution']]) {
        const session = transcriber.model.sessions[name], original = session.run.bind(session);
        session.run = async (...args) => { progress(label); const result = await original(...args); forwarded.add(name); return result; };
      }
      const { input_features } = await transcriber.processor(new Float32Array(16000));
      await transcriber.model.generate({ inputs: input_features, language: 'english', task: 'transcribe', max_new_tokens: 1 });
      if (forwarded.size !== 2) throw new Error('Native Large V3 did not complete its execution check.');
      const ready = { version: 1, modelId: MODEL_ID, checkpoint: CHECKPOINT, revision: REVISION, files: await readyFiles(request.cacheDir), forwardVerified: true };
      const pending = path.join(request.cacheDir, `ready.json.pending-${process.pid}`);
      await writeFile(pending, JSON.stringify(ready), { mode: 0o600 });
      await rename(pending, path.join(request.cacheDir, 'ready.json'));
      progress('Native Large V3 ready', 100);
      return {};
    }
    const { traceSpeechChunks } = await import('../web/speech-errors.js');
    traceSpeechChunks(transcriber.model, audio.length, value => progress(value.status), () => {});
    const output = await transcriber(audio, { return_timestamps: 'word', chunk_length_s: 29, stride_length_s: 5, ...(request.language && request.language !== 'auto' ? { language: LANGUAGES[request.language], task: 'transcribe' } : {}) });
    const duration = audio.length / 16000;
    return { words: validatedWords(output, duration), duration };
  } finally { await transcriber?.dispose(); }
}

async function main() {
  // Keep stdout exclusively for the protocol, including third-party diagnostics.
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => process.stderr.write(`${args.map(value => typeof value === 'string' ? value : inspect(value, { depth: 1, maxArrayLength: 4 })).join(' ').slice(0, 2048)}\n`);
  process.stdin.resume();
  // Avoid native ORT destructor races while a thread is creating/running a session.
  const terminate = () => process.kill(process.pid, 'SIGKILL');
  process.stdin.once('end', terminate);
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--request' || !path.isAbsolute(process.argv[3])) throw new Error('Use the fixed helper with one private request file.');
    const requestFile = await lstat(process.argv[3]);
    if (!requestFile.isFile() || requestFile.size > 4096) throw new Error('Invalid private request file.');
    const result = await runNative(JSON.parse(await readFile(process.argv[3], 'utf8')), emit);
    emit({ type: 'result', result });
  } catch (error) {
    emit({ type: 'error', error: String(error?.message || error).split('\n')[0].slice(0, 1000) });
  } finally {
    // Rust validates the terminal message then kills and reaps this owned child.
    // Normal process teardown in macOS ORT can abort in a native mutex destructor
    // even after successful disposal. Preserve the lease until the owner ends it.
    await new Promise(resolve => process.stdout.write('', resolve));
    await new Promise(() => {});
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
