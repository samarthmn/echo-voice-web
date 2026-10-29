// Pairing v2: one POST /pair, one approval click in Echo, then a deterministic claim.
import { unixSecondsToMilliseconds } from './core';
import { readLink, saveLink, settings, Link } from './settings';
import { discover, hello } from './discovery';
import { connectionAction, forgetRemote } from './connection';
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
const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRED = 'The connection request expired. Choose Connect to Echo to try again.';
const BROWSER_NAME = 'Echo browser recorder';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let notice: string | undefined;
// The pair/claim request in flight. Cancel aborts it instead of waiting behind it.
let inFlight: AbortController | undefined;
function requestSignal(): AbortSignal {
  inFlight = new AbortController();
  return AbortSignal.any([inFlight.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}
const expired = (link: Waiting) => Date.now() >= link.expiresAt;
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
    signal: requestSignal(),
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
/**
 * Reserve a request whose POST /pair reply never arrived. Expired or refused reservations end
 * the waiting state, so the next Connect starts with a fresh secret instead of a dead request.
 */
async function reserved(link: Waiting, intent?: string): Promise<Waiting | undefined> {
  if (link.requestId) return link;
  if (expired(link)) {
    await end(EXPIRED);
    return undefined;
  }
  try {
    return await reserve(link, intent);
  } catch (error) {
    if (!(error instanceof ProtocolError) || error.status < 400 || error.status === 429)
      throw error;
    await end('Echo did not accept the connection request. Choose Connect to Echo to try again.');
    return undefined;
  }
}
async function claim(link: Waiting): Promise<PairingView> {
  if (expired(link)) return end(EXPIRED);
  try {
    const { installationId } = await settings();
    const body = await jsonRequest(link.endpoint, '/pair/claim', {
      method: 'POST',
      body: JSON.stringify({
        requestId: link.requestId,
        installationId,
        claimSecret: link.claimSecret,
      }),
      signal: requestSignal(),
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
/** True when the connected link is the Echo at `endpoint`, with the library that Echo serves now. */
async function linkedTo(link: Extract<Link, { state: 'connected' }>, endpoint?: string) {
  return (
    !!endpoint &&
    link.endpoint === endpoint &&
    (await hello(endpoint))?.libraryId === link.libraryId
  );
}
/**
 * Connect to Echo. `endpoint` is a manual (Advanced) or verified Echo origin; `intent` is
 * Echo's single-use approval for a connection Echo started, so no approval tab opens.
 * An Echo-started connection replaces a link to a different Echo (moved port, other library).
 */
export function beginPairing(
  endpoint?: string,
  intent?: string,
  replace = false,
): Promise<PairingView> {
  return connectionAction(async () => {
    notice = undefined;
    let link = await readLink();
    const previous = link.state === 'connected' ? link : undefined;
    if (previous && ((!intent && !replace) || (await linkedTo(previous, endpoint))))
      return view(previous);
    const reusable =
      link.state === 'waiting' &&
      !expired(link) &&
      !intent &&
      (!endpoint || link.endpoint === endpoint);
    const selectedEndpoint = async () => {
      if (replace && endpoint) {
        if (!(await hello(endpoint)))
          throw new Error('The requested Echo is unavailable. Try again.');
        return endpoint;
      }
      return discover(endpoint);
    };
    if (!reusable) {
      link = newRequest(await selectedEndpoint());
      // Persist before POST so a lost reply retries with the same installation and secret.
      await saveLink(link);
    }
    let waiting = await reserved(link as Waiting, intent);
    // An expired or rejected intent requires a fresh extension-initiated approval.
    if (!waiting && intent) {
      link = newRequest(await selectedEndpoint());
      await saveLink(link);
      waiting = await reserved(link as Waiting);
      intent = undefined;
    }
    if (!waiting) return view({ state: 'none' });
    if (!intent) await showApprovalTab(waiting);
    const result = await claim(waiting);
    if (intent && result.phase === 'waiting') await showApprovalTab(waiting);
    // Best effort: the replaced Echo stops listing this browser if it is still running.
    if (previous && result.phase === 'connected') void forgetRemote(previous);
    return result;
  });
}
/** Claim a waiting request (1 s poll, alarm, or ECHO_APPROVED for `requestId`). */
export function resumePairing(requestId?: string): Promise<PairingView> {
  return connectionAction(async () => {
    const link = await readLink();
    if (link.state !== 'waiting' || (requestId && link.requestId !== requestId)) return view(link);
    const waiting = await reserved(link);
    return waiting ? claim(waiting) : view({ state: 'none' });
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
/** Tell Echo the request is cancelled. Echo expires it anyway, so nobody waits for this. */
async function withdraw(link: Waiting): Promise<void> {
  const { installationId } = await settings();
  await jsonRequest(link.endpoint, `/pair/${encodeURIComponent(link.requestId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ installationId, claimSecret: link.claimSecret }),
    signal: AbortSignal.timeout(3_000),
  });
}
export function cancelPairing(): Promise<PairingView> {
  // A claim stuck on a hanging Echo would otherwise hold the queue for its whole timeout.
  inFlight?.abort();
  return connectionAction(async () => {
    const link = await readLink();
    if (link.state !== 'waiting') return view(link);
    const cancelled = await end('Connection cancelled.');
    if (link.requestId) {
      await closeApprovalTab(link.requestId);
      void withdraw(link).catch((error) =>
        console.warn('Echo: could not cancel the request in Echo.', error),
      );
    }
    return cancelled;
  });
}

type ConnectRequest = { id: string; endpoint: string; intent: string; receivedAt: number };
export async function pendingConnect() {
  const pending = (await chrome.storage.session.get('connectRequest')).connectRequest as
    | ConnectRequest
    | undefined;
  if (!pending) return undefined;
  const link = await readLink();
  return {
    id: pending.id,
    endpoint: pending.endpoint,
    previous: link.state === 'connected' ? link.endpoint : undefined,
  };
}
export async function confirmConnect(id: string, previous?: string) {
  const pending = (await chrome.storage.session.get('connectRequest')).connectRequest as
    | ConnectRequest
    | undefined;
  const view = await pendingConnect();
  if (!pending || !view || pending.id !== id || view.previous !== previous)
    throw new Error('The connection request changed. Review it and try again.');
  await chrome.storage.session.remove('connectRequest');
  const intent = Date.now() - pending.receivedAt < 120_000 ? pending.intent : undefined;
  return beginPairing(pending.endpoint, intent, true);
}
