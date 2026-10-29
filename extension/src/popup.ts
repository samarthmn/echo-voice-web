import { meetingFor, Recording, MAX_FRAMES } from './core';
import type { ExtensionState } from './background';
import {
  action,
  duration,
  element,
  lockedNotice,
  renderRecordings,
  request,
  showError,
} from './ui';
import { liveLabel } from './status-labels';
import { connectionCard } from './connection-card';
let tab: chrome.tabs.Tab | undefined;
let active: ExtensionState['active'];
let prefs: ExtensionState['settings'] | undefined;
let busy = false;
let initialized = false;
let refreshing: Promise<void> | undefined;
let hostGranted = false;
let micGranted = false;
let checkingStatus = false;
let liveRecordingId: string | undefined;
const connection = connectionCard(refresh);
async function refreshStatus() {
  if (checkingStatus) return;
  checkingStatus = true;
  try {
    const result = await request({ type: 'CONNECTION_STATUS' });
    connection.setOnline(result.status !== 'echo-offline');
    const id = liveRecordingId;
    if (id) {
      const live = await request({ type: 'LIVE_PREVIEW', recordingId: id });
      if (liveRecordingId === id) {
        element('live-status').textContent = liveLabel(live.status, live.backlogSeconds);
        element('live-preview').textContent = live.preview;
        element('live-provisional').hidden = !live.provisional;
      }
    }
  } finally {
    checkingStatus = false;
  }
}
const startButton = element<HTMLButtonElement>('start');
const mic = element<HTMLInputElement>('mic');
const consent = element<HTMLInputElement>('consent');
const rememberConsent = element<HTMLInputElement>('remember-consent');
const live = element<HTMLInputElement>('live');
const PROVIDER_NAMES = { meet: 'Google Meet', zoom: 'Zoom Web', teams: 'Teams Web' } as const;
/** Participant consent the user asked Echo to remember for this tab's meeting service. */
function consentRemembered(): boolean {
  const meeting = meetingFor(tab?.url ?? '');
  return !!meeting && !!prefs?.rememberedConsent.includes(meeting.provider);
}
function enableStart() {
  const meeting = meetingFor(tab?.url ?? '');
  startButton.textContent = mic.checked ? 'Start recording' : 'Record call audio only';
  startButton.disabled =
    busy ||
    !consent.checked ||
    !meeting ||
    !prefs?.enabledProviders.includes(meeting.provider) ||
    !hostGranted ||
    (mic.checked && !micGranted);
}
function refresh(): Promise<void> {
  if (!refreshing)
    refreshing = refreshState().finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
async function refreshState() {
  const state: ExtensionState = await request({ type: 'STATE' });
  const settings = state.settings;
  prefs = settings;
  active = state.active;
  connection.update(state.connection);
  element('unlock-older').hidden = !lockedNotice(
    state.recordings,
    connection.status() === 'connected',
    state.migrationError,
  );
  if (state.recoveryError) showError(new Error(state.recoveryError));
  try {
    micGranted =
      (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state ===
      'granted';
  } catch (error) {
    console.warn('Echo: microphone permission state is unavailable.', error);
    micGranted = false;
  }
  if (!initialized) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    element<HTMLInputElement>('title').value = (tab?.title ?? 'Meeting').slice(0, 200);
    mic.checked = settings.micGranted && micGranted;
    live.checked = settings.liveTranscription;
    consent.checked = rememberConsent.checked = consentRemembered();
    initialized = true;
    const selector = element<HTMLSelectElement>('mic-device');
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = 'System default';
    selector.append(defaultOption);
    if (micGranted) {
      for (const device of await navigator.mediaDevices.enumerateDevices())
        if (device.kind === 'audioinput' && device.deviceId !== 'default') {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || 'Microphone';
          selector.append(option);
        }
      selector.value = settings.micDeviceId || 'default';
      if (!selector.value) selector.value = 'default';
    }
    element('mic-device-field').hidden = !mic.checked;
  }
  const meeting = meetingFor(tab?.url ?? '');
  hostGranted =
    !!meeting && (await chrome.permissions.contains({ origins: [meeting.originPattern] }));
  const enabled = !!meeting && settings.enabledProviders.includes(meeting.provider) && hostGranted;
  element('readiness-action').hidden =
    !!active || (!!meeting && enabled && (!mic.checked || micGranted));
  element('readiness-action').textContent =
    meeting && !enabled
      ? 'Enable this meeting service'
      : mic.checked && !micGranted
        ? 'Allow microphone in setup'
        : 'Open setup';
  element('remember-consent-field').hidden = !meeting;
  if (meeting) element('remember-provider').textContent = PROVIDER_NAMES[meeting.provider];
  element('meeting').textContent = meeting
    ? `${PROVIDER_NAMES[meeting.provider]} · ${enabled ? (mic.checked && !micGranted ? 'Microphone access is missing. Open Setup or uncheck Include my microphone.' : 'Enabled. Ready to record.') : 'Not enabled. Open Setup to enable.'}`
    : 'Open your Google Meet, Zoom Web or Teams Web meeting, then click Echo again.';
  element('start-panel').hidden = !!active;
  element('active-panel').hidden = !active;
  if (active) {
    const recordingId = active.recordingId;
    const row = state.recordings.find((row: Recording) => row.recordingId === recordingId);
    element('active-title').textContent = active.title || 'Meeting';
    element('duration').textContent = duration(row?.totalFrames ?? 0);
    element('capture-label').textContent = active.paused ? 'II · PAUSED' : 'REC · RECORDING';
    element('mic-source').textContent =
      active.mic === 'tab-only'
        ? 'Call audio only'
        : /unknown|stale|unrecognized/.test(active.mic ?? '')
          ? 'Voice excluded · meeting controls unknown'
          : active.mic;
    element('mic-exclusion-field').hidden = !active.micCaptured;
    element<HTMLInputElement>('mic-exclusion').checked = !!active.micExcluded;
    element<HTMLInputElement>('mic-exclusion').disabled = !active.micAvailable;
    const liveId = row?.liveTranscription ? active.recordingId : undefined;
    if (liveId !== liveRecordingId) {
      element('live-status').textContent = liveLabel('checking');
      element('live-preview').textContent = '';
      element('live-provisional').hidden = true;
    }
    liveRecordingId = liveId;
    element('live-panel').hidden = !liveId;
    element('pause').textContent = active.paused ? 'Resume' : 'Pause';
    element('limit-warning').hidden = (row?.totalFrames ?? 0) < MAX_FRAMES - 16000 * 15 * 60;
  }
  if (!active) {
    liveRecordingId = undefined;
    element('live-panel').hidden = true;
  }
  element('empty').hidden = state.recordings.length > 0;
  renderRecordings(
    state.recordings,
    (row: Recording) => {
      chrome.tabs
        .create({
          url: chrome.runtime.getURL(`setup.html#recording=${encodeURIComponent(row.recordingId)}`),
        })
        .catch(showError);
    },
    active?.recordingId,
  );
  enableStart();
}
element('unlock-older').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('setup.html#unlock') }).catch(showError);
});
for (const id of ['readiness-action', 'setup'])
  element(id).addEventListener('click', () => {
    chrome.runtime.openOptionsPage().catch(showError);
  });
