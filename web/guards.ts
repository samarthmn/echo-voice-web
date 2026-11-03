import type * as DomainModule from './types/domain.ts';
import type * as WorkerModule from './types/worker.ts';
import type { Tensor } from '@huggingface/transformers';
import type { PyAnnoteProcessor, WhisperForConditionalGeneration } from '@huggingface/transformers';
import type { InferenceSession } from 'onnxruntime-web';
import type {
  ConnectionRequest,
  ExtensionRecording,
  LeaseGrant,
  Meeting,
  ModelManifest,
  NativeJob,
  NativeStatus,
  Progress,
  Settings,
  VocabularyEntry,
  Word,
} from './types/domain.ts';
import type { WorkerEnvelope, WorkerRequest } from './types/worker.ts';
/** Untrusted JSON, browser messages and runtime outputs enter as unknown. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
export function errorInfo(value: unknown): {
  message?: string;
  name?: string;
  status?: number;
  code?: string;
  unavailable?: boolean;
} {
  const v = record(value);
  return {
    ...(typeof v['message'] === 'string' ? { message: v['message'] } : {}),
    ...(typeof v['name'] === 'string' ? { name: v['name'] } : {}),
    ...(typeof v['status'] === 'number' ? { status: v['status'] } : {}),
    ...(typeof v['code'] === 'string' ? { code: v['code'] } : {}),
    ...(typeof v['unavailable'] === 'boolean' ? { unavailable: v['unavailable'] } : {}),
  };
}
export const parseJson = (text: string): unknown => JSON.parse(text);
export const responseJson = async (response: Response): Promise<unknown> => response.json();
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s: unknown) => typeof s === 'string');
function isWord(v: unknown): v is Word {
  const w = record(v);
  return (
    typeof w['text'] === 'string' &&
    Array.isArray(w['timestamp']) &&
    w['timestamp'].length === 2 &&
    w['timestamp'].every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
  );
}
function optionalFields(
  v: Record<string, unknown>,
  text: string[] = [],
  numbers: string[] = [],
  flags: string[] = [],
): boolean {
  return (
    text.every((key) => v[key] === undefined || typeof v[key] === 'string') &&
    numbers.every((key) => v[key] === undefined || typeof v[key] === 'number') &&
    flags.every((key) => v[key] === undefined || typeof v[key] === 'boolean')
  );
}
function isProgress(value: unknown): value is Progress {
  const p = record(value);
  const runtime = record(p['runtime']);
  return (
    typeof p['status'] === 'string' &&
    optionalFields(p, ['file', 'error'], ['progress', 'chunk', 'totalChunks']) &&
    (p['runtime'] === undefined ||
      (typeof runtime['threads'] === 'number' && typeof runtime['isolated'] === 'boolean'))
  );
}
function isSpeaker(value: unknown): boolean {
  const v = record(value);
  return (
    Array.isArray(v['vector']) &&
    v['vector'].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof v['weight'] === 'number'
  );
}
function isVocabulary(value: unknown): boolean {
  const v = record(value);
  return (
    typeof v['term'] === 'string' &&
    typeof v['enabled'] === 'boolean' &&
    (v['aliases'] === undefined || strings(v['aliases']))
  );
}
function isSegment(value: unknown, saved = false): boolean {
  const v = record(value);
  return (
    typeof v['text'] === 'string' &&
    typeof v['speaker'] === 'string' &&
    typeof v['start'] === 'number' &&
    typeof v['end'] === 'number' &&
    optionalFields(v, ['id'], [], ['uncertain']) &&
    (!saved || typeof v['id'] === 'string')
  );
}
function isTrack(value: unknown): boolean {
  const v = record(value);
  return typeof v['id'] === 'string' && optionalFields(v, ['label', 'mimeType', 'url'], ['bytes']);
}
function isTranscript(value: unknown): boolean {
  const v = record(value);
  return (
    typeof v['id'] === 'string' &&
    typeof v['model'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    Array.isArray(v['passages']) &&
    v['passages'].every((p: unknown) => isSegment(p, true)) &&
    optionalFields(v, ['label']) &&
    (v['vocabulary'] === undefined ||
      (Array.isArray(v['vocabulary']) && v['vocabulary'].every(isVocabulary)))
  );
}
function isNoteItem(value: unknown): boolean {
  const v = record(value);
  return (
    typeof v['id'] === 'string' &&
    typeof v['text'] === 'string' &&
    strings(v['passageIds']) &&
    optionalFields(v, ['owner', 'dueDate'], [], ['done'])
  );
}
function isNotes(value: unknown): boolean {
  const v = record(value);
  const usage = record(v['usage']);
  return (
    ['id', 'createdAt', 'model', 'transcriptVersionId'].every((k) => typeof v[k] === 'string') &&
    ['summary', 'decisions', 'actions'].every(
      (k) => Array.isArray(v[k]) && (v[k] as unknown[]).every(isNoteItem),
    ) &&
    optionalFields(v, [], [], ['edited']) &&
    (v['provider'] === undefined || v['provider'] === 'ollama' || v['provider'] === 'chatgpt') &&
    (v['usage'] === undefined ||
      optionalFields(usage, [], ['inputTokens', 'outputTokens', 'cachedInputTokens']))
  );
}
function isGap(value: unknown): boolean {
  const v = record(value);
  return (
    typeof v['start'] === 'number' &&
    typeof v['end'] === 'number' &&
    typeof v['reason'] === 'string'
  );
}
export function meetingDetails(value: unknown): Omit<Meeting, 'id'> {
  const v = record(value);
  if (
    typeof v['status'] !== 'string' ||
    !Array.isArray(v['tracks']) ||
    !v['tracks'].every(isTrack) ||
    !Array.isArray(v['transcripts']) ||
    !v['transcripts'].every(isTranscript) ||
    !optionalFields(
      v,
      ['title', 'mode', 'speechModel', 'notesModel', 'error'],
      ['duration'],
      ['consent', 'autoTranscribeSuppressed', 'liveTranscription'],
    ) ||
    (v['gaps'] !== undefined && (!Array.isArray(v['gaps']) || !v['gaps'].every(isGap))) ||
    (v['notes'] !== undefined && (!Array.isArray(v['notes']) || !v['notes'].every(isNotes)))
  )
    throw new Error('Invalid or corrupted saved data.');
  // Optional legacy metadata is retained; only fields consumed by this bridge are required.
  return value as Omit<Meeting, 'id'>;
}
export function meeting(value: unknown): Meeting {
  meetingDetails(value);
  if (typeof record(value)['id'] !== 'string') throw new Error('Invalid or corrupted saved data.');
  return value as Meeting;
}
export function meetingIdentity(value: unknown): Pick<Meeting, 'id'> {
  if (typeof record(value)['id'] !== 'string') throw new Error('Invalid or corrupted saved data.');
  return value as Pick<Meeting, 'id'>;
}
export function settings(value: unknown): Settings {
  const v = record(value);
  if (
    (v['autoTranscribe'] !== undefined && typeof v['autoTranscribe'] !== 'boolean') ||
    (v['speechModel'] !== undefined && typeof v['speechModel'] !== 'string') ||
    (v['language'] !== undefined && typeof v['language'] !== 'string') ||
    !optionalFields(v, ['notesModel'])
  )
    throw new Error('Invalid or corrupted saved data.');
  return value as Settings;
}
export function vocabulary(value: unknown): VocabularyEntry[] {
  const v = record(value)['entries'] ?? [];
  if (
    !Array.isArray(v) ||
    !v.every((e: unknown) => {
      const r = record(e);
      return (
        typeof r['term'] === 'string' &&
        typeof r['enabled'] === 'boolean' &&
        (r['aliases'] === undefined || strings(r['aliases']))
      );
    })
  )
    throw new Error('Invalid or corrupted saved data.');
  return v as VocabularyEntry[];
}
export function manifest(value: unknown): ModelManifest | null {
  const v = record(value);
  if (
    !strings(v['files']) ||
    !optionalFields(v, ['engine', 'checkpoint', 'revision', 'precision'], [], ['wordTimestamps']) ||
    (v['speakerModels'] !== undefined &&
      !(
        typeof record(v['speakerModels'])['segmentation'] === 'string' &&
        typeof record(v['speakerModels'])['embedding'] === 'string'
      ))
  )
    return null;
  return value as ModelManifest;
}
export function nativeStatus(value: unknown): NativeStatus {
  const v = record(value);
  if (
    typeof v['available'] !== 'boolean' ||
    (v['ready'] !== undefined && typeof v['ready'] !== 'boolean') ||
    !optionalFields(v, ['detail'])
  )
    throw new Error('The local speech engine did not respond. Check the server and retry.');
  return value as NativeStatus;
}
export function nativeJob(value: unknown): NativeJob {
  const v = record(value);
  if (
    (v['jobId'] !== undefined && typeof v['jobId'] !== 'string') ||
    (v['state'] !== undefined && typeof v['state'] !== 'string') ||
    !optionalFields(v, ['error']) ||
    (v['progress'] !== undefined && !isProgress(v['progress'])) ||
    (v['result'] !== undefined && !isRecord(v['result'])) ||
    (record(v['result'])['words'] !== undefined &&
      (!Array.isArray(record(v['result'])['words']) ||
        !(record(v['result'])['words'] as unknown[]).every(isWord)))
  )
    throw new Error('The local speech engine returned an unexpected job identifier.');
  return value as NativeJob;
}
export function connectionRequest(value: unknown): ConnectionRequest {
  const v = record(value);
  if (
    typeof v['requestId'] !== 'string' ||
    typeof v['name'] !== 'string' ||
    typeof v['origin'] !== 'string' ||
    typeof v['expiresAt'] !== 'number' ||
    typeof v['status'] !== 'string'
  )
    throw new Error('This request is invalid. Try again from the extension.');
  return value as ConnectionRequest;
}
/** Extension IDs to try, in order: the unpacked build, then the Chrome Web Store build. */
export function extensionIds(value: unknown): string[] {
  const ids = record(value)['ids'];
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    !ids.every((id) => typeof id === 'string' && /^[a-p]{32}$/.test(id))
  )
    throw new Error('Extension ID is unavailable');
  return ids as string[];
}
export function extensionRecordings(value: unknown): ExtensionRecording[] {
  const list = record(value)['recordings'] ?? [];
  if (
    !Array.isArray(list) ||
    !list.every((r: unknown) => {
      const v = record(r);
      return (
        typeof v['recordingId'] === 'string' &&
        typeof v['status'] === 'string' &&
        typeof v['totalFrames'] === 'number' &&
        typeof v['meetingId'] === 'string' &&
        optionalFields(v, ['captureState'], ['generation'], ['liveTranscription']) &&
        (v['draft'] === undefined || v['draft'] === null || !!draftFields(v['draft']))
      );
    })
  )
    throw new Error('This Echo extension protocol is unsupported.');
  return list as ExtensionRecording[];
}
export function leaseGrant(value: unknown): LeaseGrant {
  const v = record(value);
  if (
    typeof v['generation'] !== 'number' ||
    !(typeof v['expiresAt'] === 'number' || typeof v['expiresAt'] === 'string') ||
    typeof v['totalFrames'] !== 'number' ||
    !Object.hasOwn(v, 'draft')
  )
    throw new Error('Echo returned no authoritative live cursor with its processing lease.');
  return value as LeaseGrant;
}
export function workerRequest(value: unknown): WorkerRequest | null {
  const v = record(value);
  if (typeof v['id'] !== 'string' || typeof v['modelId'] !== 'string') return null;
  if (
    !['download', 'download-companions', 'transcribe', 'diarize', 'transcribe-live'].includes(
      String(v['type']),
    )
  )
    return null;
  if (
    !['download', 'download-companions'].includes(String(v['type'])) &&
    !(v['audio'] instanceof Float32Array)
  )
    return null;
  const o = record(v['options']);
  if (
    !optionalFields(o, ['language']) ||
    (o['speakers'] !== undefined &&
      (!Array.isArray(o['speakers']) || !o['speakers'].every(isSpeaker))) ||
    (o['words'] !== undefined && (!Array.isArray(o['words']) || !o['words'].every(isWord)))
  )
    return null;
  return value as WorkerRequest;
}
export function workerReply(value: unknown): WorkerEnvelope | null {
  const v = record(value);
  if (typeof v['id'] !== 'string') return null;
  if (v['type'] === 'progress' && isProgress(v['progress'])) return value as WorkerEnvelope;
  if (v['type'] === 'error' && typeof v['error'] === 'string') return value as WorkerEnvelope;
  if (v['type'] === 'result') return value as WorkerEnvelope;
  return null;
}
export function apiError(value: unknown): string | undefined {
  const e = record(value)['error'];
  return typeof e === 'string' ? e : undefined;
}
export function ollamaProgress(value: unknown): {
  status?: string;
  error?: string;
  completed: number;
  total: number;
} {
  const v = record(value);
  if (
    (v['status'] !== undefined && typeof v['status'] !== 'string') ||
    (v['error'] !== undefined && typeof v['error'] !== 'string') ||
    (v['total'] !== undefined && typeof v['total'] !== 'number') ||
    (v['completed'] !== undefined && typeof v['completed'] !== 'number')
  )
    throw new Error('Ollama returned invalid download progress. Retry the download.');
  return {
    ...(typeof v['status'] === 'string' ? { status: v['status'] } : {}),
    ...(typeof v['error'] === 'string' ? { error: v['error'] } : {}),
    completed: typeof v['completed'] === 'number' ? v['completed'] : 0,
    total: typeof v['total'] === 'number' ? v['total'] : 0,
  };
}
export function numericVector(value: unknown): number[] {
  if (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Float64Array))
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  const values: unknown[] = Array.from(value);
  if (!values.every((v): v is number => typeof v === 'number' && Number.isFinite(v)))
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  return values;
}
export function unrefTimer(timer: unknown): void {
  const unref = record(timer)['unref'];
  if (typeof unref === 'function') unref.call(timer);
}
export function heartbeat(value: unknown): { restored?: string[] } {
  const v = record(value)['restored'];
  if (v === undefined) return {};
  if (!strings(v)) throw new Error('Invalid or corrupted saved data.');
  return { restored: v };
}
type RuntimeSpeechModel = Pick<
  WhisperForConditionalGeneration,
  'config' | 'generate' | '_extract_token_timestamps'
