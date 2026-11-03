import type * as TransformersModule from '@huggingface/transformers';
import type { InferenceSession } from 'onnxruntime-node';
import type {
  AutomaticSpeechRecognitionPipeline,
  PretrainedModelOptions,
} from '@huggingface/transformers';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { errorInfo, record, speechModel } from '../web/guards.ts';
type NativeRequest =
  | { operation: 'download'; cacheDir: string; language?: string }
  | {
      operation: 'transcribe';
      cacheDir: string;
      audioPath: string;
      audioBytes: number;
      audioKey?: string;
      language?: string;
    };
interface ReadyFile {
  path: string;
  size: number;
}
interface ReadyManifest {
  version: number;
  modelId: string;
  checkpoint: string;
  revision: string;
  forwardVerified: boolean;
  files: ReadyFile[];
}
/** Fixed local CPU speech helper. Rust owns encrypted PCM and the private stdin lease. */
import {
  open,
  readFile,
  writeFile,
  stat,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import {
  correctWhisperAlignment,
  validatedWhisperWords,
  type TensorOps,
} from '../web/whisper-alignment.ts';

export const MODEL_ID = 'onnx-community/whisper-large-v3';
export const CHECKPOINT = 'Xenova/whisper-large-v3';
export const REVISION = '67bf02d92b7754a1ff82a7f8545f8b8c378b2ef0';
const WEIGHTS = {
  'encoder_model_quantized.onnx': 645260435,
  'decoder_model_merged_quantized.onnx': 915059840,
};
const REQUIRED_CONFIGS = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'generation_config.json',
];
// This pinned Xenova export does not contain the original Large V3 alignment heads.
// Restore the original Large V3 metadata without changing generation or weights:
// https://huggingface.co/openai/whisper-large-v3/blob/06f233fe06e710322aca913c1bc4249a0d71fce1/generation_config.json
const LARGE_V3_ALIGNMENT_HEADS = [
  [7, 0],
  [10, 17],
  [12, 18],
  [13, 12],
  [16, 1],
  [17, 14],
  [19, 11],
  [21, 4],
  [24, 1],
  [25, 6],
];

export function correctPinnedAlignment(
  model: Parameters<typeof correctWhisperAlignment>[0],
  ops: TensorOps,
) {
  correctWhisperAlignment(model, ops, LARGE_V3_ALIGNMENT_HEADS);
}

const LANGUAGES: Record<string, string> = {
  en: 'english',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  hi: 'hindi',
  ja: 'japanese',
  pt: 'portuguese',
  zh: 'chinese',
};
const MAX_SAMPLES = 7200 * 16000;
const modelRoot = (cache: string) => path.join(cache, CHECKPOINT, REVISION);

async function cacheEntry(cache: string, relative: string) {
  const root = await lstat(cache);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Native model cache must be a private regular directory.');
  const parts = relative.split(/[\\/]/);
  let target = cache,
    entry: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const [index, part] of parts.entries()) {
    if (!part || part === '..' || part === '.') throw new Error('Invalid native cache path.');
    target = path.join(target, part);
    try {
      entry = await lstat(target);
    } catch (error) {
      if (errorInfo(error).code === 'ENOENT') return undefined;
      throw error;
    }
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory()))
      throw new Error('Native model cache cannot contain symbolic links.');
  }
  return entry;
}