element('open-echo').addEventListener('click', () => {
  void action(async () => {
    await request({ type: 'OPEN_ECHO', recordingId: active?.recordingId });
  }, element<HTMLButtonElement>('open-echo'));
});
element('mic-exclusion').addEventListener('change', () => {
  const current = active;
  if (current)
    void action(async () => {
      await request({
        type: 'MIC_EXCLUSION',
        recordingId: current.recordingId,
        excluded: element<HTMLInputElement>('mic-exclusion').checked,
      });
      await refresh();
    });
});
consent.addEventListener('change', enableStart);
rememberConsent.addEventListener('change', () => {
  const meeting = meetingFor(tab?.url ?? '');
  if (!meeting) return;
  // Remembering consent confirms it for this recording too.
  if (rememberConsent.checked) consent.checked = true;
  enableStart();
  void action(async () => {
    await request({
      type: 'REMEMBER_CONSENT',
      provider: meeting.provider,
      remember: rememberConsent.checked,
    });
    await refresh();
  });
});
live.addEventListener('change', () => {
  void action(() =>
    request({ type: 'LIVE_TEXT_DEFAULT', enabled: live.checked }).then(() => undefined),
  );
});
mic.addEventListener('change', () => {
  element('mic-device-field').hidden = !mic.checked;
  enableStart();
});
startButton.addEventListener('click', () => {
  busy = true;
  void action(async () => {
    await request({
      type: 'START',
      tabId: tab?.id,
      title: element<HTMLInputElement>('title').value,
      micEnabled: mic.checked,
      micDeviceId: element<HTMLSelectElement>('mic-device').value,
      consent: consent.checked,
      liveTranscription: live.checked,
    });
    await refresh();
  }, startButton).finally(() => {
    busy = false;
    enableStart();
  });
});
element('pause').addEventListener('click', () => {
  const current = active;
  if (current)
    void action(async () => {
      await request({
        type: 'CONTROL',
        recordingId: current.recordingId,
        action: current.paused ? 'resume' : 'pause',
      });
      await refresh();
    }, element<HTMLButtonElement>('pause'));
});
element('stop').addEventListener('click', () => {
  const current = active;
  if (current)
    void action(async () => {
      await request({ type: 'CONTROL', recordingId: current.recordingId, action: 'stop' });
      consent.checked = consentRemembered();
      await refresh();
    }, element<HTMLButtonElement>('stop'));
});
element('retry').addEventListener('click', () => {
  void action(async () => {
    await request({ type: 'SYNC' });
    await refresh();
  });
});
void refreshStatus().catch(showError);
setInterval(() => {
  void refreshStatus().catch(showError);
}, 5000);
void refresh().catch(showError);
setInterval(() => {
  void refresh().catch(showError);
}, 1000);
