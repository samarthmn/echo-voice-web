import type { ExtensionState } from './background.ts';
import type { Observation, Provider, Recording, InterruptionReason } from './core.ts';
import type { ActiveStatus } from './offscreen.ts';
import type { pendingConnect, pairingView } from './pairing.ts';
import type { connectionStatus, livePreview } from './connection.ts';
import type { Settled } from './upload-scheduler.ts';

export interface Reply<T = unknown> {
  ok?: boolean;
  error?: string;
  value: T;
}
export interface StartRequest {
  tabId: number;
  consent?: boolean;
  title?: string | number | boolean | null | undefined;
  micEnabled?: boolean;
  micDeviceId?: string | undefined;
  liveTranscription?: boolean;
}
export type PageMessage =
  | ({ type: 'START' } & StartRequest)
  | {
      type:
        | 'STATE'
        | 'CONNECT_REQUEST'
        | 'CONNECTION_STATUS'
        | 'PAIR_CANCEL'
        | 'PAIR_SHOW_APPROVAL'
        | 'SYNC';
    }
  | { type: 'CONNECT_CONFIRM'; id: string; previous?: string }
  | { type: 'LIVE_PREVIEW'; recordingId: string }
  | { type: 'MIC_EXCLUSION'; recordingId: string; excluded?: boolean }
  | { type: 'OPEN_ECHO'; recordingId?: string }
  | { type: 'DELETE_RECORDING'; recordingId: string; confirmed?: boolean }
  | { type: 'CONTROL'; recordingId: string; action: string }
  | { type: 'PAIR_BEGIN'; endpoint?: string }
  | { type: 'DISCONNECT'; forgetLocally?: boolean }
  | { type: 'MIC_GRANTED'; granted?: boolean }
  | { type: 'PROVIDER_ENABLED'; provider: Provider; enabled?: boolean }
  | { type: 'REMEMBER_CONSENT'; provider: Provider; remember?: boolean }
  | { type: 'LIVE_TEXT_DEFAULT'; enabled?: boolean };
export interface PageReplies {
  STATE: ExtensionState;
  CONNECT_REQUEST: Awaited<ReturnType<typeof pendingConnect>>;
  CONNECTION_STATUS: Awaited<ReturnType<typeof connectionStatus>>;
  LIVE_PREVIEW: Awaited<ReturnType<typeof livePreview>>;
  PAIR_BEGIN: Awaited<ReturnType<typeof pairingView>>;
  PAIR_CANCEL: Awaited<ReturnType<typeof pairingView>>;
  PAIR_SHOW_APPROVAL: Awaited<ReturnType<typeof pairingView>>;
  CONNECT_CONFIRM: Awaited<ReturnType<typeof pairingView>>;
}
export interface OffscreenStatus {
  active: ActiveStatus | null;
  error?: string | undefined;
  busy: boolean;
}
export type OffscreenMessage =
  | {
      type: 'START';
      streamId: string;
      micEnabled: boolean;
      micDeviceId: string;
      recording: Omit<
        Recording,
        'chunkCount' | 'totalFrames' | 'captureState' | 'transferState' | 'gaps' | 'interrupted'
      >;
    }
  | {
      type: 'CONTROL';
      recordingId: string;
      action: string;
      interrupted?: boolean;
      interruptionReason?: InterruptionReason;
    }
  | { type: 'MIC_EXCLUSION'; recordingId: string; excluded: boolean }
  | {
      type: 'GATE';
      recordingId: string;
      gateRevision: number;
      allowed: boolean;
      ttlMs?: number;
      expiresAt?: number;
      state?: string;
    }
  | { type: 'SYNC'; failures?: number }
  | { type: 'STATUS' };
export type BackgroundMessage =
  | { type: 'TRUSTED_LINK' }
  | { type: 'TRUSTED_REVOKE'; credential: string; endpoint: string }
  | {
      type: 'CAPTURE_STATUS';
      active?: ActiveStatus | null;
      error?: string;
      endedRecordingId?: string;
    }
  | ({ type: 'UPLOADS_SETTLED' } & Partial<Settled>);
export interface ObservationMessage {
  type: 'MUTE_OBSERVATION' | 'MEETING_PAGEHIDE';
  state: Observation['state'];
  seq: number;
  observedAt: number;
  url: string;
}
export type ProcessorMessage =
  | {
      type: 'gate';
      recordingId: string;
      gateRevision: number;
      allowed: boolean;
      ttlMs?: number;
      expiresAt?: number;
    }
  | { type: 'exclude-mic'; recordingId: string; exclusionRevision: number; excluded: boolean }
  | { type: 'committed'; throughFrame: number }
  | { type: 'pause' | 'stop'; requestId: string }
  | { type: 'revoke-mic' | 'resume' };
export type ProcessorReply =
  | { type: 'flushed'; requestId: string }
  | { type: 'failed'; reason: string }
  | { type: 'pcm'; frames: number; pcm: ArrayBuffer };
export interface ProcessorOptions {
  processorOptions?: { recordingId?: string };
}