export function validateRequest(value: unknown): NativeRequest {
  const request = record(value);
  if (
    !value ||
    !(request['operation'] === 'download' || request['operation'] === 'transcribe') ||
    typeof request['cacheDir'] !== 'string' ||
    !path.isAbsolute(request['cacheDir'])
  )
    throw new Error('Invalid private native speech request.');
  if (
    Object.keys(request).some(
      (key) =>
        !['operation', 'cacheDir', 'audioPath', 'audioBytes', 'audioKey', 'language'].includes(key),
    )
  )
    throw new Error('Unsupported native speech request field.');
  if (
    request['operation'] === 'transcribe' &&
    (typeof request['audioPath'] !== 'string' ||
      !path.isAbsolute(request['audioPath']) ||
      typeof request['audioBytes'] !== 'number' ||
      !Number.isSafeInteger(request['audioBytes']) ||
      request['audioBytes'] <= 0 ||
      request['audioBytes'] % 4 ||
      request['audioBytes'] > MAX_SAMPLES * 4 ||
      typeof request['audioKey'] !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(request['audioKey']))
  )
    throw new Error('Native transcription requires encrypted private PCM and its stdin key.');
  if (
    request['operation'] === 'download' &&
    ['audioPath', 'audioBytes', 'audioKey'].some((key) => key in request)
  )
    throw new Error('A model download does not accept audio.');
  if (
    request['language'] !== undefined &&
    request['language'] !== 'auto' &&
    (typeof request['language'] !== 'string' || !Object.hasOwn(LANGUAGES, request['language']))
  )
    throw new Error('Unsupported recording language.');
  return request as NativeRequest;
}

export function decodePCM(bytes: Buffer) {
  if (!bytes.length || bytes.length % 4 || bytes.length / 4 > MAX_SAMPLES)
    throw new Error('Use nonempty 16 kHz mono Float32 audio shorter than two hours.');
  const audio = new Float32Array(bytes.length / 4);
  for (let index = 0; index < audio.length; index++) {
    const sample = bytes.readFloatLE(index * 4);
    if (!Number.isFinite(sample))
      throw new Error('The decoded audio contains a non-finite sample.');
    audio[index] = sample;
  }
  return audio;
}

/** Authenticate every bounded record before exposing PCM to the model. The owner
 * supplies the expected length through its private pipe, so truncation, record
 * reordering and trailing records all fail closed. No plaintext file is created. */
export async function readEncryptedPCM(input: unknown) {
  const request = validateRequest(input);
  if (request.operation !== 'transcribe' || typeof request.audioKey !== 'string')
    throw new Error('Native transcription requires encrypted private PCM and its stdin key.');
  const key = Buffer.from(request.audioKey, 'base64');
  delete request.audioKey;
  let file: FileHandle | undefined, audio: Float32Array | undefined;
  try {
    file = await open(request.audioPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handle = file;
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size < 8 || entry.size > 8 + request.audioBytes * 21)
      throw new Error('Invalid encrypted native audio.');
    let position = 0;
    const exact = async (bytes: Buffer) => {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position);
        if (!bytesRead) throw new Error('Encrypted native audio is incomplete.');
        offset += bytesRead;
        position += bytesRead;
      }
    };
    const header = Buffer.alloc(8);
    await exact(header);
    if (header.toString('ascii') !== 'ECHOPCM1') throw new Error('Native audio must be encrypted.');
    audio = new Float32Array(request.audioBytes / 4);
    const output = Buffer.from(audio.buffer),
      length = Buffer.alloc(4);
    let count = 0,
      index = 0n;
    while (count < request.audioBytes) {
      await exact(length);
      const size = length.readUInt32LE();
      if (size <= 0 || size > 65536 || count + size > request.audioBytes)
        throw new Error('Invalid encrypted native audio record.');
      const sealed = Buffer.alloc(size + 16);
      await exact(sealed);
      const nonce = Buffer.alloc(12);
      nonce.writeBigUInt64LE(index, 4);
      const binding = Buffer.alloc(12);
      binding.writeBigUInt64LE(index);
      length.copy(binding, 8);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(binding);
      decipher.setAuthTag(sealed.subarray(size));
      const plain = decipher.update(sealed.subarray(0, size));
      try {
        decipher.final();
        plain.copy(output, count);
      } finally {
        plain.fill(0);
      }
      count += size;
      index++;
    }
    if (position !== entry.size) throw new Error('Encrypted native audio has trailing data.');
    // The wire encoding is little-endian regardless of the host architecture.
    for (let index = 0; index < audio.length; index++) {
      const sample = output.readFloatLE(index * 4);
      if (!Number.isFinite(sample))
        throw new Error('The decoded audio contains a non-finite sample.');
      audio[index] = sample;
    }
    return audio;
  } catch (error) {
    audio?.fill(0);
    throw error;
  } finally {
    key.fill(0);
    await file?.close();
  }
}

