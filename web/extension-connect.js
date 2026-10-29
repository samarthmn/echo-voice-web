const element = (id) => document.getElementById(id);
const requestId = new URLSearchParams(location.hash.slice(1)).get('request');
const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
  requestId ?? '',
);
let expiresAt = 0;
let busy = false;
let terminal = false;
async function api(action) {
  const response = await fetch(
    `/api/extensions/requests/${requestId}${action ? `/${action}` : ''}`,
    {
      method: action ? 'POST' : 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: action ? { 'Content-Type': 'application/json' } : {},
      ...(action ? { body: '{}' } : {}),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 404 || response.status === 403 || response.status === 410
        ? 'This request is no longer available. Return to the extension and choose Connect to Echo again.'
        : 'Echo could not check this request. Try again.',
    );
  return response.json();
}
function status(text) {
  element('status').textContent = text;
}
function fail(error) {
  element('error').textContent = error.message;
  element('error').hidden = false;
  element('retry').hidden = false;
}
function render(body) {
  const state = body.status;
  terminal = state !== 'pending';
  element('approval-actions').hidden = terminal;
  if (state === 'pending') status('Approve this request to finish connecting your extension.');
  else if (['approved', 'prepared', 'claimed'].includes(state))
    status(
      'Connection approved. Return to the extension; it will finish connecting automatically. You can close this page.',
    );
  else if (['rejected', 'cancelled'].includes(state))
    status('Connection cancelled. Your existing connection and saved recordings are unchanged.');
  else status('This request expired. Return to the extension and choose Connect to Echo again.');
}
async function load() {
  if (!valid) {
    terminal = true;
    element('approval-actions').hidden = true;
    status('This connection link is invalid. Open the extension and choose Connect to Echo.');
    return;
  }
  try {
    element('error').hidden = true;
    element('retry').hidden = true;
    const body = await api();
    if (
      body.requestId !== requestId ||
      typeof body.name !== 'string' ||
      typeof body.origin !== 'string' ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(body.origin) ||
      !Number.isSafeInteger(body.expiresAt)
    )
      throw new Error(
        'Echo returned an invalid connection request. Return to the extension and try again.',
      );
    // Display unverified labels as text. Never navigate to URL parameters or caller-supplied URLs.
    element('installation-name').textContent = body.name;
    element('extension-id').textContent = body.origin.slice('chrome-extension://'.length);
    element('echo-address').textContent = location.origin;
    expiresAt = body.expiresAt * 1000;
    render(
      Date.now() >= expiresAt && !['claimed', 'approved', 'prepared'].includes(body.status)
        ? { ...body, status: 'expired' }
        : body,
    );
  } catch (error) {
    element('approval-actions').hidden = true;
    fail(error);
  }
}
async function decide(action) {
  if (busy || terminal || !valid) return;
  if (Date.now() >= expiresAt) {
    render({ status: 'expired' });
    return;
  }
  busy = true;
  element('approve').disabled = true;
  element('reject').disabled = true;
  try {
    const body = await api(action);
    element('error').hidden = true;
    element('retry').hidden = true;
    render(body);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    element('approve').disabled = false;
    element('reject').disabled = false;
  }
}
element('approve').addEventListener('click', () => decide('approve'));
element('reject').addEventListener('click', () => decide('reject'));
element('retry').addEventListener('click', load);
setInterval(() => {
  if (!busy && !terminal && expiresAt && Date.now() >= expiresAt) render({ status: 'expired' });
}, 1000);
void load();
