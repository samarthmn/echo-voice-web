import { connectionRequest, extensionId, responseJson } from './guards.ts';
import { errorInfo } from './guards.ts';
function element(id: 'approve' | 'reject'): HTMLButtonElement;
function element(id: string): HTMLElement;
function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('This request is invalid. Try again from the extension.');
  return value;
}

const requestId = new URLSearchParams(location.hash.slice(1)).get('request');
const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
  requestId ?? '',
);
let expiresAt = 0;
let busy = false;
let terminal = false;
async function api(action?: string): Promise<unknown> {
  const response = await fetch(
    `/api/extensions/requests/${encodeURIComponent(requestId ?? '')}${action ? `/${action}` : ''}`,
    {
      method: action ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: action ? { 'Content-Type': 'application/json' } : {},
      ...(action ? { body: '{}' } : {}),
    },
  );
  if (!response.ok) {
    if ([403, 404, 410].includes(response.status)) {
      const error = new Error('Request unavailable');
      Object.assign(error, { unavailable: true });
      throw error;
    }
    throw new Error(
      'Echo could not complete this request. Check that Echo is running and try again.',
    );
  }
  return responseJson(response).catch(() => ({}));
}
function render(state: string) {
  terminal = state !== 'pending';
  element('approval-actions').hidden = terminal;
  element('back-to-echo').hidden = !terminal;
  element('browser-name').hidden = terminal;
  element('browser-origin').hidden = terminal;
  const success = state === 'approved' || state === 'claimed';
  element('connection-heading').textContent = !terminal
    ? 'Allow this browser to send recordings to Echo?'
    : success
      ? 'Browser connected'
      : state === 'rejected'
        ? 'Connection declined'
        : 'This request expired';
  element('status').textContent = !terminal
    ? 'This browser can transfer recordings to your local Echo library.'
    : success
      ? 'You can close this tab.'
      : 'Start again from the Echo extension: click the Echo icon, then Connect to Echo.';
}

function fail(error: unknown, retry = true) {
  element('error').textContent = errorInfo(error).message ?? '';
  element('error').hidden = false;
  element('retry').hidden = !retry;
}
async function load() {
  element('error').hidden = true;
  element('retry').hidden = true;
  if (!valid) {
    render('expired');
    return;
  }
  try {
    const body = connectionRequest(await api());
    if (
      body.requestId !== requestId ||
      typeof body.name !== 'string' ||
      typeof body.origin !== 'string' ||
      !Number.isSafeInteger(body.expiresAt)
    )
      throw new Error('This request is invalid. Try again from the extension.');
    element('browser-name').textContent = body.name;
    element('browser-origin').textContent = body.origin;
    expiresAt = body.expiresAt * 1000;
    render(Date.now() >= expiresAt && body.status === 'pending' ? 'expired' : body.status);
  } catch (error) {
    element('approval-actions').hidden = true;
    if (errorInfo(error).unavailable) render('expired');
    else fail(error);
  }
}
async function notifyExtension() {
  try {
    const response = await fetch('/js/extension-id.json');
    const id = extensionId(await responseJson(response));
    chrome.runtime.sendMessage(id, { type: 'ECHO_APPROVED', requestId }, () => {
      if (chrome.runtime.lastError) return;
    });
  } catch {
    /* The extension also polls for approval. */
  }
}
async function decide(action: string) {
  if (busy || terminal || !valid) return;
  if (Date.now() >= expiresAt) {
    render('expired');
    return;
  }
  busy = true;
  element('approve').disabled = true;
  element('reject').disabled = true;
  element('status').textContent = action === 'approve' ? 'Connecting…' : 'Declining…';
  try {
    await api(action);
    element('error').hidden = true;
    element('retry').hidden = true;
    render(action === 'approve' ? 'approved' : 'rejected');
    if (action === 'approve') void notifyExtension();
  } catch (error) {
    if (errorInfo(error).unavailable) render('expired');
    else {
      render('pending');
      fail(error, false);
    }
  } finally {
    busy = false;
    element('approve').disabled = false;
    element('reject').disabled = false;
  }
}
element('approve').addEventListener('click', () => {
  void decide('approve');
});
element('reject').addEventListener('click', () => {
  void decide('reject');
});
element('retry').addEventListener('click', () => {
  void load();
});
setInterval(() => {
  if (!busy && !terminal && expiresAt && Date.now() >= expiresAt) render('expired');
}, 1000);
void load();
