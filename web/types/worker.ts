import type { Progress, Segment, Speaker, Word } from './domain.ts';
export interface InferenceOptions {
  language?: string | undefined;
  speakers?: Speaker[];
  words?: Word[];
}
export interface LiveOptions {
  jobId?: string;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}
export interface LiveResult {
  words: Word[];
  duration: number;
  model?: string;
  modelRevision: string;
}
export interface TranscriptResult {
  passages: (Omit<Segment, 'id' | 'uncertain'> & Partial<Pick<Segment, 'id' | 'uncertain'>>)[];
  speakers?: Speaker[];
  model?: string;
  duration?: number;
}
export type WorkerOperation =
  'download' | 'download-companions' | 'transcribe' | 'diarize' | 'transcribe-live';
export type WorkerRequest =
  | {
      id: string;
      type: 'download' | 'download-companions';
      modelId: string;
      audio?: Float32Array | undefined;
      options?: InferenceOptions | undefined;
    }
  | {
      id: string;
      type: 'transcribe' | 'diarize' | 'transcribe-live';
      modelId: string;
      audio: Float32Array;
      options?: InferenceOptions | undefined;
    };
export type WorkerReply =
  | { id: string; type: 'progress'; progress: Progress }
  | { id: string; type: 'error'; error: string }
  | { id: string; type: 'result'; result?: LiveResult | TranscriptResult };

export type WorkerEnvelope =
  Exclude<WorkerReply, { type: 'result' }> | { id: string; type: 'result'; result?: unknown };
