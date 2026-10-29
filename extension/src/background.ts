import { BUILD_ID } from './build';
import { externalMessage } from './external-messages';
import {
  meetingFor,
  meetingIdentity,
  microphoneAllowed,
  Observation,
  Provider,
  validObservation,
  InterruptionReason,
} from './core';
import { allRecordings, migrateRecordings } from './storage';
import {
  settings,
  saveSettings,
  readLink,
  revokeCredential,
  connectedPair,
  wasRevoked,
} from './settings';
import type { ActiveStatus } from './offscreen';
import type { ConnectionView } from './status-labels';
import type { Settled } from './upload-scheduler';
import { openEcho, deleteLocalRecording } from './library-actions';
import { connectionStatus, disconnect, livePreview } from './connection';
import {
  beginPairing,
  resumePairing,
  cancelPairing,
  showPairingApproval,
  pairingView,
  whenConnected,
  PairingView,
} from './pairing';
import { captureChanged, renderBadge } from './badge';
import { unlockWithRecoveryPhrase } from './legacy-vault';
type Owner = {
  tabId: number;
  identity: string;
  recordingId: string;
  documentId?: string;
  gateRevision: number;
  departing?: boolean;
};
type OffscreenStatus = { active: ActiveStatus | null; error?: string; busy: boolean };
// Nothing here polls while idle: the gate runs on meeting observations and, during a
// recording, once a second; uploads and the offscreen document follow pending audio.
const TRANSFER_ALARM = 'echo-transfer';
const GATE_INTERVAL_MS = 1000;
const CLAIM_POLL_MS = 1000;
const PROVIDERS: Provider[] = ['meet', 'zoom', 'teams'];
let owner: Owner | undefined;
let restoring: Promise<void> | undefined;
let starting = false;
let makingOffscreen: Promise<void> | undefined;
let closingOffscreen: Promise<void> | undefined;
let gateQueue: Promise<void> = Promise.resolve();
let gateTimer: ReturnType<typeof setInterval> | undefined;
let claimTimer: ReturnType<typeof setTimeout> | undefined;
let claiming = false;
const observations = new Map<number, Observation>();
function logFailure(task: string) {
  return (error: unknown) => console.warn(`Echo: ${task} failed.`, error);
}
async function hasOffscreen(): Promise<boolean> {
  return (
    (
      await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen.html')],
      })
    ).length > 0
  );
}
async function offscreen(): Promise<void> {
  while (closingOffscreen) await closingOffscreen;
  if (await hasOffscreen()) return;
  if (!makingOffscreen)
    makingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification:
          'Capture meeting audio after Start and persist local PCM for recovery and transfer.',
      })
      .finally(() => {
        makingOffscreen = undefined;
      });
  await makingOffscreen;
}
async function send(message: any) {
  await offscreen();
  const reply = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (!reply?.ok) throw new Error(reply?.error ?? 'The local audio recorder did not respond.');
  return reply.value;
}
/** Status of an existing offscreen document; never creates one. */
async function offscreenStatus(): Promise<OffscreenStatus | null> {
  if (closingOffscreen || makingOffscreen || !(await hasOffscreen())) return null;
  return send({ type: 'STATUS' });
}
/** Close the offscreen document once it neither records nor uploads. */
async function closeOffscreenIfIdle(): Promise<void> {
  await restoreOwner();
  if (starting || owner) return;
  const status = await offscreenStatus();
  if (!status || status.active || status.busy) return;
  // Start sets `starting` synchronously; re-check after the await, with none before closing.
  if (starting || owner || closingOffscreen) return;
  closingOffscreen = chrome.offscreen.closeDocument().finally(() => {
    closingOffscreen = undefined;
  });
  await closingOffscreen;
}
function startGateTimer() {
  gateTimer ??= setInterval(() => {
    void gate().catch(logFailure('microphone gate'));
  }, GATE_INTERVAL_MS);
}
function stopGateTimer() {
  if (gateTimer !== undefined) clearInterval(gateTimer);
  gateTimer = undefined;
}
/** The owner lives in this worker's memory; session storage restores it once after a restart. */
function restoreOwner(): Promise<void> {
  if (!restoring) {
    const loading = chrome.storage.session.get('captureOwner').then(({ captureOwner }) => {
      owner ??= captureOwner as Owner | undefined;
      if (owner) startGateTimer();
    });
    restoring = loading;
    loading.catch(() => {
      if (restoring === loading) restoring = undefined;
    });
  }
  return restoring;
}
async function setOwner(next: Owner) {
  owner = next;
  await chrome.storage.session.set({ captureOwner: next });
  startGateTimer();
}
async function clearOwner(expectedRecordingId?: string) {
  if (expectedRecordingId && owner?.recordingId !== expectedRecordingId) return;
  owner = undefined;
  stopGateTimer();
  await chrome.storage.session.remove('captureOwner');
}
async function sendGate() {
  await restoreOwner();
  if (!owner || !(await hasOffscreen())) return;
  const capturedOwner = owner;
  const observation = observations.get(capturedOwner.tabId);
  capturedOwner.gateRevision = (capturedOwner.gateRevision ?? 0) + 1;
  const revision = capturedOwner.gateRevision;
  await chrome.storage.session.set({ captureOwner: capturedOwner });
  // A newer mute report may arrive while session persistence is pending. Never send its predecessor.
  if (owner !== capturedOwner || observations.get(capturedOwner.tabId) !== observation) return;
  const allowed =
    !capturedOwner.departing &&
    microphoneAllowed(observation, capturedOwner.identity, capturedOwner.documentId);
  const age = observation ? Date.now() - observation.receivedAt : Infinity;
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'GATE',
    recordingId: capturedOwner.recordingId,
    gateRevision: revision,
    allowed,
    expiresAt: observation ? observation.receivedAt + 2000 : 0,
    ttlMs: allowed ? Math.max(0, 2000 - age) : 0,
    state: age >= 2000 ? 'stale meeting controls' : (observation?.state ?? 'unknown mute state'),
  });
  if (!response?.ok) throw new Error('Microphone gate did not respond.');
}
/** Serialized gate updates; each caller still receives its own failure. */
function gate(): Promise<void> {
  const run = gateQueue.then(sendGate);
  gateQueue = run.catch(() => undefined);
  return run;
}
async function stopOwner(reason: InterruptionReason) {
  await restoreOwner();
  if (!owner) return;
  const capturedOwner = owner;
  capturedOwner.departing = true;
  await gate().catch(logFailure('microphone gate'));
  if (owner !== capturedOwner) return;
  const id = capturedOwner.recordingId;
  await send({
    type: 'CONTROL',
    recordingId: id,
    action: 'stop',
    interrupted: true,
    interruptionReason: reason,
  });
  await clearOwner(id);
}
async function verifyOwnerDocument(tabId: number) {
  await restoreOwner();
  const capturedOwner = owner;
  if (!capturedOwner || capturedOwner.tabId !== tabId) return;
  // InjectionResult.documentId comes from Chrome, without reading meeting content.
  // Loading may belong to a subframe or same-document navigation; it is not proof
  // that the original meeting document was replaced.
  let frames: any[];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => undefined,
    });
  } catch (error) {
    console.warn('Echo: the meeting document could not be verified.', error);
    if (owner === capturedOwner) await stopOwner('document-unavailable');
    return;
  }
  if (owner !== capturedOwner) return;
  const documentId = frames.find((frame) => frame.frameId === 0)?.documentId;
  if (typeof documentId !== 'string') {
    await stopOwner('document-unavailable');
    return;
  }
  if (capturedOwner.documentId && capturedOwner.documentId !== documentId)
    await stopOwner('document-changed');
}
async function start(message: any) {
  if (starting) throw new Error('A recording is already starting.');
  starting = true;
  try {
    await restoreOwner();
    if (owner) {
      if ((await offscreenStatus())?.active)
        throw new Error('A recording is already active. Stop it before starting another.');
      await clearOwner();
    }
    // A reported recorder failure is shown until the next start attempt, which retries it.
    await chrome.storage.session.remove('recorderError');
    if (message.consent !== true)
      throw new Error('Confirm that meeting participants consent before starting.');
    const tab = await chrome.tabs.get(message.tabId);
    if (tab.id === undefined) throw new Error('Meeting tab is unavailable.');
    const tabId = tab.id;
    const meeting = meetingFor(tab.url ?? '');
    if (!meeting)
      throw new Error('Open a supported Google Meet, Zoom Web or Teams Web meeting tab.');
    const prefs = await settings();
    if (!prefs.enabledProviders.includes(meeting.provider))
      throw new Error('Enable this meeting provider in Echo extension setup.');
    if (message.micEnabled === true && !prefs.micGranted)
      throw new Error('Grant microphone permission in setup, or explicitly choose tab audio only.');
    if (!(await chrome.permissions.contains({ origins: [meeting.originPattern] })))
      throw new Error('This meeting provider needs permission in setup.');
    const title =
      String(message.title ?? tab.title ?? 'Meeting')
        .trim()
        .slice(0, 200) || 'Meeting';
    await offscreen();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js'],
    });
    const documentId = injected.find((frame: any) => frame.frameId === 0)?.documentId;
    if (typeof documentId !== 'string')
      throw new Error('The meeting document could not be verified. Retry from your meeting tab.');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const recordingId = crypto.randomUUID();
    await setOwner({
      tabId: tabId,
      identity: meeting.identity,
      recordingId,
      documentId,
      gateRevision: 0,
    });
    try {
      const micDeviceId =
        typeof message.micDeviceId === 'string' && message.micDeviceId.length < 512
          ? message.micDeviceId
          : 'default';
      const value = await send({
        type: 'START',
        streamId,
        micEnabled: message.micEnabled === true,
        micDeviceId,
        recording: {
          recordingId,
          title,
          provider: meeting.provider,
          meetingUrl: tab.url,
          consent: true,
          liveTranscription: message.liveTranscription === true,
          sampleRate: 16000,
          channels: 1,
          createdAt: new Date().toISOString(),
          libraryId: (await connectedPair())?.libraryId ?? null,
        },
      });
      if (
        !owner ||
        owner.recordingId !== recordingId ||
        meetingIdentity((await chrome.tabs.get(tabId)).url ?? '') !== meeting.identity
      ) {
        await send({
          type: 'CONTROL',
          recordingId,
          action: 'stop',
          interrupted: true,
          interruptionReason: 'meeting-changed',
        });
        throw new Error(
          'The meeting tab changed while recording started. Its committed audio is retained. Start again from the intended meeting.',
        );
      }
      await saveSettings({ micDeviceId });
      await gate();
      return value;
    } catch (error) {
      await clearOwner();
      throw error;
    }
  } finally {
    starting = false;
    if (!owner) void closeOffscreenIfIdle().catch(logFailure('closing the recorder'));
  }
}
async function stopRecording(recordingId: unknown) {
  await restoreOwner();
  if (!owner || owner.recordingId !== recordingId)
    throw new Error('That recording is no longer active.');
  const id = owner.recordingId;
  const response = await send({ type: 'CONTROL', recordingId: id, action: 'stop' });
  await clearOwner(id);
  return response;
}
/** Keyboard shortcut: stop this browser's recording, or start one on the shortcut's tab. */
async function toggleRecording(tab?: chrome.tabs.Tab) {
  await restoreOwner();
  if (owner) {
    await stopRecording(owner.recordingId);
    return;
  }
  if (tab?.id === undefined) throw new Error('Open your meeting tab, then use the shortcut again.');
  const meeting = meetingFor(tab.url ?? '');
  const prefs = await settings();
  // The shortcut never assumes consent: it starts only where the user asked Echo to remember it.
  if (meeting && !prefs.rememberedConsent.includes(meeting.provider))
    throw new Error(
      'Confirm in Echo that participants consent, and choose Remember for this service to use the shortcut.',
    );
  await start({
    tabId: tab.id,
    consent: true,
    title: tab.title,
    micEnabled: prefs.micGranted,
    micDeviceId: prefs.micDeviceId,
    liveTranscription: prefs.liveTranscription,
  });
}
/** Keep a failure the user cannot see right now for the popup, and open the popup if possible. */
async function reportFailure(error: unknown) {
  console.warn('Echo: the recording shortcut failed.', error);
  await chrome.storage.session.set({ recorderError: (error as Error).message });
  // Chrome 127+ opens the popup from a command; older versions show the error on next open.
  if (chrome.action.openPopup)
    await chrome.action.openPopup().catch(logFailure('opening the popup'));
}
let migrating: Promise<void> | undefined;
let migrationError: string | undefined;
function migrateProtectedHistory(): Promise<void> {
  migrating ??= migrateRecordings()
    .then(() => {
      migrationError = undefined;
    })
    .catch((error) => {
      console.error('Echo: saved recordings could not be migrated.', error);
      migrationError = (error as Error).message;
    })
    .finally(() => {
      migrating = undefined;
    });
  return migrating;
}
/**
 * Upload pending audio through the offscreen document, creating it only when a connected Echo
 * has recordings to receive. `reset` starts a fresh backoff (connect, user retry, startup).
 */
