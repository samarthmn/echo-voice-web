/** Saved JSON shapes from server/src/store/{meetings,audio,settings}.rs. */
interface Track {
  id: string;
  label?: string;
  mimeType?: string;
  bytes?: number;
  url?: string;
}
export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  uncertain?: boolean;
}
export interface VocabularyEntry {
  term: string;
  aliases?: string[];
  enabled: boolean;
}
interface Transcript {
  id: string;
  model: string;
  createdAt: string;
  passages: Segment[];
  vocabulary?: VocabularyEntry[];
  label?: string;
}
interface NoteItem {
  id: string;
  text: string;
  passageIds: string[];
  owner?: string;
  dueDate?: string;
  done?: boolean;
}
interface Notes {
  id: string;
  createdAt: string;
  model: string;
  transcriptVersionId: string;
  summary: NoteItem[];
  decisions: NoteItem[];
  actions: NoteItem[];
  edited?: boolean;
  provider?: 'ollama' | 'chatgpt';
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}
export interface Gap {
  start: number;
  end: number;
  reason: string;
}
export interface Meeting {
  id: string;
  status: string;
  tracks: Track[];
  transcripts: Transcript[];
  title?: string;
  mode?: string;
  consent?: boolean;
  duration?: number;
  speechModel?: string;
  notesModel?: string;
  notes?: Notes[];
  gaps?: Gap[];
  error?: string;
  autoTranscribeSuppressed?: boolean;
  liveTranscription?: boolean;
}
export interface Settings {
  autoTranscribe?: boolean;
  speechModel?: string;
  language?: string;
  notesModel?: string;
}
export interface Word {
  text: string;
  timestamp: [number, number];
}
export interface Speaker {
  vector: number[];
  weight: number;
}
export interface Turn {
  start: number;
  end: number;
  speaker: string;
  uncertain: boolean;
}
export interface DiarizationSegment {
  id: number;
  start: number;
  end: number;
  confidence: number;
}
export interface VoiceSample {
  channel: number;
  vector: ArrayLike<number> & Iterable<number>;
  seconds: number;
  allowNew?: boolean;
  anchorSupported?: boolean;
  segment?: DiarizationSegment;
}
export interface ModelDescriptor {
  id: string;
  checkpoint: string;
  revision: string;
  name: string;
  label: string;
  size: string;
  sizeMB: number;
  description: string;
  language: string;
  recommended: boolean;
  engine?: 'native';
  precision?: string;
  dtype?: { encoder_model: 'q8'; decoder_model_merged: 'q8' };
}
export interface ModelManifest {
  files: string[];
  engine?: string;
  speakerModels?: { segmentation: string; embedding: string };
  checkpoint?: string;
  revision?: string;
  wordTimestamps?: boolean;
  precision?: string;
}
export interface Progress {
  status: string;
  progress?: number | undefined;
  file?: string | undefined;
  chunk?: number;
  totalChunks?: number;
  error?: string | undefined;
  runtime?: { threads: number; isolated: boolean };
}
export interface DownloadState {
  status: string;
  progress: number;
  detail?: string;
  error?: string | undefined;
}
export interface NativeStatus {
  available: boolean;
  ready?: boolean;
  detail?: string;
}
export interface NativeJob {
  jobId?: string;
  state?: string;
  error?: string;
  progress?: Progress;
  result?: { words?: Word[] };
}
interface LiveWord {
  text: string;
  startFrame: number;
  endFrame: number;
  provisional: boolean;
}
export interface LiveDraft {
  throughFrame: number;
  committedThroughFrame: number;
  words: LiveWord[];
  language: string;
  modelRevision: string;
}
interface SavedLiveDraft extends Omit<LiveDraft, 'language' | 'modelRevision'> {
  language?: string;
  modelRevision?: string;
}
export interface ExtensionRecording {
  recordingId: string;
  meetingId: string;
  status: string;
  totalFrames: number;
  generation?: number;
  captureState?: string;
  liveTranscription?: boolean;
  draft?: SavedLiveDraft | null | undefined;
}
export interface LeaseGrant {
  generation: number;
  expiresAt: number | string;
  totalFrames: number;
  draft: unknown;
}
export type LiveStatus =
  | 'live'
  | 'catching-up'
  | 'model-missing'
  | 'processing-busy'
  | 'paused-open-echo'
  | 'waiting-audio'
  | 'lease-held'
  | 'connection-error'
  | 'complete'
  | 'disabled';
export interface LiveState {
  recordingId: string;
  meetingId: string;
  status: LiveStatus;
  message?: string;
  draft?: SavedLiveDraft | null | undefined;
  backlogSeconds?: number;
  error?: string | undefined;
}
export interface ConnectionRequest {
  requestId: string;
  name: string;
  origin: string;
  expiresAt: number;
  status: string;
}
export interface RecorderState {
  status: string;
  elapsed: number;
  muted: boolean;
  level: number;
  hasPendingAudio: boolean;
  error?: string | undefined;
  meetingId?: string;
}

export type ExtensionMessage =
  | { type: 'ECHO_PRESENT'; origin?: string }
  | { type: 'ECHO_APPROVED'; requestId: string }
  | { type: 'ECHO_CONNECT'; intent: string };
export interface ExtensionReply {
  installed?: boolean;
  version?: string;
  ok?: boolean;
  status?: string;
  endpoint?: string;
  libraryId?: string;
}
