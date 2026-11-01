import { connectionRequest, extensionIds, extensionReply, record, responseJson } from './guards.ts';
import type { ConnectionRequest, ExtensionMessage, ExtensionReply } from './types/domain.ts';
import { errorInfo } from './guards.ts';
/**
 * Send a message to the installed extension. The unpacked and Chrome Web Store
 * builds have different IDs (generated at build time); the first that answers wins.
 */
async function extensionMessage(message: ExtensionMessage): Promise<ExtensionReply> {
  const response = await fetch('/js/extension-id.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Extension ID is unavailable');
  const ids = extensionIds(await responseJson(response));
  if (
    !(globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
      ?.sendMessage
  )
    throw new Error('Extension is not installed');
  let lastError: unknown;
  for (const id of ids) {
    try {
      return await messageExtension(id, message);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
function messageExtension(id: string, message: ExtensionMessage): Promise<ExtensionReply> {
  return new Promise<ExtensionReply>((resolve, reject: (reason?: unknown) => void) => {
    chrome.runtime.sendMessage(id, message, (reply: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(errorInfo(error).message));
      else {
        try {
          resolve(extensionReply(reply));
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original API/runtime rejection value and its identity for existing error handling.
          reject(error);
        }
      }
    });
  });
}
if (
  (globalThis as { document?: Document; location?: Location }).document?.body &&
  (globalThis as { location?: Location }).location
) {
  window.echoExtensionMessage = extensionMessage;
  void extensionMessage({ type: 'ECHO_PRESENT', origin: location.origin }).catch(() => {
    /* Presence is best effort when the extension is unavailable. */
  });

  // Native modal dialogs trap focus, restore focus on close, and handle Escape.
  const dialog = document.createElement('dialog');
  dialog.className = 'extension-approval-dialog';
  dialog.setAttribute('aria-labelledby', 'extension-approval-title');
  dialog.innerHTML = `<h2 id="extension-approval-title">Allow this browser to send recordings to Echo?</h2>
<p id="extension-approval-name"></p><p id="extension-approval-origin"></p>
<p id="extension-approval-error" role="alert" hidden></p>
<div class="connection-actions"><button type="button" class="button button-primary" data-action="approve">Allow</button><button type="button" class="button button-secondary" data-action="reject">Don't allow</button></div>`;
  document.body.append(dialog);
  let current: ConnectionRequest | null = null;
  let dismissed: string | null | undefined = null;
  let busy = false;
  let polling = false;
  const isBusy = () => busy;
  const buttons = dialog.querySelectorAll('button');
  const invalidate = () => {
    current = null;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    if (dialog.open) dialog.close();
  };
  const customLayerOpen = () =>
    document.querySelector('div[role="dialog"][aria-modal="true"]') ??
    (matchMedia('(max-width:700px)').matches && document.querySelector('.sidebar.open'));
  async function poll() {
    if (document.hidden || busy || polling) return;
    polling = true;
    try {
      const response = await fetch('/api/extensions/connections', { cache: 'no-store' });
      if (!response.ok) return;
      const data = record(await responseJson(response));
      if (isBusy()) return;
      const pending = Array.isArray(data['pending']) ? data['pending'].map(connectionRequest) : [];
      if (dismissed && !pending.some((request) => request.requestId === dismissed))
        dismissed = null;
      if (current && !pending.some((request) => request.requestId === current?.requestId)) {
        invalidate();
        // A later poll presents the next request as a separate focus transition.
        setTimeout(() => {
          void poll();
        }, 100);
        return;
      }
      if (current && (customLayerOpen() || dialog.inert)) {
        invalidate();
        return;
      }
      if (current || customLayerOpen() || dialog.inert) return;
      const request = pending.find((item) => item.requestId !== dismissed);
      if (!request) return;
      current = request;
      const name = dialog.querySelector<HTMLElement>('#extension-approval-name');
      if (name) name.textContent = request.name || 'Browser';
      const origin = dialog.querySelector<HTMLElement>('#extension-approval-origin');
      if (origin) origin.textContent = request.origin || '';
      const error = dialog.querySelector<HTMLElement>('#extension-approval-error');
      if (error) error.hidden = true;
      buttons.forEach((button) => {
        button.disabled = false;
      });
      dialog.showModal();
      buttons[0]?.focus();
    } catch {
      if (current && !dialog.open) invalidate();
      /* Retry when Echo is available. */
    } finally {
      polling = false;
    }
  }
  dialog.addEventListener('cancel', () => {
    dismissed = current?.requestId;
    invalidate();
  });
  dialog.addEventListener('click', (event) => {
    void decide(event);
  });
  async function decide(event: MouseEvent) {
    const action =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-action]')?.dataset['action']
        : undefined;
    if (!action || !current || busy) return;
    const requestId = current.requestId;
    busy = true;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const response = await fetch(
        `/api/extensions/requests/${encodeURIComponent(requestId)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) throw new Error('Could not finish this request. Check Echo and try again.');
      if (action === 'approve')
        void extensionMessage({ type: 'ECHO_APPROVED', requestId }).catch(() => {
          /* The extension also polls for completed approvals. */
        });
      dismissed = requestId;
      invalidate();
    } catch (error) {
      const message = dialog.querySelector<HTMLElement>('#extension-approval-error');
      if (!message) return;
      message.textContent = errorInfo(error).message ?? '';
      message.hidden = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
    } finally {
      busy = false;
      void poll();
    }
  }
  let hadCustomLayer = Boolean(customLayerOpen());
  new MutationObserver(() => {
    const hasCustomLayer = Boolean(customLayerOpen());
    if (hasCustomLayer === hadCustomLayer) return;
    hadCustomLayer = hasCustomLayer;
    if (hasCustomLayer && current && !busy) invalidate();
    if (!hasCustomLayer)
      setTimeout(() => {
        void poll();
      }, 0);
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-modal', 'role'],
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll();
  });
  setInterval(() => {
    void poll();
  }, 3000);
  void poll();
}