/** Read one bounded request without ending the stdin lifetime lease. */
export function readPrivateRequest(input: Readable): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(4096);
    let count = 0;
    const cleanup = () => {
      input.off('data', data);
      input.off('error', failed);
      input.off('end', ended);
      bytes.fill(0);
    };
    const failed = (error: unknown) => {
      cleanup();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original API/runtime rejection value and its identity for existing error handling.
      reject(error);
    };
    const ended = () => {
      failed(new Error('The native speech owner disconnected.'));
    };
    const data = (input: unknown) => {
      if (!Buffer.isBuffer(input)) {
        failed(new Error('Invalid private native speech request.'));
        return;
      }
      const chunk = input;
      if (count + chunk.length > bytes.length) {
        failed(new Error('Native request exceeded its limit.'));
        return;
      }
      chunk.copy(bytes, count);
      count += chunk.length;
      const newline = bytes.subarray(0, count).indexOf(10);
      if (newline < 0) return;
      if (newline !== count - 1) {
        failed(new Error('Unsupported native request data.'));
        return;
      }
      try {
        const value = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as unknown;
        cleanup();
        resolve(value);
      } catch {
        failed(new Error('Invalid private native speech request.'));
      }
    };
    input.on('data', data);
    input.once('error', failed);
    input.once('end', ended);
  });
}

export const validatedWords = validatedWhisperWords;

/** Remove only partial files from this pinned model during an explicit download. */
export async function validateWeights(cache: string, removePartial = false) {
  for (const [name, expected] of Object.entries(WEIGHTS)) {
    const target = path.join(modelRoot(cache), 'onnx', name);
    const entry = await cacheEntry(cache, `${CHECKPOINT}/${REVISION}/onnx/${name}`);
    if (entry?.isSymbolicLink() || (entry && !entry.isFile()))
      throw new Error('Native model cache must contain regular files.');
    if (entry?.size !== expected) {
      if (!removePartial)
        throw new Error('Download the complete native Large V3 model before transcription.');
      if (entry) await rm(target);
    }
  }
}

async function readyFiles(cache: string) {
  const files: ReadyFile[] = [];
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile())
        files.push({
          path: path.relative(cache, target).split(path.sep).join('/'),
          size: (await stat(target)).size,
        });
      else throw new Error('Native model cache must contain regular files.');
    }
  }
  const entry = await cacheEntry(cache, `${CHECKPOINT}/${REVISION}`);
  if (!entry?.isDirectory()) throw new Error('The pinned native checkpoint is missing.');
  await visit(modelRoot(cache));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validateReady(cache: string) {
  let ready: ReadyManifest;
  try {
    const marker = await cacheEntry(cache, 'ready.json');
    if (!marker?.isFile() || marker.size > 65536) throw new Error('Invalid ready marker.');
    ready = readyManifest(
      JSON.parse(await readFile(path.join(cache, 'ready.json'), 'utf8')) as unknown,
    );
  } catch {
    throw new Error('Download and verify native Large V3 before transcription.');
  }
  if (
    ready.version !== 1 ||
    ready.modelId !== MODEL_ID ||
    ready.checkpoint !== CHECKPOINT ||
    ready.revision !== REVISION ||
    !ready.forwardVerified ||
    !Array.isArray(ready.files) ||
    !ready.files.length ||
    ready.files.length > 32
  )
    throw new Error('Native Large V3 requires a new execution check. Download it again.');
  const names = new Set<string>();
  for (const file of ready.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path.startsWith(`${CHECKPOINT}/${REVISION}/`) ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]/).some((part) => part === '..' || part === '.' || !part) ||
      names.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0
    )
      throw new Error('Invalid native model readiness manifest.');
    names.add(file.path);
    const entry = await cacheEntry(cache, file.path);
    if (!entry?.isFile() || entry.size !== file.size)
      throw new Error('A verified native model file is missing or incomplete. Download it again.');
  }
  for (const [name, size] of Object.entries(WEIGHTS))
    if (
      !ready.files.some(
        (file) => file.path === `${CHECKPOINT}/${REVISION}/onnx/${name}` && file.size === size,
      )
    )
      throw new Error('Native readiness omitted a pinned model file.');
  for (const name of REQUIRED_CONFIGS)
    if (
      !ready.files.some(
        (file) => file.path === `${CHECKPOINT}/${REVISION}/${name}` && file.size > 0,
      )
    )
      throw new Error('Native readiness omitted a required model configuration.');
  await validateWeights(cache);
}

