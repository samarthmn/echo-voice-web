import {Settings, endpointURL} from './core';
declare const chrome: any;
// All callers run in the service worker. Serialize initialization and writes so
// concurrent setup actions cannot replace one another's preferences.
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}
async function readSettings(): Promise<Settings> {
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const stored = (await chrome.storage.local.get('settings')).settings;
  if(stored) return stored;
  const initial: Settings = {installationId:crypto.randomUUID(),endpoint:'http://localhost:3000',activeLibraryId:null,pairs:{},enabledProviders:[],micGranted:false,micDeviceId:'default'};
  await chrome.storage.local.set({settings:initial}); return initial;
}
export function settings(): Promise<Settings> {return serialized(readSettings);}
export function saveSettings(update: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<Settings> {
  return serialized(async () => {
    const current = await readSettings();
    const patch = typeof update === 'function' ? update(current) : update;
    const next = {...current,...patch};
    if(patch.endpoint) next.endpoint = endpointURL(patch.endpoint);
    await chrome.storage.local.set({settings:next}); return next;
  });
}
