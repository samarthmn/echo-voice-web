// Pairing v2: one POST /pair, one approval click in Echo, then a deterministic claim.
import { unixSecondsToMilliseconds } from './core';
import { readLink, saveLink, settings, Link } from './settings';
import { discover } from './discovery';
import { connectionAction } from './connection';
import { jsonRequest, ProtocolError } from './protocol';
type Waiting = Extract<Link, { state: 'waiting' }>;
type ApprovalTab = { requestId: string; id: number; url: string };
export type PairingView = {
  phase: Link['state'];
  endpoint?: string;
  requestId?: string;
  notice?: string;
};
const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const BROWSER_NAME = 'Echo browser recorder';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let notice: string | undefined;
let onConnected: () => void = () => {};
/** Register the action that runs right after a claim succeeds (upload pending audio). */
export function whenConnected(callback: () => void): void {
  onConnected = callback;
}
function view(link: Link): PairingView {
  return {
    phase: link.state,
    endpoint: link.state === 'none' ? undefined : link.endpoint,
    requestId: link.state === 'waiting' ? link.requestId : undefined,
    notice,
  };
}
async function end(message: string): Promise<PairingView> {
  await saveLink({ state: 'none' });
  notice = message;
  return view({ state: 'none' });
}
function approvalURL(link: Waiting): string {
  return `${link.endpoint}/extension-connect.html#request=${encodeURIComponent(link.requestId)}`;
}
async function showApprovalTab(link: Waiting): Promise<void> {
  const url = approvalURL(link);
  const existing = (await chrome.tabs.query({ url: `${link.endpoint}/*` })).find(
    (tab) => tab.url === url,
  );
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined)
      await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  const tab = await chrome.tabs.create({ url });
  // Session storage survives worker suspension. Only a tab this extension opened is closed.
  if (tab.id !== undefined)
    await chrome.storage.session.set({
      approvalTab: { requestId: link.requestId, id: tab.id, url } satisfies ApprovalTab,
    });
}
async function closeApprovalTab(requestId: string): Promise<void> {
  const tab = (await chrome.storage.session.get('approvalTab')).approvalTab as
    | ApprovalTab
    | undefined;
  if (tab?.requestId !== requestId) return;
  await chrome.storage.session.remove('approvalTab');
  const current = await chrome.tabs.get(tab.id).catch(() => undefined); // Closed by the user.
  if (current?.url === tab.url) await chrome.tabs.remove(tab.id);
}
async function reserve(link: Waiting, intent?: string): Promise<Waiting> {
  const { installationId } = await settings();
  const body = await jsonRequest(link.endpoint, '/pair', {
    method: 'POST',
    body: JSON.stringify({
      installationId,
      name: BROWSER_NAME,
      claimSecret: link.claimSecret,
      ...(intent ? { intent } : {}),
    }),
  });
  if (!uuid.test(body.requestId) || !['pending', 'approved'].includes(body.status))
    throw new Error('Echo returned an invalid connection request.');
  const next: Waiting = {
    ...link,
    requestId: body.requestId,
    expiresAt: unixSecondsToMilliseconds(body.expiresAt),
  };
  await saveLink(next);
  return next;
}
async function claim(link: Waiting): Promise<PairingView> {
  if (Date.now() >= link.expiresAt)
    return end('The connection request expired. Choose Connect to Echo to try again.');
  try {
    const { installationId } = await settings();
    const body = await jsonRequest(link.endpoint, '/pair/claim', {
      method: 'POST',
      body: JSON.stringify({
        requestId: link.requestId,
        installationId,
        claimSecret: link.claimSecret,
      }),
    });
    if (body.status === 'pending') return view(link);
    if (
      body.status !== 'approved' ||
      typeof body.credential !== 'string' ||
      !/^[0-9a-f]{64}$/.test(body.credential) ||
      !uuid.test(body.libraryId)
    )
      throw new Error('Echo returned an invalid approval.');
    const connected: Link = {
      state: 'connected',
      endpoint: link.endpoint,
      libraryId: body.libraryId,
      credential: body.credential,
    };
    await saveLink(connected);
    await closeApprovalTab(link.requestId);
    onConnected();
    return view(connected);
  } catch (error) {
    if (error instanceof ProtocolError && error.status === 403) {
      await closeApprovalTab(link.requestId);
      return end(
        'Echo declined or no longer has this request. Choose Connect to Echo to try again.',
      );
    }
    // The secret stays saved: the credential is deterministic, so a retry after a lost reply is safe.
    throw error;
  }
}
function newRequest(endpoint: string): Waiting {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return {
    state: 'waiting',
    endpoint,
    requestId: '',
    claimSecret: Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    expiresAt: Date.now() + REQUEST_LIFETIME_MS,
  };
}
/**
 * Connect to Echo. `endpoint` is a manual (Advanced) or verified Echo origin; `intent` is
 * Echo's single-use approval for a connection Echo started, so no approval tab opens.
 */
export function beginPairing(endpoint?: string, intent?: string): Promise<PairingView> {
  return connectionAction(async () => {
    notice = undefined;
    let link = await readLink();
    if (link.state === 'connected') return view(link);
    const reusable =
      link.state === 'waiting' &&
      Date.now() < link.expiresAt &&
      !intent &&
      (!endpoint || link.endpoint === endpoint);
    if (!reusable) {
      link = newRequest(await discover(endpoint));
      // Persist before POST so a lost reply retries with the same installation and secret.
      await saveLink(link);
    }
    let waiting = link as Waiting;
    if (!waiting.requestId) waiting = await reserve(waiting, intent);
    if (!intent) await showApprovalTab(waiting);
    return claim(waiting);
  });
}
/** Claim a waiting request (1 s poll, alarm, or ECHO_APPROVED for `requestId`). */
export function resumePairing(requestId?: string): Promise<PairingView> {
  return connectionAction(async () => {
    const link = await readLink();
    if (link.state !== 'waiting' || (requestId && link.requestId !== requestId)) return view(link);
    return link.requestId ? claim(link) : claim(await reserve(link));
  });
}
export function pairingView(): Promise<PairingView> {
  return readLink().then(view);
}
export function showPairingApproval(): Promise<PairingView> {
  return connectionAction(async () => {
    const link = await readLink();
    if (link.state === 'waiting' && link.requestId) await showApprovalTab(link);
    return view(link);
  });
}
export function cancelPairing(): Promise<PairingView> {
  return connectionAction(async () => {
    const link = await readLink();
    if (link.state !== 'waiting') return view(link);
    if (link.requestId) {
      const { installationId } = await settings();
      // Echo expires the request on its own; never keep the user waiting on an offline server.
      await jsonRequest(link.endpoint, `/pair/${encodeURIComponent(link.requestId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ installationId, claimSecret: link.claimSecret }),
      }).catch((error) => console.warn('Echo: could not cancel the request in Echo.', error));
      await closeApprovalTab(link.requestId);
    }
    return end('Connection cancelled.');
  });
}
