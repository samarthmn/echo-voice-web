import type * as GuardsModule from '../web/guards.ts';
import type * as StorageModule from '../extension/src/storage.ts';
import type * as CoreModule from '../extension/src/core.ts';
import type * as SettingsModule from '../extension/src/settings.ts';
import type { Meeting, RecorderState } from '../web/types/domain.ts';
import type { Chunk, Pair } from '../extension/src/core.ts';
declare global {
  var testMeeting: typeof GuardsModule.meeting;

  var journal: typeof StorageModule;
  var core: typeof CoreModule;
  var readTestLink: typeof SettingsModule.readLink;
  var testAPI: { journal: typeof journal; settings: typeof SettingsModule };
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
