import { Provider, Recording } from './core';
import { exportParts, recording } from './storage';
import { action, element, renderRecordings, request, showError } from './ui';
import { connectionLabel } from './status-labels';
declare const chrome: any;
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
let prefs: any;
let initialized = false;
let pairing: any = { phase: 'idle' };
let connection = 'checking';
let checkingConnection = false;
let pendingCount = 0;
let capturing = false;
let refreshing: Promise<void> | undefined;
let pairingRequests = 0;
let choices = { offline: false, callOnly: false };
const completion = new Map<string, boolean>();
const providerControls = new Map<
  Provider,
  { label: HTMLSpanElement; button: HTMLButtonElement; enabled: boolean }
>();
function completeStep(id: string, complete: boolean) {
  if (complete && !completion.get(id) && !element(id).contains(document.activeElement))
    element<HTMLDetailsElement>(id).open = false;
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
  } catch {
    return false;
  }
}
async function refreshConnection() {
  if (checkingConnection) return;
  checkingConnection = true;
  try {
    connection = (await request({ type: 'CONNECTION_STATUS' })).status;
    element('connection-status').textContent = connectionLabel(connection);
  } finally {
    checkingConnection = false;
  }
}
let exportIterator: AsyncGenerator<any> | undefined;
let exportURL: string | undefined;
let timelineURL: string | undefined;
let exportRow: Recording | undefined;
function status(text: string) {
  element('status').textContent = text;
  element('status').hidden = false;
}
const pairingErrors: Record<string, string> = {
  'old-server':
    'This Echo version needs a pairing code. Open Advanced below, or update Echo for reliable interrupted-connection recovery.',
  unavailable: 'Open Echo, then try again. Your saved audio stays on this device.',
  'rate-limited': 'Echo has several connection requests waiting. Try again in five minutes.',
  'tab-open-failed': 'The approval page could not open. Choose Open approval page to retry.',
  'invalid-response': 'Echo returned an unexpected connection response. Update Echo and try again.',
  denied:
    'This request was denied or is no longer available. Choose Connect to Echo to start again.',
};
function renderPairing(next: any) {
  pairing = next ?? { phase: 'idle' };
  const messages: Record<string, string> = {
    idle: '',
    beginning: 'Connecting to Echo…',
    pending: 'Approve this browser on the Echo page that opened.',
    prepared: 'Preparing your connection…',
    'confirm-library': `${pairing.pendingCount} recordings are saved locally. Confirm their destination below.`,
    'activation-sent':
      'Finishing connection. Keep Echo open so the extension can confirm the result.',
    connected: 'Connected to Echo. Saved audio transfers when Echo is open.',
    cancelled: 'Connection cancelled. Local recordings are retained.',
    rejected: 'Connection declined. Choose Connect to Echo to try again.',
    expired: 'This request expired. Choose Connect to Echo to try again.',
  };
  element('pairing-status').textContent =
    pairing.phase === 'activation-sent'
      ? messages['activation-sent'] + (pairing.error ? ' Open Echo, then retry.' : '')
      : (pairingErrors[pairing.error] ?? messages[pairing.phase] ?? '');
  element('library-confirm').hidden = pairing.phase !== 'confirm-library';
  element('open-approval').hidden = pairing.phase !== 'pending' || pairing.legacy;
  element('cancel-pairing').hidden = ![
    'beginning',
    'pending',
    'prepared',
    'confirm-library',
    'activation-sent',
  ].includes(pairing.phase);
  element('cancel-pairing').textContent =
    pairing.phase === 'activation-sent' ? 'Disconnect when confirmed' : 'Cancel connection';
  element<HTMLButtonElement>('connect').disabled = [
    'pending',
    'prepared',
    'confirm-library',
    'activation-sent',
  ].includes(pairing.phase);
  if (pairing.error === 'old-server') element<HTMLDetailsElement>('advanced').open = true;
  if (pairing.phase === 'connected') element<HTMLInputElement>('code').value = '';
}
function refresh(): Promise<void> {
  if (!refreshing)
    refreshing = refreshState().finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}
