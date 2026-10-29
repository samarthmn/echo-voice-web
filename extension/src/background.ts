import { externalMessage } from './external-messages';
import {
  meetingFor,
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
import { openEcho, deleteLocalRecording } from './library-actions';
import { connectionStatus, disconnect, livePreview } from './connection';
import {
  beginPairing,
  resumePairing,
  cancelPairing,
  showPairingApproval,
  pairingView,
  whenConnected,
} from './pairing';
type Owner = {
  tabId: number;
  identity: string;
  recordingId: string;
  documentId?: string;
  gateRevision: number;
  departing?: boolean;
};
let owner: Owner | undefined;
let starting = false;
let makingOffscreen: Promise<void> | undefined;
let gateQueue: Promise<void> = Promise.resolve();
const observations = new Map<number, Observation>();
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
async function restoreOwner() {
  if (!owner) {
    const saved = (await chrome.storage.session.get('captureOwner')).captureOwner as
      | Owner
      | undefined;
    if (!owner) owner = saved;
  }
}
async function clearOwner(expectedRecordingId?: string) {
  if (expectedRecordingId && owner?.recordingId !== expectedRecordingId) return;
  owner = undefined;
  await chrome.storage.session.remove('captureOwner');
}
async function setBadge(active: ActiveStatus | null) {
  const rows = await allRecordings();
  const attention = rows.some(
    (row) =>
      !row.receipt && (row.transferState === 'attention' || row.captureState === 'interrupted'),
  );
  const text = active ? (active.paused ? 'II' : 'REC') : attention ? '!' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: active ? '#6858d9' : '#af3543' });
  await chrome.action.setTitle({
    title: active
      ? active.paused
        ? 'Echo: recording paused'
        : 'Echo: recording meeting audio'
      : attention
        ? 'Echo: saved recording needs attention'
        : 'Echo recorder',
  });
}
async function gate() {
  gateQueue = gateQueue
    .catch(() => {})
    .then(async () => {
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
        state:
          age >= 2000 ? 'stale meeting controls' : (observation?.state ?? 'unknown mute state'),
      });
      if (!response?.ok) throw new Error('Microphone gate did not respond.');
    });
  await gateQueue;
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
  } catch {
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
      if ((await hasOffscreen()) && (await send({ type: 'STATUS' })).active)
        throw new Error('A recording is already active. Stop it before starting another.');
      await clearOwner();
    }
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
    owner = { tabId: tabId, identity: meeting.identity, recordingId, documentId, gateRevision: 0 };
    await chrome.storage.session.set({ captureOwner: owner });
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
        meetingFor((await chrome.tabs.get(tabId)).url ?? '')?.identity !== meeting.identity
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
  }
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
/** Migrate, then upload pending audio. Recording itself never waits for this. */
async function syncPending(): Promise<void> {
  await migrateProtectedHistory();
  if ((await allRecordings()).some((row) => !row.receipt && row.chunkCount))
    await send({ type: 'SYNC' });
}
function logFailure(task: string) {
  return (error: unknown) => console.warn(`Echo: ${task} failed.`, error);
}
async function state() {
  const prefs = await settings();
  let active: ActiveStatus | null = null;
  let recoveryError: string | undefined;
  if (await hasOffscreen()) {
    const status = await send({ type: 'STATUS' });
    active = status.active;
    recoveryError = status.error;
  }
  return {
    migrationError,
    connection: { ...(await pairingView()), revoked: await wasRevoked() } satisfies ConnectionView,
    settings: {
      enabledProviders: prefs.enabledProviders,
      micGranted: prefs.micGranted,
      micDeviceId: prefs.micDeviceId,
    },
    active,
    recoveryError,
    recordings: await allRecordings(),
  };
}
export type ExtensionState = Awaited<ReturnType<typeof state>>;
chrome.runtime.onMessage.addListener((message: any, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const documentURL = typeof sender.url === 'string' ? sender.url.split(/[?#]/)[0] : '';
  const trustedPage = [
    chrome.runtime.getURL('popup.html'),
    chrome.runtime.getURL('setup.html'),
  ].includes(documentURL);
  if (sender.tab && !trustedPage) {
    const tabId = sender.tab.id;
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
        if (meetingFor(message.url)?.identity !== owner.identity) {
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
    run().catch(logFailure('meeting observation'));
    return false;
  }
  if (message.target === 'offscreen') return false;
  if (
    sender.url === chrome.runtime.getURL('offscreen.html') &&
    ['TRUSTED_LINK', 'TRUSTED_REVOKE'].includes(message.type)
  ) {
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
  if (sender.url === chrome.runtime.getURL('offscreen.html') && message.type === 'CAPTURE_STATUS') {
    void setBadge(message.active);
    if (!message.active && message.endedRecordingId)
      void restoreOwner().then(() => {
        if (owner?.recordingId === message.endedRecordingId) void clearOwner();
      });
    return false;
  }
  if (!trustedPage) return false;
  const run = async () => {
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
      await deleteLocalRecording(
        message.recordingId,
        message.confirmed === true,
        owner?.recordingId,
      );
      await setBadge((await state()).active);
      return {};
    }
    if (message.type === 'START') return start(message);
    if (message.type === 'CONTROL' && ['pause', 'resume', 'stop'].includes(message.action)) {
      await restoreOwner();
      if (!owner || owner.recordingId !== message.recordingId)
        throw new Error('That recording is no longer active.');
      const id = owner.recordingId;
      const response = await send({ type: 'CONTROL', recordingId: id, action: message.action });
      if (message.action === 'stop') await clearOwner(id);
      return response;
    }
    if (message.type === 'PAIR_BEGIN')
      return beginPairing(typeof message.endpoint === 'string' ? message.endpoint : undefined);
    if (message.type === 'PAIR_CANCEL') return cancelPairing();
    if (message.type === 'PAIR_SHOW_APPROVAL') return showPairingApproval();
    if (message.type === 'DISCONNECT') return disconnect().then(() => ({}));
    if (message.type === 'MIC_GRANTED')
      return saveSettings({ micGranted: message.granted === true }).then(() => ({}));
    if (
      message.type === 'PROVIDER_ENABLED' &&
      ['meet', 'zoom', 'teams'].includes(message.provider)
    ) {
      await saveSettings((current) => {
        const providers = current.enabledProviders.filter((p) => p !== message.provider);
        if (message.enabled === true) providers.push(message.provider as Provider);
        return { enabledProviders: providers };
      });
      return {};
    }
    if (message.type === 'SYNC') {
      await migrateProtectedHistory();
      void send({ type: 'SYNC' }).catch(logFailure('transfer'));
      return {};
    }
    throw new Error('Unsupported extension action.');
  };
  run().then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: (error as Error).message }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void restoreOwner().then(() => {
    if (owner?.tabId === tabId)
      void stopOwner('tab-closed').catch(logFailure('stopping the recording'));
  });
  observations.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  void restoreOwner().then(() => {
    if (!owner || owner.tabId !== tabId) return;
    if (change.url && meetingFor(tab.url ?? change.url)?.identity !== owner.identity) {
      void stopOwner('meeting-changed').catch(logFailure('stopping the recording'));
      return;
    }
    if (change.status === 'loading') {
      observations.delete(tabId);
      void gate().catch(logFailure('microphone gate'));
    }
    if (change.status === 'loading' || change.status === 'complete')
      void verifyOwnerDocument(tabId).catch(logFailure('meeting document check'));
  });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'echo-transfer') return;
  void resumePairing().catch(logFailure('connection check'));
  void syncPending().catch(logFailure('transfer'));
});
chrome.runtime.onInstalled.addListener((details) => {
  // An update migrates settings and saved recordings right away, not at the next alarm.
  // A fresh install has nothing to migrate.
  void settings()
    .then(() => (details.reason === 'update' ? syncPending() : undefined))
    .catch(logFailure('migration'));
  void chrome.alarms.create('echo-transfer', { periodInMinutes: 0.5 });
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  void clearOwner();
  void syncPending().catch(logFailure('transfer'));
});
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  externalMessage(message, sender).then(respond, (error) => {
    console.warn('Echo: rejected a message from an Echo page.', error);
    respond({ ok: false, error: (error as Error).message });
  });
  return true;
});
whenConnected(() => void syncPending().catch(logFailure('transfer')));
setInterval(() => {
  void gate().catch(logFailure('microphone gate'));
}, 1000);
// Fallback for a missed ECHO_APPROVED message: claim while a request is waiting.
setInterval(() => {
  void resumePairing().catch(logFailure('connection claim'));
}, 1000);
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
