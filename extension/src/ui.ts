import {Recording} from './core';
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
    item.append(copy);
    if(!row.receipt && row.chunkCount && row.recordingId !== activeRecordingId) {const button = document.createElement('button'); button.className = 'quiet'; button.textContent = 'Export'; button.addEventListener('click',() => exportRecording(row)); item.append(button);}
    list.append(item);
  }
}
