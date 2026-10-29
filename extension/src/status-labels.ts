import type { ConnectionStatus } from './connection';
import type { PairingView } from './pairing';
export type ConnectionView = PairingView & { revoked: boolean };
/** The contract's UI status: link state plus whether a connected Echo answers. */
export function connectionStatusOf(view: ConnectionView, online: boolean): ConnectionStatus {
  if (view.phase === 'connected') return online ? 'connected' : 'echo-offline';
  if (view.phase === 'waiting') return 'waiting';
  return view.revoked ? 'revoked' : 'none';
}
export const STATUS_DOT: Record<ConnectionStatus, string> = {
  connected: 'connected',
  'echo-offline': 'offline',
  revoked: 'revoked',
  waiting: '',
  none: '',
};
export function connectionSummary(status: ConnectionStatus, endpoint?: string): string {
  const host = endpoint ? new URL(endpoint).host : 'Echo';
  return {
    connected: `Connected to Echo · ${host}`,
    'echo-offline': 'Echo is offline — recordings upload automatically when it’s back.',
    waiting: 'Waiting for approval in Echo',
    revoked: 'Echo disconnected this browser',
    none: 'Not connected · recordings stay in this browser',
  }[status];
}
export function liveLabel(status: string, backlogSeconds = 0): string {
  const labels: Record<string, string> = {
    live: 'Live text',
    'catching-up': `Catching up · ${Math.ceil(backlogSeconds)} seconds behind`,
    'waiting-audio': 'Waiting for audio to reach Echo',
    'model-missing': 'Speech model missing · open Echo',
    'processing-busy': 'Speech processing busy',
    'paused-open-echo': 'Live text paused · open Echo',
    finalizing: 'Final transcript processing',
    'final-transcript-needed': 'Saved · open Echo to create final transcript',
    complete: 'Transcript complete',
    disabled: 'Live text is off',
    'not-connected': 'Connect Echo for live text',
    revoked: 'Echo disconnected this browser · connect again',
    unavailable: 'Echo unavailable · live text paused',
    deleted: 'Recording deleted in Echo',
    checking: 'Checking live text',
  };
  return labels[status] ?? 'Live text unavailable';
}
