import { Settings, Pair, endpointURL } from './core';
import { sealSecret, openSecret } from './device-secrets';
import type { Ciphertext } from './encryption';
export type Link =
  | { state: 'none' }
  | {
      state: 'waiting';
      endpoint: string;
      requestId: string;
      claimSecret: string;
      expiresAt: number;
    }
  | ({ state: 'connected' } & Pair);
type StoredSettings = Partial<Settings> & {
  // Pairing v1 fields, read once during migration.
  encryptedPairs?: Ciphertext;
  pairs?: Record<string, Pair>;
  activeLibraryId?: string | null;
};
const SETTINGS_KEYS = ['installationId', 'enabledProviders', 'micGranted', 'micDeviceId'];
const OBSOLETE_KEYS = ['pairingAttempt', 'pairingCancellation'];
// Only the service worker and trusted extension pages reach chrome.storage. Serialize
// initialization and writes so concurrent setup actions cannot replace one another.
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}
async function legacyLink(old: StoredSettings): Promise<Link> {
  try {
    const pairs = old.encryptedPairs
      ? await openSecret<Record<string, Pair>>(old.encryptedPairs, 'settings-pairs')
      : old.pairs;
    const pair = old.activeLibraryId ? pairs?.[old.activeLibraryId] : undefined;
    if (!pair) return { state: 'none' };
    return { state: 'connected', ...pair, endpoint: endpointURL(pair.endpoint) };
  } catch (error) {
    console.error('Echo: the previous connection could not be migrated. Connect again.', error);
    return { state: 'none' };
  }
}
async function readSettings(): Promise<Settings> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['settings', 'link']);
  const old = (saved.settings ?? {}) as StoredSettings;
  const prefs: Settings = {
    installationId: old.installationId ?? crypto.randomUUID(),
    enabledProviders: old.enabledProviders ?? [],
    micGranted: old.micGranted ?? false,
    micDeviceId: old.micDeviceId ?? 'default',
  };
  if (
    saved.link &&
    old.installationId &&
    Object.keys(old).every((key) => SETTINGS_KEYS.includes(key))
  )
    return prefs;
  if (!saved.link)
    await chrome.storage.local.set({ link: await sealSecret(await legacyLink(old), 'link') });
  // Rewrite, rather than spread, so pairing v1 credentials and journals vanish.
  await chrome.storage.local.set({ settings: prefs });
  await chrome.storage.local.remove(OBSOLETE_KEYS);
  return prefs;
}
export function settings(): Promise<Settings> {
  return serialized(readSettings);
}
export function saveSettings(
  update: Partial<Settings> | ((current: Settings) => Partial<Settings>),
): Promise<Settings> {
  return serialized(async () => {
    const current = await readSettings();
    const next = { ...current, ...(typeof update === 'function' ? update(current) : update) };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
}
// The offscreen document has no chrome.storage; it asks the service worker.
async function trusted<T>(message: { type: string } & Record<string, unknown>): Promise<T> {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error ?? 'The Echo connection is unavailable.');
  return reply.value;
}
export function readLink(): Promise<Link> {
  if (!chrome.storage?.local) return trusted<Link>({ type: 'TRUSTED_LINK' });
  return serialized(async () => {
    await readSettings();
    return openSecret<Link>((await chrome.storage.local.get('link')).link as Ciphertext, 'link');
  });
}
export function saveLink(link: Link): Promise<void> {
  return serialized(async () => {
    if (link.state !== 'none') endpointURL(link.endpoint);
    await chrome.storage.local.set({ link: await sealSecret(link, 'link'), revoked: false });
  });
}
/** Echo answered 401 for this credential: forget it, keep every recording. */
export function revokeCredential(credential: string, endpoint: string): Promise<void> {
  if (!chrome.storage?.local)
    return trusted<void>({ type: 'TRUSTED_REVOKE', credential, endpoint });
  return serialized(async () => {
    const saved = (await chrome.storage.local.get('link')).link as Ciphertext | undefined;
    if (!saved) return;
    const link = await openSecret<Link>(saved, 'link');
    if (link.state === 'connected' && link.credential === credential && link.endpoint === endpoint)
      await chrome.storage.local.set({
        link: await sealSecret({ state: 'none' }, 'link'),
        revoked: true,
      });
  });
}
export async function wasRevoked(): Promise<boolean> {
  return (await chrome.storage.local.get('revoked')).revoked === true;
}
export async function connectedPair(): Promise<Pair | undefined> {
  const link = await readLink();
  return link.state === 'connected'
    ? { endpoint: link.endpoint, libraryId: link.libraryId, credential: link.credential }
    : undefined;
}
