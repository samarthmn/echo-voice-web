export const SAMPLE_RATE = 16000;
export const CHUNK_FRAMES = 16000;
export const MAX_FRAMES = SAMPLE_RATE * 60 * 60 * 8;
export const MAX_PENDING_BYTES = 2 * 1024 ** 3;
export const MAX_BACKLOG_FRAMES = SAMPLE_RATE * 5;
export const PART_FRAMES = SAMPLE_RATE * 60 * 30;
export const MIC_FRESH_MS = 2000;
export type Provider = 'meet' | 'zoom' | 'teams';
export type CaptureState = 'idle' | 'recording' | 'paused' | 'stopped' | 'interrupted';
export type TransferState = 'saved-local' | 'transferring' | 'saved-echo' | 'attention';
export const INTERRUPTION_DESCRIPTIONS = {
  'tab-loading':'The meeting tab began loading.', 'tab-closed':'The meeting tab closed.',
  'document-changed':'The meeting document changed.', 'meeting-changed':'The meeting identity changed.',
  'meeting-ended':'The provider reported that the meeting ended.', 'tab-track-ended':'The captured tab audio track ended.',
  'audio-suspended':'The audio capture context was suspended.', 'save-backlog':'Local audio saving fell behind.',
  'local-storage':'Local storage stopped accepting audio.', 'flush-failed':'The recorder could not finish saving audio.',
  'recorder-recovered':'The recorder restarted with unfinished audio.', 'start-failed':'Audio capture could not finish starting.',
  'capture-failed':'Audio capture was interrupted.',
} as const;
export type InterruptionReason = keyof typeof INTERRUPTION_DESCRIPTIONS;
export function interruption(reason: InterruptionReason, atFrame: number) {return {reason,at:new Date().toISOString(),atFrame};}
export type Observation = {state: 'unmuted' | 'muted' | 'prejoin' | 'ended' | 'unknown'; seq: number; url: string; documentId: string; receivedAt: number};
export type Recording = {
  recordingId: string; title: string; provider: Provider; meetingUrl: string; consent: true;
  liveTranscription: boolean; sampleRate: 16000; channels: 1; createdAt: string;
  libraryId: string | null; chunkCount: number; totalFrames: number; captureState: CaptureState;
  transferState: TransferState; gaps: {atFrame: number; pauseMs: number}[]; interrupted: boolean;
  error?: string; interruption?: ReturnType<typeof interruption>; receipt?: {libraryId: string; meetingId: string; verifiedAt: string};
};
export type Chunk = {recordingId: string; sequence: number; frames: number; sha256: string; pcm: ArrayBuffer};
export type Pair = {libraryId: string; credential: string; endpoint: string};
export type Settings = {installationId: string; endpoint: string; activeLibraryId: string | null; pairs: Record<string, Pair>; enabledProviders: Provider[]; micGranted: boolean; micDeviceId?: string};

export function endpointURL(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter an exact local Echo address, such as http://localhost:3000.');
  }
  return url.origin;
}
export function unixSecondsToMilliseconds(value: unknown): number {
  if(typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 8640000000000) throw new Error('Echo returned an invalid expiry timestamp.');
  return value * 1000;
}
export function meetingFor(raw: string): {provider: Provider; identity: string; originPattern: string} | null {
  let url: URL; try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) return {provider: 'meet', identity: url.origin + url.pathname.replace(/\/$/, ''), originPattern: 'https://meet.google.com/*'};
  if ((url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us') || url.hostname === 'app.zoom.com') && /^\/wc\/\d+(?:\/join)?\/?$/.test(url.pathname)) return {provider: 'zoom', identity: url.origin + url.pathname.replace(/\/join\/?$/, '').replace(/\/$/, ''), originPattern: url.hostname === 'app.zoom.com' ? 'https://app.zoom.com/*':'https://*.zoom.us/*'};
  if (['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(url.hostname) && (/^\/l\/meetup-join\//.test(url.pathname) || /^\/meet\//.test(url.pathname) || /^\/v2\/?$/.test(url.pathname) && /meetup-join|\/meet\//.test(url.hash))) return {provider: 'teams', identity: url.origin + url.pathname + url.hash, originPattern: `https://${url.hostname}/*`};
  return null;
}
export function microphoneAllowed(observation: Observation | undefined, identity: string, documentId: string | undefined, now = Date.now()): boolean {
  return !!observation && !!documentId && observation.documentId === documentId && observation.state === 'unmuted' && observation.receivedAt <= now && now - observation.receivedAt < MIC_FRESH_MS && meetingFor(observation.url)?.identity === identity;
}
export function validObservation(value: any): boolean {
  return value && ['unmuted','muted','prejoin','ended','unknown'].includes(value.state) && Number.isSafeInteger(value.seq) && value.seq >= 0 && typeof value.url === 'string';
}
export async function sha256(pcm: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pcm)), b => b.toString(16).padStart(2, '0')).join('');
}
export function wavHeader(frames: number): Uint8Array {
  const bytes = new Uint8Array(44); const view = new DataView(bytes.buffer);
  const text = (at: number, str: string) => [...str].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0,'RIFF'); view.setUint32(4,36 + frames * 2,true); text(8,'WAVE'); text(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,SAMPLE_RATE,true);
  view.setUint32(28,SAMPLE_RATE * 2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,frames * 2,true);
  return bytes;
}