async function runNative(input: unknown, emit: (message: unknown) => void) {
  const request = validateRequest(input);
  const downloading = request.operation === 'download';
  await mkdir(request.cacheDir, { recursive: true, mode: 0o700 });
  if (downloading) {
    await cacheEntry(request.cacheDir, 'ready.json');
    await rm(path.join(request.cacheDir, 'ready.json'), { force: true });
    await validateWeights(request.cacheDir, true);
  } else {
    await validateReady(request.cacheDir);
  }
  let audio: Float32Array | undefined;
  if (!downloading) {
    audio = await readEncryptedPCM(request);
  }
  const { env, pipeline, Tensor, cat, mean, stack, std_mean } =
    await import('@huggingface/transformers');
  env.cacheDir = request.cacheDir;
  env.useFSCache = true;
  env.useBrowserCache = false;
  env.allowLocalModels = !downloading;
  env.allowRemoteModels = downloading;
  let transcriber: AutomaticSpeechRecognitionPipeline | undefined;
  const progress = (status: string, amount = 0, file?: string) => {
    emit({
      type: 'progress',
      progress: { status, progress: Math.max(0, Math.min(100, amount)), ...(file ? { file } : {}) },
    });
  };
  const seen = new Map<string, number>();
  try {
    progress(downloading ? 'Downloading native Large V3' : 'Loading native Large V3');
    const createTranscriber = pipeline as (
      task: 'automatic-speech-recognition',
      model: string,
      options: PretrainedModelOptions,
    ) => Promise<AutomaticSpeechRecognitionPipeline>;
    transcriber = await createTranscriber('automatic-speech-recognition', CHECKPOINT, {
      revision: REVISION,
      device: 'cpu',
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      cache_dir: request.cacheDir,
      local_files_only: !downloading,
      session_options: {
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
        executionMode: 'sequential',
        logSeverityLevel: 2,
      },
      progress_callback: (value) => {
        if (value.status === 'progress') {
          const percent = Math.round(value.progress);
          if (seen.get(value.file) === percent) return;
          seen.set(value.file, percent);
          progress('Downloading native model file', percent, value.file);
        } else if (value.status === 'done') progress('Native model file saved', 100, value.file);
      },
    });
    if (
      !speechModel(transcriber.model).sessions['decoder_model_merged']?.outputNames.some((name) =>
        name.startsWith('cross_attentions.'),
      )
    )
      throw new Error('The pinned native model cannot create word timestamps.');
    correctPinnedAlignment(speechModel(transcriber.model), { Tensor, cat, mean, stack, std_mean });
    if (downloading) {
      await validateWeights(request.cacheDir);
      const forwarded = new Set<string>();
      for (const [name, label] of [
        ['model', 'Checking native encoder execution'],
        ['decoder_model_merged', 'Checking native decoder execution'],
      ] as const) {
        const session = speechModel(transcriber.model).sessions[name];
        if (!session) throw new Error('Native Large V3 did not complete its execution check.');
        const original: InferenceSession['run'] = session.run.bind(session);
        session.run = async (
          ...args: [
            InferenceSession.FeedsType,
            (InferenceSession.FetchesType | InferenceSession.RunOptions)?,
            InferenceSession.RunOptions?,
          ]
        ) => {
          progress(label);
          const result = await (Reflect.apply(original, session, args) as ReturnType<
            typeof original
          >);
          forwarded.add(name);
          return result;
        };
      }
      const features: unknown = await transcriber.processor(new Float32Array(16000));
      const input_features = record(features)['input_features'];
      if (!input_features || typeof input_features !== 'object')
        throw new Error('Native Large V3 did not complete its execution check.');
      const generate = speechModel(transcriber.model).generate as (options: {
        inputs: TransformersModule.Tensor;
        language: string;
        task: string;
        max_new_tokens: number;
      }) => Promise<unknown>;
      await generate.call(transcriber.model, {
        inputs: input_features as TransformersModule.Tensor,
        language: 'english',
        task: 'transcribe',
        max_new_tokens: 1,
      });
      if (forwarded.size !== 2)
        throw new Error('Native Large V3 did not complete its execution check.');
      const ready = {
        version: 1,
        modelId: MODEL_ID,
        checkpoint: CHECKPOINT,
        revision: REVISION,
        files: await readyFiles(request.cacheDir),
        forwardVerified: true,
      };
      const pending = path.join(request.cacheDir, `ready.json.pending-${process.pid}`);
      await writeFile(pending, JSON.stringify(ready), { mode: 0o600 });
      await rename(pending, path.join(request.cacheDir, 'ready.json'));
      progress('Native Large V3 ready', 100);
      return {};
    }
    const { traceSpeechChunks } = await import('../web/speech-errors.ts');
    if (!audio)
      throw new Error('Native transcription requires encrypted private PCM and its stdin key.');
    traceSpeechChunks(
      speechModel(transcriber.model),
      audio.length,
      (value) => {
        progress(value.status);
      },
      () => {
        /* No speech progress listener is needed for this model call. */
      },
    );
    const output = await transcriber(audio, {
      return_timestamps: 'word',
      chunk_length_s: 29,
      stride_length_s: 5,
      ...(request.language && request.language !== 'auto'
        ? { language: LANGUAGES[request.language], task: 'transcribe' }
        : {}),
    });
    const duration = audio.length / 16000;
    return { words: validatedWords(output, duration), duration };
  } finally {
    audio?.fill(0);
    await transcriber?.dispose();
  }
}

