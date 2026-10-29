// Messages from Echo pages (manifest externally_connectable: localhost and 127.0.0.1).
import { endpointURL } from './core';
import { probe } from './discovery';
import { beginPairing, resumePairing } from './pairing';
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
  await chrome.storage.local.set({ echoOrigin: origin });
  const version = chrome.runtime.getManifest().version;
  if (message.type === 'ECHO_PRESENT')
    return { installed: true, version, ...(await connectionStatus()) };
  if (message.type === 'ECHO_APPROVED') await resumePairing(message.requestId);
  else await beginPairing(origin, message.intent);
  const status = await connectionStatus();
  return { ok: status.status === 'connected', ...status };
}
