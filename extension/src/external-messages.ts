// Messages from Echo pages (manifest externally_connectable: localhost and 127.0.0.1).
import { endpointURL } from './core';
import { probe } from './discovery';
import { resumePairing } from './pairing';
import { connectionStatus } from './connection';
type EchoMessage =
  | { type: 'ECHO_PRESENT' }
  | { type: 'ECHO_APPROVED'; requestId: string }
  | { type: 'ECHO_CONNECT'; intent: string };
function parse(message: unknown): EchoMessage {
  const value = (message ?? {}) as Record<string, unknown>;
  if (value.type === 'ECHO_PRESENT') return { type: 'ECHO_PRESENT' };
  if (value.type === 'ECHO_APPROVED' && typeof value.requestId === 'string')
    return { type: 'ECHO_APPROVED', requestId: value.requestId };
  if (
    value.type === 'ECHO_CONNECT' &&
    typeof value.intent === 'string' &&
    /^[0-9a-f]{64}$/.test(value.intent)
  )
    return { type: 'ECHO_CONNECT', intent: value.intent };
  throw new Error('Unsupported Echo message.');
}
/** Trust only a loopback web page whose origin itself answers as Echo. */
async function verifiedOrigin(sender: chrome.runtime.MessageSender): Promise<string> {
  let origin: string;
  try {
    origin = endpointURL(sender.origin ?? '');
  } catch {
    throw new Error('Unverified Echo origin.');
  }
  if (sender.id || !(await probe(origin))) throw new Error('Unverified Echo origin.');
  return origin;
}
export async function externalMessage(raw: unknown, sender: chrome.runtime.MessageSender) {
  const message = parse(raw);
  const origin = await verifiedOrigin(sender);
  if (message.type === 'ECHO_CONNECT') {
    await chrome.storage.session.set({
      connectRequest: {
        id: crypto.randomUUID(),
        endpoint: origin,
        intent: message.intent,
        receivedAt: Date.now(),
      },
    });
    const url = chrome.runtime.getURL('setup.html');
    const tab = (await chrome.tabs.query({ url })).find(
      (item) => item.url?.split(/[?#]/)[0] === url,
    );
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } else await chrome.tabs.create({ url });
    return { ok: true, status: 'confirm-in-extension' };
  }
  await chrome.storage.local.set({ echoOrigin: origin });
  const version = chrome.runtime.getManifest().version;
  if (message.type === 'ECHO_PRESENT')
    return { installed: true, version, ...(await connectionStatus()) };
  if (message.type === 'ECHO_APPROVED') await resumePairing(message.requestId);
  const status = await connectionStatus();
  return { ok: status.status === 'connected', ...status };
}