async function main() {
  // Keep stdout exclusively for the protocol, including third-party diagnostics.
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
    console[level] = (...args: unknown[]) =>
      process.stderr.write(
        `${args
          .map((value) =>
            typeof value === 'string' ? value : inspect(value, { depth: 1, maxArrayLength: 4 }),
          )
          .join(' ')
          .slice(0, 2048)}\n`,
      );
  // Avoid native ORT destructor races while a thread is creating/running a session.
  const terminate = () => process.kill(process.pid, 'SIGKILL');
  process.stdin.once('end', terminate);
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--stdin-request')
      throw new Error('Use the fixed helper with its private stdin request.');
    const result = await runNative(await readPrivateRequest(process.stdin), emit);
    emit({ type: 'result', result });
  } catch (error) {
    emit({
      type: 'error',
      error: String(errorInfo(error).message || error)
        .split('\n')[0]
        ?.slice(0, 1000),
    });
  } finally {
    // Rust validates the terminal message then kills and reaps this owned child.
    // Normal process teardown in macOS ORT can abort in a native mutex destructor
    // even after successful disposal. Preserve the lease until the owner ends it.
    await new Promise((resolve) => process.stdout.write('', resolve));
    await new Promise(() => {
      /* Disposal must not replace the reported inference error. */
    });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();
function readyManifest(value: unknown): ReadyManifest {
  const v = record(value);
  const files = v['files'];
  if (
    typeof v['version'] !== 'number' ||
    typeof v['modelId'] !== 'string' ||
    typeof v['checkpoint'] !== 'string' ||
    typeof v['revision'] !== 'string' ||
    typeof v['forwardVerified'] !== 'boolean' ||
    !Array.isArray(files) ||
    !files.every((item: unknown) => {
      const f = record(item);
      return typeof f['path'] === 'string' && typeof f['size'] === 'number';
    })
  )
    throw new Error('Invalid ready marker.');
  return value as ReadyManifest;
}