async function requestUploads(reset: boolean): Promise<void> {
  const pending = (await allRecordings()).some(
    (row) => !row.receipt && !row.locked && row.chunkCount > 0,
  );
  if (!pending || !(await connectedPair())) {
    await chrome.alarms.clear(TRANSFER_ALARM);
    await closeOffscreenIfIdle();
    return;
  }
  const failures = reset
    ? 0
    : Number((await chrome.storage.session.get('uploadFailures')).uploadFailures) || 0;
  await send({ type: 'SYNC', failures });
}
/** Migration only: unlock recordings from before storage v3 with the old recovery phrase. */
async function unlockOlderRecordings(phrase: unknown) {
  await unlockWithRecoveryPhrase(phrase);
  // A migration already running started without this identity; rewrap after it.
  if (migrating) await migrating;
  await migrateProtectedHistory();
  const locked = (await allRecordings()).filter((row) => row.needsUnlock).length;
  void requestUploads(true).catch(logFailure('transfer'));
  return { locked };
}
/** Migrate, then upload pending audio. Recording itself never waits for this. */
async function syncPending(reset: boolean): Promise<void> {
  await migrateProtectedHistory();
  await requestUploads(reset);
}
/** The offscreen document finished uploading for now; retry offline Echo from an alarm. */
async function uploadsSettled(message: Partial<Settled>) {
  const failures = Number.isSafeInteger(message.failures) ? (message.failures as number) : 0;
  await chrome.storage.session.set({ uploadFailures: failures });
  const retryAt = message.retryAt;
  if (typeof retryAt === 'number' && Number.isFinite(retryAt))
    await chrome.alarms.create(TRANSFER_ALARM, { when: retryAt });
  else await chrome.alarms.clear(TRANSFER_ALARM);
  await closeOffscreenIfIdle();
}
async function captureReported(message: any) {
  if (typeof message.error === 'string')
    await chrome.storage.session.set({ recorderError: message.error });
  await captureChanged(message.active ?? null);
  await renderBadge();
  if (!message.active && message.endedRecordingId) {
    await restoreOwner();
    if (owner?.recordingId === message.endedRecordingId) await clearOwner();
  }
}
/**
 * While a connection request waits for approval, claim it once a second (missed ECHO_APPROVED).
 * At most one poll is scheduled or in flight, so a hanging Echo never queues claims ahead of Cancel.
 */