> & {
  sessions: Record<string, Pick<InferenceSession, 'run'> & { outputNames: readonly string[] }>;
};
export function speechModel(value: unknown): RuntimeSpeechModel {
  const v = record(value);
  const sessions = record(v['sessions']);
  if (
    typeof v['generate'] !== 'function' ||
    typeof v['_extract_token_timestamps'] !== 'function' ||
    typeof v['config'] !== 'object' ||
    v['config'] === null ||
    !['model', 'decoder_model_merged'].every(
      (key) => typeof record(sessions[key])['run'] === 'function',
    ) ||
    !strings(record(sessions['decoder_model_merged'])['outputNames'])
  )
    throw new Error('The speech model returned no word timestamps.');
  return value as RuntimeSpeechModel;
}
function tensorInputs(value: unknown): Record<string, Tensor> {
  if (!isRecord(value) || !Object.values(value).every((v) => isTensor(v)))
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  return value as Record<string, Tensor>;
}
function tensorOutput(value: unknown, key: string): Tensor {
  const tensor = record(value)[key];
  if (!isTensor(tensor))
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  return tensor;
}
export function tensorModel<K extends 'logits' | 'embeddings'>(
  value: unknown,
  key: K,
): (inputs: Record<string, Tensor>) => Promise<Record<K, Tensor>> {
  if (typeof value !== 'function')
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  const model = value as (inputs: Record<string, Tensor>) => Promise<unknown>;
  return async (inputs) => {
    const output: unknown = await model(inputs);
    tensorOutput(output, key);
    return output as Record<K, Tensor>;
  };
}
export function audioProcessor(
  value: unknown,
): (audio: Float32Array) => Promise<Record<string, Tensor>> {
  if (typeof value !== 'function')
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  const processor = value as (audio: Float32Array) => Promise<unknown>;
  return async (audio) => tensorInputs(await processor(audio));
}
export function segmentationProcessor(
  value: unknown,
): ((audio: Float32Array) => Promise<Record<string, Tensor>>) &
  Pick<PyAnnoteProcessor, 'post_process_speaker_diarization'> {
  const postprocess = record(value)['post_process_speaker_diarization'];
  if (typeof postprocess !== 'function')
    throw new Error('Speaker recognition returned an invalid voice embedding.');
  const processor = audioProcessor(value);
  return Object.assign(processor, {
    post_process_speaker_diarization: (logits: Tensor, samples: number) => {
      const result: unknown = postprocess.call(value, logits, samples);
      if (
        !Array.isArray(result) ||
        !result.every(
          (group: unknown) =>
            Array.isArray(group) &&
            group.every((segment: unknown) => {
              const v = record(segment);
              return ['id', 'start', 'end', 'confidence'].every(
                (key) => typeof v[key] === 'number',
              );
            }),
        )
      )
        throw new Error('Speaker recognition returned an invalid voice embedding.');
      return result as ReturnType<PyAnnoteProcessor['post_process_speaker_diarization']>;
    },
  });
}

