/** Send a message to the installed extension, using the ID generated at build time. */
export async function extensionMessage(message) {
  const response = await fetch('/js/extension-id.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Extension ID is unavailable');
  const { id } = await response.json();
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Extension is not installed');
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(id, message, (reply) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(reply);
    });
  });
}
if (globalThis.document?.body && globalThis.location) {
  window.echoExtensionMessage = extensionMessage;
  void extensionMessage({ type: 'ECHO_PRESENT', origin: location.origin }).catch(() => {});

  // Native modal dialogs trap focus, restore focus on close, and handle Escape.
  const dialog = document.createElement('dialog');
  dialog.className = 'extension-approval-dialog';
  dialog.setAttribute('aria-labelledby', 'extension-approval-title');
  dialog.innerHTML = `<h2 id="extension-approval-title">Allow this browser to send recordings to Echo?</h2>
<p id="extension-approval-name"></p><p id="extension-approval-origin"></p>
<p id="extension-approval-error" role="alert" hidden></p>
<div class="connection-actions"><button type="button" class="button button-primary" data-action="approve">Allow</button><button type="button" class="button button-secondary" data-action="reject">Don't allow</button></div>`;
  document.body.append(dialog);
  let current = null;
  let dismissed = null;
  let busy = false;
  async function poll() {
    if (document.hidden || busy) return;
    try {
      const response = await fetch('/api/extensions/connections', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const pending = Array.isArray(data.pending) ? data.pending : [];
      if (dismissed && !pending.some((request) => request.requestId === dismissed))
        dismissed = null;
      const request = pending.find((item) => item.requestId !== dismissed);
      if (!request) {
        if (dialog.open) dialog.close();
        current = null;
        return;
      }
      current = request;
      dialog.querySelector('#extension-approval-name').textContent = request.name || 'Browser';
      dialog.querySelector('#extension-approval-origin').textContent = request.origin || '';
      if (!dialog.open) {
        dialog.querySelector('#extension-approval-error').hidden = true;
        dialog.showModal();
      }
    } catch {
      /* Retry when Echo is available. */
    }
  }
  dialog.addEventListener('cancel', () => {
    dismissed = current?.requestId;
  });
  dialog.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action || !current || busy) return;
    busy = true;
    const buttons = dialog.querySelectorAll('button');
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const response = await fetch(
        `/api/extensions/requests/${encodeURIComponent(current.requestId)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) throw new Error('Could not finish this request. Check Echo and try again.');
      if (action === 'approve')
        void extensionMessage({ type: 'ECHO_APPROVED', requestId: current.requestId }).catch(
          () => {},
        );
      dialog.close();
      current = null;
    } catch (error) {
      const message = dialog.querySelector('#extension-approval-error');
      message.textContent = error.message;
      message.hidden = false;
    } finally {
      busy = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
      void poll();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll();
  });
  setInterval(poll, 3000);
  void poll();
}
