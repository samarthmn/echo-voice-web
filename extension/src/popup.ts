import {meetingFor, Recording, MAX_FRAMES} from './core';
import {action, duration, element, renderRecordings, request, showError} from './ui';
declare const chrome: any;
let tab: any; let active: any; let prefs: any; let busy = false; let initialized = false;
const startButton = element<HTMLButtonElement>('start'); const mic = element<HTMLInputElement>('mic'); const consent = element<HTMLInputElement>('consent');
function enableStart() {const meeting = meetingFor(tab?.url ?? ''); startButton.textContent = mic.checked ? 'Start recording':'Record call audio only'; startButton.disabled = busy || !consent.checked || !meeting || !prefs?.enabledProviders.includes(meeting.provider) || mic.checked && !prefs?.micGranted;}
async function refresh() {
  const state = await request({type:'STATE'}); prefs = state.settings; active = state.active;
  if(state.recoveryError) showError(new Error(state.recoveryError));
  if(!initialized) {
    [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    element<HTMLInputElement>('title').value = (tab?.title ?? 'Meeting').slice(0,200); mic.checked = prefs.micGranted; initialized = true;
    const selector = element<HTMLSelectElement>('mic-device'); const defaultOption = document.createElement('option'); defaultOption.value = 'default'; defaultOption.textContent = 'System default'; selector.append(defaultOption);
    if(prefs.micGranted) {
      for(const device of await navigator.mediaDevices.enumerateDevices()) if(device.kind === 'audioinput' && device.deviceId !== 'default') {const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || 'Microphone'; selector.append(option);}
      selector.value = prefs.micDeviceId || 'default'; if(!selector.value) selector.value = 'default';
    }
    element('mic-device-field').hidden = !mic.checked;
  }
  const meeting = meetingFor(tab?.url ?? '');
  element('meeting').textContent = meeting ? `${{meet:'Google Meet',zoom:'Zoom Web',teams:'Teams Web'}[meeting.provider]} · ${prefs.enabledProviders.includes(meeting.provider) ? 'Enabled. Ready to record.' : 'Not enabled. Open Setup to enable.'}` : 'Open your Google Meet, Zoom Web or Teams Web meeting, then click Echo again.';
  element('connection').textContent = prefs.activeLibraryId ? 'Connected to Echo' : 'Not connected';
  element('start-panel').hidden = !!active; element('active-panel').hidden = !active;
  if(active) {
    const row = state.recordings.find((row: Recording) => row.recordingId === active.recordingId);
    element('active-title').textContent = row?.title ?? 'Meeting'; element('duration').textContent = duration(row?.totalFrames ?? 0);
    element('capture-label').textContent = active.paused ? 'II · PAUSED':'REC · RECORDING';
    element('mic-source').textContent = active.mic === 'tab-only' ? 'Tab audio only' : active.mic;
    element('pause').textContent = active.paused ? 'Resume':'Pause'; element('limit-warning').hidden = (row?.totalFrames ?? 0) < MAX_FRAMES - 16000 * 15 * 60;
  }
  element('empty').hidden = state.recordings.length > 0;
  renderRecordings(state.recordings,(row: Recording) => {void chrome.tabs.create({url:chrome.runtime.getURL(`setup.html#recording=${encodeURIComponent(row.recordingId)}`)});},active?.recordingId); enableStart();
}
element('setup').addEventListener('click',() => {void chrome.runtime.openOptionsPage();});
consent.addEventListener('change',enableStart); mic.addEventListener('change',() => {element('mic-device-field').hidden = !mic.checked; enableStart();});
startButton.addEventListener('click',() => {busy = true; void action(async () => {
  await request({type:'START',tabId:tab.id,title:element<HTMLInputElement>('title').value,micEnabled:mic.checked,micDeviceId:element<HTMLSelectElement>('mic-device').value,consent:consent.checked,liveTranscription:element<HTMLInputElement>('live').checked});
  await refresh();
},startButton).finally(() => {busy = false; enableStart();});});
element('pause').addEventListener('click',() => {if(active) void action(async () => {await request({type:'CONTROL',recordingId:active.recordingId,action:active.paused ? 'resume':'pause'}); await refresh();},element<HTMLButtonElement>('pause'));});
element('stop').addEventListener('click',() => {if(active) void action(async () => {await request({type:'CONTROL',recordingId:active.recordingId,action:'stop'}); consent.checked = false; await refresh();},element<HTMLButtonElement>('stop'));});
element('retry').addEventListener('click',() => {void action(async () => {await request({type:'SYNC'}); await refresh();});});
void refresh().catch(showError); setInterval(() => {void refresh().catch(showError);},1000);