function scheduleClaim(view: PairingView): PairingView {
  if (view.phase === 'waiting' && claimTimer === undefined && !claiming)
    claimTimer = setTimeout(() => {
      claimTimer = undefined;
      claiming = true;
      void claimOnce().then(
        (next) => {
          claiming = false;
          scheduleClaim(next);
        },
        (error) => {
          claiming = false;
          logFailure('connection check')(error);
        },
      );
    }, CLAIM_POLL_MS);
  return view;
}
async function claimOnce(): Promise<PairingView> {
  try {
    return await resumePairing();
  } catch (error) {
    logFailure('connection claim')(error);
    return pairingView();
  }
}
async function state() {
  const prefs = await settings();
  const status = await offscreenStatus();
  const recoveryError =
    status?.error ??
    ((await chrome.storage.session.get('recorderError')).recorderError as string | undefined);
  return {
    build: BUILD_ID,
    migrationError,
    connection: {
      ...scheduleClaim(await pairingView()),
      revoked: await wasRevoked(),
    } satisfies ConnectionView,
    settings: {
      enabledProviders: prefs.enabledProviders,
      micGranted: prefs.micGranted,
      micDeviceId: prefs.micDeviceId,
      rememberedConsent: prefs.rememberedConsent,
      liveTranscription: prefs.liveTranscription,
    },
    active: status?.active ?? null,
    recoveryError,
    recordings: await allRecordings(),
  };
}
export type ExtensionState = Awaited<ReturnType<typeof state>>;
function meetingObservation(
  message: any,
  sender: chrome.runtime.MessageSender,
  respond: (reply: unknown) => void,
): boolean {
  const tabId = sender.tab?.id;
  if (
    !['MUTE_OBSERVATION', 'MEETING_PAGEHIDE'].includes(message.type) ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    !validObservation(message) ||
    sender.url !== message.url ||
    tabId === undefined
  )
    return false;
  const previous = observations.get(tabId);
  if (previous && previous.documentId === sender.documentId && message.seq <= previous.seq)
    return false;
  const now = Date.now();
  const fresh =
    Number.isFinite(message.observedAt) &&
    message.observedAt <= now + 100 &&
    now - message.observedAt < 2000;
  const received: Observation = {
    ...message,
    state: fresh && message.type !== 'MEETING_PAGEHIDE' ? message.state : 'unknown',
    documentId: sender.documentId,
    receivedAt: fresh ? message.observedAt : now,
  };
  observations.set(tabId, received);
  const run = async () => {
    await restoreOwner();
    if (message.type === 'MEETING_PAGEHIDE') {
      if (owner && owner.tabId === tabId && owner.documentId === sender.documentId)
        await stopOwner('document-changed');
      return;
    }
    if (observations.get(tabId) !== received) return;
    if (owner && owner.tabId === tabId) {
      if (owner.documentId && owner.documentId !== sender.documentId) {
        await stopOwner('document-changed');
        return;
      }
      if (meetingIdentity(message.url) !== owner.identity) {
        await stopOwner('meeting-changed');
        return;
      }
      if (message.state === 'ended') {
        await stopOwner('meeting-ended');
        return;
      }
      if (!owner.documentId) {
        owner.documentId = sender.documentId;
        await chrome.storage.session.set({ captureOwner: owner });
      }
    }
    if (observations.get(tabId) !== received) return;
    await gate();
  };
  // A tab that is not recording stops observing, so an idle meeting never wakes this worker.
  void run()
    .catch(logFailure('meeting observation'))
    .then(() => respond({ observe: starting || owner?.tabId === tabId }));
  return true;
}
function offscreenMessage(message: any, respond: (reply: unknown) => void): boolean {
  if (['TRUSTED_LINK', 'TRUSTED_REVOKE'].includes(message.type)) {
    const work =
      message.type === 'TRUSTED_LINK'
        ? readLink()
        : revokeCredential(message.credential, message.endpoint);
    work.then(
      (value) => respond({ ok: true, value }),
      (error) => respond({ ok: false, error: (error as Error).message }),
    );
    return true;
  }
  if (message.type === 'CAPTURE_STATUS')
    void captureReported(message).catch(logFailure('capture status'));
  if (message.type === 'UPLOADS_SETTLED')
    void uploadsSettled(message).catch(logFailure('upload scheduling'));
  return false;
}
async function pageAction(message: any) {
  if (message.type === 'STATE') return state();
  if (message.type === 'CONNECTION_STATUS') return connectionStatus();
  if (message.type === 'LIVE_PREVIEW') return livePreview(message.recordingId);
  if (message.type === 'MIC_EXCLUSION') {
    await restoreOwner();
    if (!owner || owner.recordingId !== message.recordingId)
      throw new Error('That recording is no longer active.');
    const response = await send({
      type: 'MIC_EXCLUSION',
      recordingId: owner.recordingId,
      excluded: message.excluded === true,
    });
    await gate();
    return response;
  }
  if (message.type === 'OPEN_ECHO')
    return openEcho(typeof message.recordingId === 'string' ? message.recordingId : undefined);
  if (message.type === 'DELETE_RECORDING') {
    await restoreOwner();
    await deleteLocalRecording(message.recordingId, message.confirmed === true, owner?.recordingId);
    await renderBadge();
    return {};
  }
  if (message.type === 'START') return start(message);
  if (message.type === 'CONTROL' && ['pause', 'resume', 'stop'].includes(message.action)) {
    if (message.action === 'stop') return stopRecording(message.recordingId);
    await restoreOwner();
    if (!owner || owner.recordingId !== message.recordingId)
      throw new Error('That recording is no longer active.');
    return send({ type: 'CONTROL', recordingId: owner.recordingId, action: message.action });
  }
  if (message.type === 'PAIR_BEGIN')
    return beginPairing(typeof message.endpoint === 'string' ? message.endpoint : undefined).then(
      scheduleClaim,
    );
  if (message.type === 'PAIR_CANCEL') return cancelPairing();
  if (message.type === 'PAIR_SHOW_APPROVAL') return showPairingApproval().then(scheduleClaim);
  if (message.type === 'DISCONNECT')
    return disconnect(message.forgetLocally === true).then(() => ({}));
  if (message.type === 'MIC_GRANTED')
    return saveSettings({ micGranted: message.granted === true }).then(() => ({}));
  if (message.type === 'PROVIDER_ENABLED' && PROVIDERS.includes(message.provider)) {
    await saveSettings((current) => {
      const providers = current.enabledProviders.filter((p) => p !== message.provider);
      if (message.enabled === true) providers.push(message.provider as Provider);
      return { enabledProviders: providers };
    });
    await renderBadge();
    return {};
  }
  if (message.type === 'REMEMBER_CONSENT' && PROVIDERS.includes(message.provider)) {
    await saveSettings((current) => {
      const remembered = current.rememberedConsent.filter((p) => p !== message.provider);
      if (message.remember === true) remembered.push(message.provider as Provider);
      return { rememberedConsent: remembered };
    });
    return {};
  }
  if (message.type === 'LIVE_TEXT_DEFAULT')
    return saveSettings({ liveTranscription: message.enabled === true }).then(() => ({}));
  if (message.type === 'UNLOCK_OLDER_RECORDINGS') return unlockOlderRecordings(message.phrase);
  if (message.type === 'SYNC') {
    await migrateProtectedHistory();
    void requestUploads(true).catch(logFailure('transfer'));
    return {};
  }
  throw new Error('Unsupported extension action.');
}
chrome.runtime.onMessage.addListener((message: any, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const documentURL = typeof sender.url === 'string' ? sender.url.split(/[?#]/)[0] : '';
  const trustedPage = [
    chrome.runtime.getURL('popup.html'),
    chrome.runtime.getURL('setup.html'),
  ].includes(documentURL);
  if (sender.tab && !trustedPage) return meetingObservation(message, sender, respond);
  if (message.target === 'offscreen') return false;
  if (sender.url === chrome.runtime.getURL('offscreen.html'))
    return offscreenMessage(message, respond);
  if (!trustedPage) return false;
  pageAction(message).then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: (error as Error).message }),
  );
  return true;
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording')
    void toggleRecording(tab).catch((error) =>
      reportFailure(error).catch(logFailure('reporting the shortcut failure')),
    );
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void restoreOwner()
    .then(() => {
      if (owner?.tabId === tabId) return stopOwner('tab-closed');
    })
    .catch(logFailure('stopping the recording'));
  observations.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tab.active && (change.url || change.status === 'complete'))
    void renderBadge([tab]).catch(logFailure('badge update'));
  void restoreOwner()
    .then(() => {
      if (!owner || owner.tabId !== tabId) return;
      if (change.url && meetingIdentity(tab.url ?? change.url) !== owner.identity) {
        void stopOwner('meeting-changed').catch(logFailure('stopping the recording'));
        return;
      }
      if (change.status === 'loading') {
        observations.delete(tabId);
        void gate().catch(logFailure('microphone gate'));
      }
      if (change.status === 'loading' || change.status === 'complete')
        void verifyOwnerDocument(tabId).catch(logFailure('meeting document check'));
    })
    .catch(logFailure('restoring the recording owner'));
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => renderBadge([tab]))
    .catch(logFailure('badge update'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TRANSFER_ALARM) return;
  // A live offscreen document schedules its own retries while it records.
  void offscreenStatus()
    .then((status) => (status ? undefined : syncPending(false)))
    .catch(logFailure('transfer'));
});
chrome.runtime.onInstalled.addListener((details) => {
  // Drop the former 30-second transfer alarm; retries are scheduled only while Echo is offline.
  // An update migrates settings and saved recordings right away; a fresh install has nothing to migrate.
  void chrome.alarms
    .clear(TRANSFER_ALARM)
    .then(() => settings())
    .then(() => (details.reason === 'update' ? syncPending(true) : undefined))
    .catch(logFailure('migration'));
  void renderBadge().catch(logFailure('badge update'));
  if (details.reason === 'install')
    void chrome.runtime.openOptionsPage().catch(logFailure('opening setup'));
});
chrome.runtime.onStartup.addListener(() => {
  void clearOwner()
    .then(() => captureChanged(null))
    .then(() => renderBadge())
    .catch(logFailure('startup'));
  void syncPending(true).catch(logFailure('transfer'));
  void pairingView().then(scheduleClaim).catch(logFailure('connection check'));
});
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  externalMessage(message, sender)
    .then(respond, (error) => {
      console.warn('Echo: rejected a message from an Echo page.', error);
      respond({ ok: false, error: (error as Error).message });
    })
    .then(() => pairingView())
    .then(scheduleClaim)
    .catch(logFailure('connection check'));
  return true;
});
whenConnected(() => void syncPending(true).catch(logFailure('transfer')));
void chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(logFailure('protecting session state'));
