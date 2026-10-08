import {Provider, Recording} from './core';
import {allRecordings, exportParts, recording} from './storage';
import {action, element, renderRecordings, request, showError} from './ui';
declare const chrome: any;
const providers: {id:Provider;name:string;origins:string[]}[] = [
  {id:'meet',name:'Google Meet',origins:['https://meet.google.com/*']},
  {id:'zoom',name:'Zoom Web',origins:['https://*.zoom.us/*','https://app.zoom.com/*']},
  {id:'teams',name:'Microsoft Teams Web',origins:['https://teams.microsoft.com/*','https://teams.live.com/*','https://teams.cloud.microsoft/*']},
];
let prefs: any; let initialized = false; let claimTimer: ReturnType<typeof setInterval> | undefined;
let exportIterator: AsyncGenerator<any> | undefined; let exportURL: string | undefined; let timelineURL: string | undefined; let exportRow: Recording | undefined;
function status(text: string) {element('status').textContent = text; element('status').hidden = false;}
async function refresh() {
  const state = await request({type:'STATE'}); prefs = state.settings;
  if(state.recoveryError) showError(new Error(state.recoveryError));
  if(!initialized) {element<HTMLInputElement>('endpoint').value = prefs.endpoint; initialized = true;}
  element('paired').textContent = prefs.activeLibraryId ? `Connected to library ${prefs.activeLibraryId}. New recordings will use this library.` : 'Not paired. You can record and export locally.';
  element('mic-status').textContent = prefs.micGranted ? 'Permission granted. Choose whether to include it when starting.' : 'Not granted. Tab audio only is available.';
  const list = element('providers'); list.replaceChildren();
  for(const provider of providers) {
    const row = document.createElement('div'); row.className = 'provider'; const label = document.createElement('span'); const enabled = prefs.enabledProviders.includes(provider.id); label.textContent = `${provider.name} · ${enabled ? 'Enabled':'Not enabled'}`;
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = enabled ? 'Disable':'Enable';
    button.addEventListener('click',() => {
      // Request the provider grant directly within the user's click before any asynchronous work.
      const permission = enabled ? chrome.permissions.remove({origins:provider.origins}) : chrome.permissions.request({origins:provider.origins});
      void action(async () => {const granted = await permission; if(!enabled && !granted) throw new Error('Provider access was not granted. You can enable it later.'); await request({type:'PROVIDER_ENABLED',provider:provider.id,enabled:!enabled}); await refresh();},button);
    }); row.append(label,button); list.append(row);
  }
  renderRecordings(state.recordings,(row: Recording) => {void action(() => beginExport(row));},state.active?.recordingId);
}
element('microphone').addEventListener('click',() => {void action(async () => {
  try {const stream = await navigator.mediaDevices.getUserMedia({audio:true,video:false}); stream.getTracks().forEach(track => track.stop()); await request({type:'MIC_GRANTED',granted:true}); status('Microphone permission granted. Start recording from your meeting tab.');}
  catch {await request({type:'MIC_GRANTED',granted:false}); status('Microphone access was denied. Explicitly leave “Include my microphone” unchecked in the popup to record tab audio only.');}
  await refresh();
},element<HTMLButtonElement>('microphone'));});
element('request').addEventListener('click',() => {void action(async () => {
  const result = await request({type:'PAIR_REQUEST',endpoint:element<HTMLInputElement>('endpoint').value,code:element<HTMLInputElement>('code').value,name:element<HTMLInputElement>('name').value});
  status(`Pairing request sent. Approve this browser in Echo before ${new Date(result.expiresAtMs).toLocaleTimeString()}.`);
  if(claimTimer) clearInterval(claimTimer);
  claimTimer = setInterval(() => {void claim().catch(error => {if(claimTimer) clearInterval(claimTimer); showError(error);});},2000);
},element<HTMLButtonElement>('request'));});
async function claim(confirmLibrary = false) {
  const result = await request({type:'PAIR_CLAIM',confirmLibrary});
  if(result.status === 'pending') {status('Waiting for you to approve this browser in Echo.'); return;}
  if(claimTimer) {clearInterval(claimTimer); claimTimer = undefined;}
  if(result.status === 'confirm-library') {element('library-confirm').hidden = false; status(`${result.pendingCount} recordings are still saved locally. Confirm the new library below.`); return;}
  element('library-confirm').hidden = true; element<HTMLInputElement>('code').value = ''; status('Paired. Saved audio will transfer when Echo is available.'); await refresh();
}
element('claim').addEventListener('click',() => {void action(() => claim(),element<HTMLButtonElement>('claim'));});
element('confirm-library').addEventListener('click',() => {void action(() => claim(true),element<HTMLButtonElement>('confirm-library'));});
element('retry').addEventListener('click',() => {void action(async () => {await request({type:'SYNC'}); status('Transfer retry requested. Audio stays local until Echo confirms it.'); await refresh();});});
async function beginExport(row: Recording) {
  if(exportIterator) await exportIterator.return(undefined);
  exportRow = row; exportIterator = exportParts(row.recordingId); element('exports').hidden = false; element('export-title').textContent = row.title;
  if(timelineURL) URL.revokeObjectURL(timelineURL);
  timelineURL = URL.createObjectURL(new Blob([JSON.stringify({recordingId:row.recordingId,title:row.title,sampleRate:row.sampleRate,channels:row.channels,totalFrames:row.totalFrames,gaps:row.gaps,interrupted:row.interrupted,interruption:row.interruption,partsAreSequential:true},null,2)],{type:'application/json'}));
  const timeline = element<HTMLAnchorElement>('download-timeline'); timeline.href = timelineURL; timeline.download = `echo-${row.recordingId}-timeline.json`; timeline.hidden = false;
  await nextPart(); element('exports').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function nextPart() {
  if(!exportIterator || !exportRow) return;
  element('next-part').hidden = true; element('download-part').hidden = true; element('export-progress').textContent = 'Checking local audio and preparing WAV part…';
  if(exportURL) {URL.revokeObjectURL(exportURL); exportURL = undefined;}
  const next = await exportIterator.next();
  if(next.done) {element('export-progress').textContent = 'All sequential WAV parts are ready. Keep them in order with the timeline file.'; exportIterator = undefined; return;}
  const part = next.value; exportURL = URL.createObjectURL(part.blob); const download = element<HTMLAnchorElement>('download-part'); download.href = exportURL; download.download = `echo-${exportRow.recordingId}-part-${String(part.part).padStart(2,'0')}.wav`; download.textContent = `Download WAV part ${part.part}`; download.hidden = false;
  element('export-progress').textContent = `Part ${part.part} · starts at ${Math.floor(part.startFrame / 16000)} seconds · ${Math.round(part.frames / 16000)} seconds of audio.`;
  element('next-part').hidden = false;
}
element('next-part').addEventListener('click',() => {void action(nextPart,element<HTMLButtonElement>('next-part'));});
window.addEventListener('pagehide',() => {if(exportURL) URL.revokeObjectURL(exportURL); if(timelineURL) URL.revokeObjectURL(timelineURL); if(claimTimer) clearInterval(claimTimer);});
void refresh().then(async () => {const params = new URLSearchParams(location.hash.slice(1)); const id = params.get('recording'); if(id) {const row = await recording(id); if(row) await beginExport(row);}}).catch(showError);
setInterval(() => {void refresh().catch(showError);},3000);
