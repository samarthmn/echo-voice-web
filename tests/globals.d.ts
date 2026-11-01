import type { Meeting, RecorderState } from '../web/types/domain.ts';
import type { Chunk, Pair } from '../extension/src/core.ts';
declare global {
  var testMeeting: typeof import('../web/guards.ts').meeting;

  var journal: typeof import('../extension/src/storage.ts');
  var core: typeof import('../extension/src/core.ts');
  var readTestLink: typeof import('../extension/src/settings.ts').readLink;
  var testAPI: { journal: typeof journal; settings: typeof import('../extension/src/settings.ts') };
  var testExtensionRequest: (
    path: string,
    options?: RequestInit,
  ) => Promise<{ status: number; body?: unknown }>;
  var releaseCorruptionTransfer: () => void;
  var pair: Pair | undefined;
  var records: Map<
    string,
    {
      recordingId: string;
      libraryId: string | null;
      chunkCount: number;
      totalFrames: number;
      captureState: string;
      [key: string]: unknown;
    }
  >;
  var chunks: Map<string, Partial<Chunk>>;
  var deleted: string[];
  interface Window {
    __importFile: File;
    __progress: WindowEventMap['echo-upload-progress']['detail'][];
    __onboarding: {
      installed: string[];
      microphone: PermissionState;
      modelError: boolean;
      downloads: number;
      captures: number;
    };
    __captureTest: {
      micCalls: number;
      streams: MediaStream[];
      uploads: { url: string; sequence: FormDataEntryValue | null; bytes: number }[];
      states: RecorderState[];
      saved: Meeting[];
      contexts: AudioContext[];
    };
    __microphoneRequests: number;
    __testTracks: MediaStreamTrack[];
    __startupOriginalGetUserMedia?: typeof navigator.mediaDevices.getUserMedia;
    __releaseStartupMicrophone?: () => void;
    __originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia;
  }
}
export {};