async function refreshState() {
  const state = await request({ type: 'STATE' });
  prefs = state.settings;
  renderVault(state.vault);
  if (state.recoveryError) showError(new Error(state.recoveryError));
  if (!initialized) {
    element<HTMLInputElement>('endpoint').value = prefs.endpoint;
    choices = (await chrome.storage.local.get('onboardingChoices')).onboardingChoices ?? choices;
    initialized = true;
  }
  renderPairing(state.pairing);
  element('paired').textContent = prefs.activeLibraryId
    ? `Library ID: ${prefs.activeLibraryId}`
    : 'No library connected. You can record and export locally.';
  if (!prefs.activeLibraryId) connection = 'not-connected';
  else if (connection === 'not-connected') connection = 'checking';
  element('connection-status').textContent = connectionLabel(connection);
  element('disconnect').hidden = !prefs.activeLibraryId;
  pendingCount = state.recordings.filter((row: Recording) => !row.receipt && row.chunkCount).length;
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
    const control = providerControls.get(provider.id)!;
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
  const connected = !!prefs.activeLibraryId;
  element('connect-summary').textContent = connected
    ? 'Connected to Echo'
    : choices.offline
      ? 'Record offline · connect whenever you are ready'
      : 'Save recordings to your local library';
  element('provider-summary').textContent = enabledCount
    ? `${enabledCount} meeting service${enabledCount === 1 ? '' : 's'} enabled`
    : 'Enable the service you use';
  element('mic-summary').textContent = choices.callOnly
    ? 'Call audio only'
    : micGranted
      ? 'Microphone allowed · meeting mute applies'
      : 'Choose microphone or call audio only';
  completeStep('connect-step', connected || choices.offline);
  completeStep('provider-step', enabledCount > 0);
  completeStep('microphone-step', micGranted || choices.callOnly);
  element('ready').hidden =
    !state.vault?.ready ||
    !!state.vault?.migrationPending ||
    !(connected || choices.offline) ||
    !enabledCount ||
    !(micGranted || choices.callOnly);
  renderRecordings(
    state.recordings,
    (row: Recording) => {
      void action(() => beginExport(row));
    },
    state.active?.recordingId,
  );
}
let phraseShowing = false;
let confirmingPhrase = false;
function renderVault(vault: any) {
  if (!vault) return;
  element('vault-create').hidden = vault.ready || phraseShowing || confirmingPhrase;
  element('vault-unlock-panel').hidden = !vault.ready || vault.unlocked;
  element('vault-summary').textContent = !vault.ready
    ? 'Save your recovery phrase'
    : vault.migrationPending
      ? 'Protecting existing recordings'
      : vault.unlocked
        ? 'Recording protection ready'
        : 'Protected · saved history locked';
  element('vault-status').textContent =
    vault.migrationError ??
    (vault.migrationPending
      ? 'Existing recordings need protection. Keep this page open while saved audio is encrypted. Original committed data stays available if this is interrupted.'
      : vault.ready
        ? vault.unlocked
          ? 'Saved history is unlocked for this browser session.'
          : (vault.error ??
            'Open Echo or use your recovery phrase to unlock history. You can keep recording offline.')
        : '');
  completeStep('vault-step', vault.ready && vault.unlocked && !vault.migrationPending);
}
async function createPhrase() {
  const made = await request({ type: 'VAULT_BEGIN' });
  phraseShowing = true;
  confirmingPhrase = false;
  element('vault-create').hidden = true;
  element('vault-confirm-panel').hidden = true;
  element('vault-phrase-panel').hidden = false;
  const list = element('vault-phrase');
  list.replaceChildren();
  for (const word of made.phrase.split(' ')) {
    const item = document.createElement('li');
    item.textContent = word;
    list.append(item);
  }
  const checks = element('vault-checks');
  checks.replaceChildren();
  for (const position of made.positions) {
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = `Word ${position}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'none');
    input.dataset.position = String(position);
    label.append(input);
    checks.append(label);
  }
}
element('vault-create').addEventListener('click', () => {
  void action(createPhrase, element<HTMLButtonElement>('vault-create'));
});
element('vault-restart').addEventListener('click', () => {
  void action(createPhrase, element<HTMLButtonElement>('vault-restart'));
});
element('vault-saved').addEventListener('click', () => {
  element('vault-phrase').replaceChildren();
  element('vault-phrase-panel').hidden = true;
  element('vault-confirm-panel').hidden = false;
  phraseShowing = false;
  confirmingPhrase = true;
  element('vault-checks').querySelector('input')?.focus();
});
element('vault-confirm').addEventListener('click', () => {
  void action(async () => {
    const words = Array.from(element('vault-checks').querySelectorAll('input')).map(
      (input) => input.value,
    );
    await request({ type: 'VAULT_CONFIRM', words });
    element('vault-checks').replaceChildren();
    element('vault-confirm-panel').hidden = true;
    confirmingPhrase = false;
    status(
      'Recording protection is ready. Your recovery phrase can unlock saved history when Echo is unavailable.',
    );
    await refresh();
  }, element<HTMLButtonElement>('vault-confirm'));
});
element('vault-unlock').addEventListener('click', () => {
  void action(async () => {
    const input = element<HTMLTextAreaElement>('vault-recovery');
    const phrase = input.value;
    input.value = '';
    await request({ type: 'VAULT_UNLOCK', phrase });
    await refresh();
    status('Saved history is unlocked for this browser session.');
  }, element<HTMLButtonElement>('vault-unlock'));
});
element('vault-retry').addEventListener('click', () => {
  void action(async () => {
    await request({ type: 'VAULT_RETRY' });
    await refresh();
  }, element<HTMLButtonElement>('vault-retry'));
});

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
        throw new Error('Meeting-service access was not granted. Choose Enable to try again.');
      await request({ type: 'PROVIDER_ENABLED', provider: provider.id, enabled: !enabled });
      await refresh();
    }, button);
  });
  row.append(label, button);
  element('providers').append(row);
}
async function pairingAction(message: any) {
  if (pairingRequests && message.type === 'PAIR_STATUS') return;
  pairingRequests++;
  try {
    renderPairing(await request(message));
    await refresh();
    await refreshConnection();
  } finally {
    pairingRequests--;
  }
}
element('connect').addEventListener('click', () => {
  void action(
    () =>
      pairingAction({
        type: 'PAIR_BEGIN',
        endpoint: element<HTMLInputElement>('endpoint').value,
        name: element<HTMLInputElement>('name').value,
      }),
    element<HTMLButtonElement>('connect'),
  );
});
element('open-approval').addEventListener('click', () => {
  void action(() => pairingAction({ type: 'PAIR_OPEN_APPROVAL', requestId: pairing.requestId }));
});
for (const id of ['cancel-pairing', 'cancel-library'])
  element(id).addEventListener('click', () => {
    void action(() => pairingAction({ type: 'PAIR_CANCEL' }));
  });
element('offline').addEventListener('click', () => {
  void action(async () => {
    await saveChoice({ offline: true });
    status(
      'Recording works without Echo. Audio stays in this browser until you connect or export it.',
    );
    await refresh();
  });
});
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
    } catch {
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
      `Disconnect this browser from Echo? ${pendingCount} recording${pendingCount === 1 ? '' : 's'} still need transfer. ${capturing ? 'The active recording will continue locally. ' : ''}Local audio will be retained. Reconnect its library to transfer it later.`,
    )
  )
    return;
  void action(async () => {
    await request({ type: 'DISCONNECT', confirmed: true });
    status('Disconnected from Echo. Local audio is retained.');
    await refresh();
    await refreshConnection();
  }, element<HTMLButtonElement>('disconnect'));
});
element('request').addEventListener('click', () => {
  void action(
    () =>
      pairingAction({
        type: 'PAIR_REQUEST',
        endpoint: element<HTMLInputElement>('endpoint').value,
        code: element<HTMLInputElement>('code').value,
        name: element<HTMLInputElement>('name').value,
      }),
    element<HTMLButtonElement>('request'),
  );
});
element('claim').addEventListener('click', () => {
  void action(() => pairingAction({ type: 'PAIR_STATUS' }), element<HTMLButtonElement>('claim'));
});
element('confirm-library').addEventListener('click', () => {
  void action(
    () => pairingAction({ type: 'PAIR_CONFIRM_LIBRARY', requestId: pairing.requestId }),
    element<HTMLButtonElement>('confirm-library'),
  );
});
element('retry').addEventListener('click', () => {
  void action(async () => {
    await request({ type: 'SYNC' });
    status('Transfer retry requested. Audio stays local until Echo confirms it.');
    await refresh();
  });
});
async function beginExport(row: Recording) {
  if (row.locked) {
    element<HTMLDetailsElement>('vault-step').open = true;
    element('vault-step').scrollIntoView({ behavior: 'smooth', block: 'start' });
    element('vault-recovery').focus();
    return;
  }
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
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('recording');
    if (id) {
      const row = await recording(id);
      if (row) await beginExport(row);
    }
  })
  .catch(showError);
void pairingAction({ type: 'PAIR_STATUS' }).catch(showError);
setInterval(() => {
  void refreshConnection().catch(showError);
}, 5000);
setInterval(() => {
  void refresh().catch(showError);
}, 3000);

setInterval(() => {
  void pairingAction({ type: 'PAIR_STATUS' }).catch(showError);
}, 2000);
