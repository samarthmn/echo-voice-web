import {Recording, INTERRUPTION_DESCRIPTIONS} from './core';
declare const chrome: any;
export function element<T extends HTMLElement = HTMLElement>(id: string): T {return document.getElementById(id) as T;}
export async function request(message: any): Promise<any> {const response = await chrome.runtime.sendMessage(message); if(!response?.ok) throw new Error(response?.error ?? 'Echo extension did not respond.'); return response.value;}
export function showError(error: unknown) {const node = element('error'); node.textContent = (error as Error).message ?? String(error); node.hidden = false;}
export async function action(work: () => Promise<void>, button?: HTMLButtonElement) {
  element('error').hidden = true; if(button) button.disabled = true;
  try {await work();} catch(error) {showError(error);} finally {if(button) button.disabled = false;}
}
export function duration(frames: number): string {const seconds = Math.floor(frames / 16000); return `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;}
export function renderRecordings(rows: Recording[], exportRecording: (row: Recording) => void, activeRecordingId?: string) {
  const list = element('recordings'); list.replaceChildren();
  const sorted = [...rows].sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  for(const stored of sorted) {
    const row: Recording = ['recording','paused'].includes(stored.captureState) && stored.recordingId !== activeRecordingId ? {...stored,captureState:'interrupted',interrupted:true}:stored;
    const item = document.createElement('div'); item.className = 'recording-row';
    const copy = document.createElement('div'); copy.className = 'recording-copy'; const title = document.createElement('strong'); title.textContent = row.title;
    const text = document.createElement('p'); const transfer = {'saved-local':'Saved locally','transferring':'Transferring to Echo','saved-echo':'Saved in Echo','attention':'Needs attention'}[row.transferState];
    text.textContent = `${duration(row.totalFrames)} · ${row.captureState === 'interrupted' ? 'Interrupted · ' : row.captureState === 'paused' ? 'Paused · ' : row.captureState === 'recording' ? 'Recording · ' : ''}${transfer}`;
    copy.append(title,text); if(row.error) {const error = document.createElement('p'); error.className = 'attention'; error.textContent = row.error; copy.append(error);}
    if(row.interruption) {const reason = document.createElement('p'); reason.className = 'attention'; reason.textContent = `Interrupted at ${duration(row.interruption.atFrame)}: ${INTERRUPTION_DESCRIPTIONS[row.interruption.reason] ?? INTERRUPTION_DESCRIPTIONS['capture-failed']}`; copy.append(reason);}
    item.append(copy);
    const actions = document.createElement('div'); actions.className = 'recording-actions';
    if(row.receipt) {const button = document.createElement('button'); button.className = 'quiet'; button.textContent = 'Open in Echo'; button.addEventListener('click',() => {void action(async () => {await request({type:'OPEN_ECHO',recordingId:row.recordingId});},button);}); actions.append(button);}
    if(!row.receipt && row.chunkCount && row.recordingId !== activeRecordingId) {const button = document.createElement('button'); button.className = 'quiet'; button.textContent = 'Export'; button.addEventListener('click',() => exportRecording(row)); actions.append(button);}
    if(row.recordingId !== activeRecordingId) {
      const button = document.createElement('button'); button.className = 'quiet danger'; button.textContent = row.receipt ? 'Remove receipt':'Delete local audio';
      button.addEventListener('click',() => {
        const warning = row.receipt ? 'Remove this browser’s recording receipt? The recording and audio saved in Echo will remain.' : 'Permanently delete this browser’s recording and audio? Echo has not confirmed a complete copy. Export first if you want to keep it. Any audio already transferred to Echo will remain.';
        if(!window.confirm(warning)) return;
        void action(async () => {await request({type:'DELETE_RECORDING',recordingId:row.recordingId,confirmed:true}); item.remove();},button);
      }); actions.append(button);
    }
    item.append(actions);
    list.append(item);
  }
}
