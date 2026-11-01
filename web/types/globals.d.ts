import type * as inference from '../inference.ts';
import type { autoTranscribeMeeting } from '../bridge.ts';
import type { createRecorderController } from '../recorder.ts';
import type { chooseJsonFile } from '../files.ts';
import type * as notes from '../notes.ts';
import type { createExtensionLiveController } from '../extension-live.ts';
import type {
  DownloadState,
  ExtensionMessage,
  ExtensionReply,
  LiveState,
  Meeting,
  Progress,
  RecorderState,
} from './domain.ts';
declare global {
  interface Window {
    echo: {
      upload(
        input: { files: ArrayLike<File> | null; value: string } | null,
      ): Promise<Meeting | undefined>;
      autoTranscribeMeeting: typeof autoTranscribeMeeting;
      retryUpload(meetingId: string): Promise<Meeting>;
      testMicrophone(): Promise<{ id: string; label: string }[]>;
      date(value: string | number, options?: Intl.DateTimeFormatOptions): string;
    };
    echoRecorder: ReturnType<typeof createRecorderController>;
    echoFiles: { chooseJsonFile: typeof chooseJsonFile };
    echoTheme: { current(): string; set(theme: string): string };
    echoNotes: {
      getDownloadState: typeof notes.getDownloadState;
      downloadModel: typeof notes.downloadModel;
    };
    echoInference: {
      models: typeof import('../models.ts').MODELS;
      getDownloadedModels: typeof inference.getDownloadedModels;
      getOutdatedModels: typeof inference.getOutdatedModels;
      getModelDownloadState: typeof inference.getModelDownloadState;
      getNativeSpeechStatus: typeof import('../native-speech.ts').getNativeSpeechStatus;
      removeModel: typeof inference.removeModel;
      cancelInference: typeof inference.cancelInference;
      transcribeAudio: typeof inference.transcribeAudio;
      transcribeMeeting: typeof inference.transcribeMeeting;
      getLiveModelStatus: typeof inference.getLiveModelStatus;
      transcribeLiveWindow: typeof inference.transcribeLiveWindow;
      cancelLiveInference: typeof inference.cancelLiveInference;
      releaseLiveInference: typeof inference.releaseLiveInference;
      getInferenceState: typeof inference.getInferenceState;
      suppressAutomaticTranscription(meetingIds: string[]): Promise<unknown>;
      downloadModel: typeof inference.downloadModel;
    };
    echoExtensionMessage(message: ExtensionMessage): Promise<ExtensionReply>;
    echoExtensionLive: ReturnType<typeof createExtensionLiveController>;
    echoExtensionStateListeners?: Record<string, EventListener>;
    echoAssetVersions?: Record<string, string>;
    echoReviewFollow?: boolean;
    echoPolls?: Record<string, () => void>;
    echoPollStop?: (id: string) => void;
    webkitAudioContext?: typeof AudioContext;
  }
  interface WindowEventMap {
    'echo-theme-change': CustomEvent<string>;
    'echo-notes-request': CustomEvent<{ meetingId: string; provider: 'ollama' }>;
    'echo-notes-download-state': CustomEvent<DownloadState & { model: string }>;
    'echo-model-download-state': CustomEvent<DownloadState & { modelId: string }>;
    'echo-open-models': Event;
    'echo-upload-progress': CustomEvent<{
      meetingId: string;
      fileName: string;
      bytes: number;
      total: number;
      progress: number;
      status: string;
      error?: string;
    }>;
    'echo-recorder-state': CustomEvent<RecorderState>;
    'echo-recording-saved': CustomEvent<Meeting>;
    'echo-library-changed': Event | CustomEvent<{ meetingId: string }>;
    'echo-extension-recording-progress': CustomEvent<Meeting>;
    'echo-extension-import-ready': CustomEvent<Meeting>;
    'echo-transcription-complete': CustomEvent<Meeting>;
    'echo-transcript-saved': CustomEvent<Pick<Meeting, 'id'>>;
    'echo-transcription-error': CustomEvent<{ meetingId: string; modelId?: string; error: string }>;
    'echo-transcription-start': CustomEvent<{ meetingId: string; modelId: string }>;
    'echo-transcription-cancelled': CustomEvent<{ meetingIds: string[] }>;
    'echo-model-progress': CustomEvent<Progress & { modelId: string; meetingId?: string }>;
    'echo-auto-transcription-skipped': CustomEvent<{
      meetingId: string;
      reason: string;
      message: string;
    }>;
    'echo-inference-state': CustomEvent<{ busy: boolean; liveJobId: string | null }>;
    'echo-extension-live-state': CustomEvent<{ recordings: LiveState[] }>;
  }
}
export {};
