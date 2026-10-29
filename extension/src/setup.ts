import { Provider, Recording } from './core';
import type { ExtensionState } from './background';
import { exportParts, recording } from './storage';
import { action, element, lockedNotice, renderRecordings, request, showError } from './ui';
import { connectionCard } from './connection-card';
type ExportPart = { blob: Blob; part: number; startFrame: number; frames: number };
const providers: { id: Provider; name: string; origins: string[] }[] = [
  { id: 'meet', name: 'Google Meet', origins: ['https://meet.google.com/*'] },
  { id: 'zoom', name: 'Zoom Web', origins: ['https://*.zoom.us/*', 'https://app.zoom.com/*'] },
  {
    id: 'teams',
    name: 'Microsoft Teams Web',
    origins: [
      'https://teams.microsoft.com/*',
      'https://teams.live.com/*',
      'https://teams.cloud.microsoft/*',
    ],
  },
];
let initialized = false;
let checkingConnection = false;
let pendingCount = 0;
let capturing = false;
let refreshing: Promise<void> | undefined;
let choices = { callOnly: false };
const completion = new Map<string, boolean>();
const providerControls = new Map<
  Provider,
  { label: HTMLSpanElement; button: HTMLButtonElement; enabled: boolean }
>();
const connection = connectionCard(refresh);
/** Collapse a step when it becomes complete; reopen it if it stops being complete (revoked). */
function completeStep(id: string, complete: boolean) {
  const step = element<HTMLDetailsElement>(id);
  const was = completion.get(id);
  if (complete && !was && !step.contains(document.activeElement)) step.open = false;
  if (!complete && was) step.open = true;
  completion.set(id, complete);
}
async function saveChoice(patch: Partial<typeof choices>) {
  choices = { ...choices, ...patch };
  await chrome.storage.local.set({ onboardingChoices: choices });
}
async function microphonePermission(): Promise<boolean> {
  try {
    return (
      (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state ===
      'granted'
    );
  } catch (error) {
    console.warn('Echo: microphone permission state is unavailable.', error);
    return false;
  }
}
async function refreshConnection() {
  if (checkingConnection) return;
  checkingConnection = true;
  try {
    const result = await request({ type: 'CONNECTION_STATUS' });
    connection.setOnline(result.status !== 'echo-offline');
  } finally {
    checkingConnection = false;
  }
}
let exportIterator: AsyncGenerator<ExportPart> | undefined;
let exportURL: string | undefined;
let timelineURL: string | undefined;
let exportRow: Recording | undefined;
function status(text: string) {
  element('status').textContent = text;
  element('status').hidden = false;
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
  const prefs = state.settings;
  if (state.recoveryError) showError(new Error(state.recoveryError));
  if (!initialized) {
    const saved = (await chrome.storage.local.get('onboardingChoices')).onboardingChoices as
      | Partial<typeof choices>
      | undefined;
    choices = { callOnly: saved?.callOnly === true };
    initialized = true;
  }
  connection.update(state.connection);
  const connected = state.connection.phase === 'connected';
  element('disconnect').hidden = !connected;
  lockedNotice(state.recordings, connected, state.migrationError);
  pendingCount = state.recordings.filter((row) => !row.receipt && row.chunkCount).length;
  capturing = !!state.active;
  const micGranted = await microphonePermission();
  if (prefs.micGranted && !micGranted) {
    await request({ type: 'MIC_GRANTED', granted: false });
    prefs.micGranted = false;
  }
  element('mic-status').textContent = choices.callOnly
    ? 'Call audio only selected. Your microphone will start excluded.'
    : micGranted
      ? 'Microphone access allowed. Meeting mute always applies.'
      : 'Microphone access is not allowed. Allow it here, or choose Record call audio only.';
  let enabledCount = 0;
  for (const provider of providers) {
    const control = providerControls.get(provider.id);
    if (!control) continue;
    const granted = await chrome.permissions.contains({ origins: provider.origins });
    control.enabled = prefs.enabledProviders.includes(provider.id) && granted;
    if (control.enabled) enabledCount++;
    control.label.textContent = `${provider.name} · ${control.enabled ? 'Enabled' : 'Not enabled'}`;
    control.button.textContent = control.enabled ? 'Disable' : 'Enable';
    control.button.setAttribute(
      'aria-label',
      `${control.enabled ? 'Disable' : 'Enable'} ${provider.name}`,
    );
  }
  element('connect-summary').textContent = connected
    ? 'Connected to Echo'
    : 'Optional · recordings stay in this browser until you connect';
  element('provider-summary').textContent = enabledCount
    ? `${enabledCount} meeting site${enabledCount === 1 ? '' : 's'} enabled`
    : 'Enable the meeting site you use';
  element('mic-summary').textContent = choices.callOnly
    ? 'Call audio only'
    : micGranted
      ? 'Microphone allowed · meeting mute applies'
      : 'Choose microphone or call audio only';
  completeStep('connect-step', connected);
  completeStep('provider-step', enabledCount > 0);
  completeStep('microphone-step', micGranted || choices.callOnly);
  element('ready').hidden = !enabledCount || !(micGranted || choices.callOnly);
  renderRecordings(
    state.recordings,
    (row: Recording) => {
      void action(() => beginExport(row.recordingId));
    },
    state.active?.recordingId,
  );
}
// Create once: periodic state refresh must not replace focused provider controls.
for (const provider of providers) {
  const row = document.createElement('div');
  row.className = 'provider';
  const label = document.createElement('span');
  const button = document.createElement('button');
  button.className = 'secondary';
  button.textContent = 'Enable';
  const control = { label, button, enabled: false };
  providerControls.set(provider.id, control);
  button.addEventListener('click', () => {
    const enabled = control.enabled;
    const permission = enabled
      ? chrome.permissions.remove({ origins: provider.origins })
      : chrome.permissions.request({ origins: provider.origins });
    void action(async () => {
      const granted = await permission;
      if (!enabled && !granted)
        throw new Error('Meeting-site access was not granted. Choose Enable to try again.');
      await request({ type: 'PROVIDER_ENABLED', provider: provider.id, enabled: !enabled });
      await refresh();
    }, button);
  });
  row.append(label, button);
  element('providers').append(row);
}
element('call-only').addEventListener('click', () => {
  void action(async () => {
    await saveChoice({ callOnly: true });
    await request({ type: 'MIC_GRANTED', granted: false });
    status(
      'Call audio only selected. Return to your meeting tab and press Start when everyone has consented.',
    );
    await refresh();
  });
});
element('microphone').addEventListener('click', () => {
  void action(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      await request({ type: 'MIC_GRANTED', granted: true });
      await saveChoice({ callOnly: false });
      status('Microphone allowed. Return to your meeting tab and press Start.');
    } catch (error) {
      console.warn('Echo: microphone access was not granted.', error);
      await request({ type: 'MIC_GRANTED', granted: false });
      status(
        'Microphone access was denied. Choose Record call audio only to continue, or allow microphone access in browser settings and retry.',
      );
    }
    await refresh();
  }, element<HTMLButtonElement>('microphone'));
});
element('disconnect').addEventListener('click', () => {
  if (
    !window.confirm(
      `Disconnect this browser from Echo? ${pendingCount} recording${pendingCount === 1 ? '' : 's'} still need to upload. ${capturing ? 'The active recording continues here. ' : ''}Recordings stay saved in this browser until you connect again.`,
    )
  )
    return;
  void action(async () => {
    await request({ type: 'DISCONNECT' });
    status('Disconnected from Echo. Recordings stay saved in this browser.');
    await refresh();
  }, element<HTMLButtonElement>('disconnect'));
});
element('retry').addEventListener('click', () => {
  void action(async () => {
    await request({ type: 'SYNC' });
    status('Upload retry requested. Audio stays here until Echo confirms it.');
    await refresh();
  });
});
async function beginExport(id: string) {
  // Lists carry summaries only; export opens the full recording with its device key.
  const row = await recording(id);
  if (!row) throw new Error('This local recording is no longer available.');
  if (exportIterator) await exportIterator.return(undefined);
  exportRow = row;
  exportIterator = exportParts(row.recordingId);
  element('exports').hidden = false;
  element('export-title').textContent = row.title;
  if (timelineURL) URL.revokeObjectURL(timelineURL);
  timelineURL = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            recordingId: row.recordingId,
            title: row.title,
            sampleRate: row.sampleRate,
            channels: row.channels,
            totalFrames: row.totalFrames,
            gaps: row.gaps,
            interrupted: row.interrupted,
            interruption: row.interruption,
            partsAreSequential: true,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
  );
  const timeline = element<HTMLAnchorElement>('download-timeline');
  timeline.href = timelineURL;
  timeline.download = `echo-${row.recordingId}-timeline.json`;
  timeline.hidden = false;
  await nextPart();
  element('exports').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function nextPart() {
  if (!exportIterator || !exportRow) return;
  element('next-part').hidden = true;
  element('download-part').hidden = true;
  element('export-progress').textContent = 'Checking local audio and preparing WAV part…';
  if (exportURL) {
    URL.revokeObjectURL(exportURL);
    exportURL = undefined;
  }
  const next = await exportIterator.next();
  if (next.done) {
    element('export-progress').textContent =
      'All sequential WAV parts are ready. Keep them in order with the timeline file.';
    exportIterator = undefined;
    return;
  }
  const part = next.value;
  exportURL = URL.createObjectURL(part.blob);
  const download = element<HTMLAnchorElement>('download-part');
  download.href = exportURL;
  download.download = `echo-${exportRow.recordingId}-part-${String(part.part).padStart(2, '0')}.wav`;
  download.textContent = `Download WAV part ${part.part}`;
  download.hidden = false;
  element('export-progress').textContent =
    `Part ${part.part} · starts at ${Math.floor(part.startFrame / 16000)} seconds · ${Math.round(part.frames / 16000)} seconds of audio.`;
  element('next-part').hidden = false;
}
element('next-part').addEventListener('click', () => {
  void action(nextPart, element<HTMLButtonElement>('next-part'));
});
window.addEventListener('pagehide', () => {
  if (exportURL) URL.revokeObjectURL(exportURL);
  if (timelineURL) URL.revokeObjectURL(timelineURL);
});
void refresh()
  .then(async () => {
    const id = new URLSearchParams(location.hash.slice(1)).get('recording');
    if (id) await beginExport(id);
  })
  .catch(showError);
void refreshConnection().catch(showError);
setInterval(() => {
  void refreshConnection().catch(showError);
}, 5000);
setInterval(() => {
  void refresh().catch(showError);
}, 2000);
