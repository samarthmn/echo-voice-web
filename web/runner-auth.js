// A dedicated runner browser. Credentials go only to the local server, never logs or storage.
export const RUNNER_SCREEN = Object.freeze({ width: 1280, height: 900 });
const KEYS = new Set(['Enter', 'Tab', 'Shift+Tab', 'Control+A', 'Meta+A', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const BASE = '/api/integrations/runner/auth';

/** Map an actual image click to the fixed remote viewport without assuming desktop scale. */
export function screenPoint(clientX, clientY, rect) {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error('The sign-in screen is not ready.');
  if (clientX < rect.left || clientY < rect.top || clientX > rect.left + rect.width || clientY > rect.top + rect.height) throw new Error('Select a point inside the sign-in screen.');
  return { x: Math.min(1279, Math.floor((clientX - rect.left) / rect.width * 1280)), y: Math.min(899, Math.floor((clientY - rect.top) / rect.height * 900)) };
}

/** Validate the narrow input protocol before sending any user text. */
export function runnerInput(input) {
  switch (input.type) {
    case 'click':
      if (!Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.x >= 1280 || input.y < 0 || input.y >= 900) throw new Error('Invalid sign-in screen position.');
      return { type: 'click', x: input.x, y: input.y };
    case 'key':
      if (!KEYS.has(input.key)) throw new Error('This key is not supported in the sign-in browser.');
      return { type: 'key', key: input.key };
    case 'text':
      if (typeof input.text !== 'string' || !input.text.length || new TextEncoder().encode(input.text).length > 4096 || /\p{Cc}/u.test(input.text)) throw new Error('Enter a shorter value without line breaks or control characters.');
      return { type: 'text', text: input.text };
    case 'scroll':
      if (!Number.isFinite(input.deltaY)) throw new Error('Invalid scroll.');
      return { type: 'scroll', deltaY: Math.max(-900, Math.min(900, Math.round(input.deltaY))) };
    default: throw new Error('Unsupported sign-in input.');
  }
}

/** One session owns one ordered input queue and one screenshot request at a time. */
export function createRunnerSession(sessionId, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('The runner returned an invalid sign-in session.');
  const lifetime = new AbortController();
  let closing = false, queue = Promise.resolve(), queued = 0, screenPending;
  async function request(path, body, { image = false, signal = lifetime.signal, keepalive = false, budgetMs = timeoutMs } = {}) {
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    if (signal.aborted) timeout.abort(); else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, budgetMs);
    try {
      const response = await fetchImpl(`${BASE}${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: timeout.signal, keepalive, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }) } : {}) });
      if (image && response.ok) {
        if (!(response.headers.get('content-type') || '').startsWith('image/jpeg')) throw new Error('The runner returned an unreadable sign-in screen.');
        const hostname = response.headers.get('x-runner-hostname') || '';
        return { blob: await response.blob(), hostname: /^[a-z0-9.-]{1,253}$/i.test(hostname) ? hostname : '' };
      }
      const value = await response.json().catch(() => null);
      if (!response.ok) { const error = new Error(value?.error || 'The runner could not complete this sign-in request.'); error.status = response.status; throw error; }
      return value;
    } catch (error) {
      if (error.name === 'AbortError' && !signal.aborted) throw new Error('The runner took too long to respond. Try again.');
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  return {
    input(input) {
      if (closing) return Promise.reject(new Error('This sign-in session is closing.'));
      let payload;
      try { payload = runnerInput(input); } catch (error) { return Promise.reject(error); }
      if (queued >= 20) return Promise.reject(new Error('Wait for the sign-in browser to finish the previous inputs.'));
      queued++;
      const task = queue.then(() => { if (closing) throw new Error('This sign-in session is closing.'); return request('/input', payload); });
      queue = task.catch(() => {}).finally(() => { queued--; });
      return task;
    },
    screen() {
      if (closing) return Promise.reject(new Error('This sign-in session is closing.'));
      if (!screenPending) screenPending = request(`/screen?sessionId=${encodeURIComponent(sessionId)}`, null, { image: true }).finally(() => { screenPending = null; });
      return screenPending;
    },
    status() { return request('', null); },
    async finish() {
      if (closing) throw new Error('This sign-in session is closing.');
      await queue;
      return request('/finish', {}, { budgetMs: Math.max(timeoutMs, 55_000) });
    },
    async cancel() {
      closing = true;
      lifetime.abort();
      // Cancellation must survive aborting the screen/input requests. A failed acknowledgement is retryable.
      return request('/cancel', {}, { signal: new AbortController().signal, budgetMs: Math.max(timeoutMs, 40_000) });
    },
    pagehide() {
      closing = true; lifetime.abort();
      void request('/cancel', {}, { signal: new AbortController().signal, keepalive: true, budgetMs: Math.max(timeoutMs, 40_000) }).catch(() => {});
    },
    dispose() { closing = true; lifetime.abort(); },
  };
}

let activeModal, nativeAuth;
const announce = () => window.dispatchEvent(new CustomEvent('echo-runner-auth-changed', { detail: nativeAuth?.getState() || { busy: false, error: '' } }));

/** Native-window sign-in never creates credential fields or requests screenshots/input. */
export function createNativeRunnerAuth({ start = body => authRequest('POST', body), session = id => createRunnerSession(id), uuid = () => crypto.randomUUID(), onChange = () => {} } = {}) {
  let state = { busy: false, operation: '', error: '' }, owned, pending, generation = 0;
  const publish = value => { state = { ...state, ...value }; onChange({ ...state }); };
  function action(operation, task) {
    if (pending) return pending;
    publish({ busy: true, operation, error: '' });
    pending = Promise.resolve().then(task).catch(failure => { publish({ error: failure.message || 'The meeting runner is unavailable.' }); throw failure; }).finally(() => { pending = null; publish({ busy: false, operation: '' }); });
    return pending;
  }
  function own(id) {
    if (owned && owned.id !== id) throw new Error('A different runner sign-in session is already open.');
    if (!owned) owned = { id, transport: session(id) };
    return owned.transport;
  }
  const clear = () => { owned?.transport.dispose(); owned = null; };
  return {
    getState: () => ({ ...state }),
    start() {
      return action('start', async () => {
        const currentGeneration = generation;
        if (owned) { await owned.transport.cancel(); clear(); }
        if (currentGeneration !== generation) throw new Error('Sign-in was cancelled when this page closed.');
        const id = uuid(), transport = own(id);
        try {
          const value = await start({ sessionId: id });
          if (value?.mode !== 'native_window' || value.sessionId !== id || value.state !== 'signing_in') throw new Error(value?.detail || 'The separate sign-in browser did not open. Check the local runner and try again.');
          return value;
        } catch (failure) {
          try { await transport.cancel(); clear(); } catch { /* Keep the owned identity for pagehide cleanup. */ }
          throw failure;
        }
      });
    },
    finish(id) {
      return action('finish', async () => {
        const value = await own(id).finish();
        if (value?.state !== 'signed_in' || value.accountMatches === false) throw new Error(value?.detail || 'Sign in with the connected Calendar account, then save again.');
        clear(); return value;
      });
    },
    cancel(id) {
      return action('cancel', async () => { const value = await own(id).cancel(); clear(); return value; });
    },
    pagehide() { generation++; owned?.transport.pagehide(); clear(); },
  };
}

async function authRequest(method, body = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(BASE, { method, cache: 'no-store', signal: controller.signal, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error || 'The meeting runner is unavailable. Start the local runner and try again.');
    return value;
  } catch (error) { if (error.name === 'AbortError') throw new Error('The runner took too long to respond. Check the local runner and try again.'); throw error; }
  finally { clearTimeout(timer); }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
function button(label, kind = 'secondary') {
  const element = node('button', `button button-${kind}`, label); element.type = 'button'; return element;
}

/** Open the user-operated remote browser; the host page never inspects Google field contents. */
async function openRunnerSignIn(event) {
  if (event?.detail?.mode === 'native_window') { if (!activeModal) void nativeAuth.start().catch(() => {}); return; }
  if (activeModal) return;
  const backdrop = node('div', 'dialog-backdrop runner-auth-backdrop');
  const dialog = node('div', 'dialog runner-auth-dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'runner-auth-title');
  const close = button('Close', 'ghost'); close.classList.add('dialog-close'); close.setAttribute('aria-label', 'Cancel runner sign-in');
  const title = node('h2', '', 'Sign in to the meeting runner'); title.id = 'runner-auth-title';
  const description = node('p', '', 'Use the account connected to Google Calendar. The saved browser profile stays on this computer. Camera and microphone access are blocked.');
  const status = node('p', 'runner-auth-status', 'Opening the sign-in browser…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const host = node('p', 'runner-auth-host', 'Dedicated local browser');
  const viewer = node('div', 'runner-auth-viewer'); viewer.tabIndex = 0; viewer.setAttribute('role', 'group'); viewer.setAttribute('aria-label', 'Google sign-in browser. Select a field, then use the text entry below. Arrow keys and Enter control the browser.');
  const image = node('img'); image.alt = 'Dedicated Google sign-in browser'; image.draggable = false; viewer.append(image);
  const form = node('form', 'runner-auth-entry'); form.autocomplete = 'off';
  const label = node('label', '', 'Text to enter in Google'); label.htmlFor = 'runner-auth-text';
  const field = node('input', 'input'); field.id = 'runner-auth-text'; field.type = 'password'; field.autocomplete = 'off'; field.spellcheck = false; field.maxLength = 4096; field.disabled = true; field.setAttribute('aria-describedby', 'runner-auth-input-help');
  for (const element of [form, field]) {
    element.setAttribute('data-1p-ignore', 'true'); element.setAttribute('data-lpignore', 'true'); element.setAttribute('data-bwignore', 'true'); element.setAttribute('data-form-type', 'other');
  }
  const send = button('Send text'); send.type = 'submit'; send.disabled = true;
  const helper = node('small', 'small-muted', 'Select a field above first. Text is masked here and cleared after sending.'); helper.id = 'runner-auth-input-help';
  const keys = node('div', 'runner-auth-keys');
  const actions = node('div', 'runner-auth-actions');
  const save = button('Save session', 'primary'); save.disabled = true;
  actions.append(save); form.append(label, field, send, helper);
  dialog.append(close, title, description, status, host, viewer, form, keys, actions); backdrop.append(dialog); document.body.append(backdrop);
  // Reserve our exact identity before starting so closing during startup cannot orphan a browser.
  const sessionId = event?.detail?.sessionId || crypto.randomUUID();
  const modal = { backdrop, session: createRunnerSession(sessionId), stopped: false }; activeModal = modal;
  let timer, imageUrl, busy = false, ready = false, zoomed = false, expectedEmail;
  const error = value => { status.textContent = value?.message || 'The sign-in browser is unavailable.'; status.classList.add('runner-auth-error'); };
  function cleanup() {
    modal.stopped = true; clearTimeout(timer); field.value = ''; modal.session?.dispose();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    window.removeEventListener('pagehide', onPageHide); backdrop.remove(); if (activeModal === modal) activeModal = null; announce();
  }
  async function cancel() {
    if (busy) return;
    busy = true; close.disabled = save.disabled = true; modal.stopped = true; clearTimeout(timer); field.value = '';
    try { if (modal.session) await modal.session.cancel(); cleanup(); }
    catch (failure) { error(failure); busy = false; close.disabled = false; }
  }
  function onPageHide() { modal.session?.pagehide(); cleanup(); }
  window.addEventListener('pagehide', onPageHide);
  close.addEventListener('click', cancel);
  async function input(payload) {
    if (!modal.session || modal.stopped || busy || !ready) return;
    try { await modal.session.input(payload); }
    catch (failure) { if (!modal.stopped) error(failure); }
  }
  image.addEventListener('click', event => {
    if (!imageUrl) return;
    viewer.focus();
    try { void input({ type: 'click', ...screenPoint(event.clientX, event.clientY, image.getBoundingClientRect()) }); }
    catch (failure) { error(failure); }
  });
  viewer.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); void input({ type: 'key', key: event.metaKey ? 'Meta+A' : 'Control+A' }); return; }
    if (event.key === 'Tab' || event.key === 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (KEYS.has(event.key)) { event.preventDefault(); void input({ type: 'key', key: event.key }); }
    else if ([...event.key].length === 1) { event.preventDefault(); void input({ type: 'text', text: event.key }); }
  });
  viewer.addEventListener('wheel', event => { if (modal.session && !modal.stopped && !zoomed) { event.preventDefault(); void input({ type: 'scroll', deltaY: event.deltaY }); } }, { passive: false });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const text = field.value; field.value = '';
    if (!text || send.disabled) return;
    send.disabled = true; await input({ type: 'text', text }); send.disabled = false; field.focus();
  });
  for (const [label, key] of [['Previous field', 'Shift+Tab'], ['Next field', 'Tab'], ['Backspace', 'Backspace'], ['Enter', 'Enter']]) {
    const control = button(label, 'ghost'); control.addEventListener('click', () => input({ type: 'key', key })); keys.append(control);
  }
  const zoom = button('Zoom in', 'ghost');
  zoom.addEventListener('click', () => { zoomed = !zoomed; viewer.classList.toggle('runner-auth-zoomed', zoomed); zoom.textContent = zoomed ? 'Fit screen' : 'Zoom in'; });
  keys.append(zoom);
  for (const [label, deltaY] of [['Scroll up', -500], ['Scroll down', 500]]) {
    const control = button(label, 'ghost'); control.addEventListener('click', () => input({ type: 'scroll', deltaY })); keys.append(control);
  }
  save.addEventListener('click', async () => {
    if (!modal.session || busy || modal.stopped) return;
    busy = true; save.disabled = close.disabled = send.disabled = true;
    status.textContent = 'Verifying the connected account…'; status.classList.remove('runner-auth-error');
    try {
      const value = await modal.session.finish();
      if (value?.state !== 'signed_in' || value.accountMatches === false) throw new Error(value?.detail || 'Sign in with the account connected to Google Calendar, then save again.');
      cleanup();
    } catch (failure) { error(failure); busy = false; save.disabled = close.disabled = send.disabled = false; }
  });
  async function pollScreen() {
    if (modal.stopped || !modal.session) return;
    try {
      const { blob, hostname } = await modal.session.screen();
      if (modal.stopped) return;
      const next = URL.createObjectURL(blob), previous = imageUrl; imageUrl = next; image.src = next;
      host.textContent = hostname ? `Browser address: ${hostname}` : 'Dedicated local browser';
      if (previous) URL.revokeObjectURL(previous);
    } catch (failure) {
      if (!modal.stopped) error(failure);
      if (!modal.stopped && [404, 409, 410].includes(failure.status)) {
        try {
          const current = await modal.session.status();
          if (!modal.stopped && (current.state !== 'signing_in' || current.sessionId !== sessionId || expectedEmail && current.expectedEmail?.toLowerCase() !== expectedEmail.toLowerCase())) {
            ready = false; modal.stopped = true; save.disabled = field.disabled = send.disabled = true; field.value = '';
            viewer.setAttribute('aria-disabled', 'true'); modal.session.dispose();
            if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; image.removeAttribute('src'); }
            status.textContent = current.detail || (current.state === 'signed_in' ? 'The Google session was saved. Close this dialog to refresh.' : 'This sign-in session has ended. Close this dialog and sign in again.');
            announce();
          }
        } catch (statusFailure) { if (!modal.stopped) error(statusFailure); }
      }
    }
    if (!modal.stopped) timer = setTimeout(pollScreen, 1000);
  }
  try {
    const value = await authRequest('POST', { sessionId });
    if (value?.state === 'signed_in' && !value.sessionId) { cleanup(); return; }
    if (value?.sessionId !== sessionId) throw new Error('The runner returned a different sign-in session. Close this dialog and retry.');
    if (modal.stopped) { await modal.session.cancel(); return; }
    ready = true; save.disabled = field.disabled = send.disabled = false;
    expectedEmail = value.expectedEmail;
    status.textContent = value.expectedEmail ? `Sign in as ${value.expectedEmail}, then select Save session.` : 'Complete Google sign-in, then select Save session.';
    void pollScreen();
  } catch (failure) { if (!modal.stopped) error(failure); }
}

function confirmSignOut() {
  if (activeModal) return;
  const backdrop = node('div', 'dialog-backdrop'), dialog = node('div', 'dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'runner-signout-title');
  const title = node('h2', '', 'Sign out of the meeting runner?'); title.id = 'runner-signout-title';
  const description = node('p', '', 'This removes the saved Google session. Your calendar connection and saved recordings stay available.');
  const status = node('p', 'runner-auth-status'); status.setAttribute('role', 'alert');
  const actions = node('div', 'runner-auth-actions'), cancel = button('Cancel'), confirm = button('Sign out', 'primary');
  cancel.classList.add('dialog-close');
  const cleanup = () => { backdrop.remove(); activeModal = null; announce(); };
  cancel.addEventListener('click', cleanup);
  confirm.addEventListener('click', async () => {
    cancel.disabled = confirm.disabled = true;
    try { await authRequest('DELETE'); cleanup(); }
    catch (failure) { status.textContent = failure.message; cancel.disabled = confirm.disabled = false; }
  });
  actions.append(cancel, confirm); dialog.append(title, description, status, actions); backdrop.append(dialog); activeModal = { backdrop }; document.body.append(backdrop);
}

if (typeof window !== 'undefined') {
  nativeAuth = createNativeRunnerAuth({ onChange: announce });
  const subscribers = new Map();
  window.echoRunnerAuth = {
    getState: nativeAuth.getState,
    subscribe(id, callback) {
      if (subscribers.has(id)) window.removeEventListener('echo-runner-auth-changed', subscribers.get(id));
      subscribers.set(id, callback); window.addEventListener('echo-runner-auth-changed', callback);
    },
    unsubscribe(id) {
      const callback = subscribers.get(id);
      if (callback) window.removeEventListener('echo-runner-auth-changed', callback);
      subscribers.delete(id);
    },
  };
  window.addEventListener('echo-runner-sign-in', openRunnerSignIn);
  window.addEventListener('echo-runner-sign-out', confirmSignOut);
  window.addEventListener('echo-runner-save-session', event => { void nativeAuth.finish(event.detail?.sessionId).catch(() => {}); });
  window.addEventListener('echo-runner-cancel-sign-in', event => { void nativeAuth.cancel(event.detail?.sessionId).catch(() => {}); });
  window.addEventListener('pagehide', () => nativeAuth.pagehide());
}
