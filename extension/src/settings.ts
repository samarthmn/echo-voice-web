import {Settings, endpointURL} from './core';
declare const chrome: any;
export async function settings(): Promise<Settings> {
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const stored = (await chrome.storage.local.get('settings')).settings;
  if(stored) return stored;
  const initial: Settings = {installationId:crypto.randomUUID(),endpoint:'http://localhost:3000',activeLibraryId:null,pairs:{},enabledProviders:[],micGranted:false,micDeviceId:'default'};
  await chrome.storage.local.set({settings:initial}); return initial;
}
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await settings(); if(patch.endpoint) patch.endpoint = endpointURL(patch.endpoint);
  const next = {...current,...patch}; await chrome.storage.local.set({settings:next}); return next;
}