function isTensor(value: unknown): value is Tensor {
  const v = record(value);
  return Array.isArray(v['dims']) && ArrayBuffer.isView(v['data']) && typeof v['type'] === 'string';
}
export function draftFields(value: unknown): Omit<
  DomainModule.LiveDraft,
  'language' | 'modelRevision'
> & {
  language?: string;
  modelRevision?: string;
} {
  const v = record(value);
  if (
    typeof v['throughFrame'] !== 'number' ||
    typeof v['committedThroughFrame'] !== 'number' ||
    !optionalFields(v, ['language', 'modelRevision']) ||
    !Array.isArray(v['words'])
  )
    throw new Error('Saved live transcription cursor is invalid.');
  if (
    !v['words'].every((w: unknown) => {
      const r = record(w);
      return (
        typeof r['text'] === 'string' &&
        typeof r['startFrame'] === 'number' &&
        typeof r['endFrame'] === 'number' &&
        typeof r['provisional'] === 'boolean'
      );
    })
  )
    throw new Error('Saved live word timestamps are invalid.');
  return value as Omit<DomainModule.LiveDraft, 'language' | 'modelRevision'> & {
    language?: string;
    modelRevision?: string;
  };
}
export function transcriptResult(value: unknown): WorkerModule.TranscriptResult {
  const v = record(value);
  if (
    !Array.isArray(v['passages']) ||
    !v['passages'].every((p: unknown) => isSegment(p)) ||
    (v['duration'] !== undefined && typeof v['duration'] !== 'number') ||
    (v['speakers'] !== undefined &&
      (!Array.isArray(v['speakers']) || !v['speakers'].every(isSpeaker))) ||
    !optionalFields(v, ['model'])
  )
    throw new Error('The speech model returned no word timestamps.');
  return value as WorkerModule.TranscriptResult;
}
export function extensionReply(value: unknown): DomainModule.ExtensionReply {
  if (
    !isRecord(value) ||
    !optionalFields(value, ['version', 'status', 'endpoint', 'libraryId'], [], ['installed', 'ok'])
  )
    throw new Error('Extension is not installed');
  return value;
}
