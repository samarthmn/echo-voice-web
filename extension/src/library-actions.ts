import {endpointURL, Recording, Settings} from './core';
import {settings} from './settings';
import {deleteRecording, recording} from './storage';
import {withRecordingLock} from './recording-lock';
declare const chrome: any;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function echoURL(prefs: Settings, row?: Recording): string {
  const libraryId = row?.receipt?.libraryId ?? row?.libraryId ?? prefs.activeLibraryId;
  if(!libraryId || !uuid.test(libraryId)) throw new Error('Connect this recording’s Echo library in Setup before opening it.');
  const pair = prefs.pairs[libraryId];
  if(!pair || pair.libraryId !== libraryId) throw new Error('This recording belongs to a different Echo library. Reconnect that library to open it.');
  const url = new URL(endpointURL(pair.endpoint));
  url.searchParams.set('library',libraryId);
  if(row?.receipt) {
    if(row.libraryId !== libraryId || !uuid.test(row.receipt.meetingId)) throw new Error('This recording has an invalid Echo receipt.');
    url.searchParams.set('meeting',row.receipt.meetingId);
  }
  return url.href;
}
export async function openEcho(id?: string): Promise<void> {
  const row = id ? await recording(id) : undefined;
  if(id && !row) throw new Error('This local recording is no longer available.');
  await chrome.tabs.create({url:echoURL(await settings(),row)});
}
export async function deleteLocalRecording(id: string, confirmed: boolean, activeRecordingId?: string): Promise<void> {
  if(!confirmed) throw new Error('Confirm deletion of this browser’s local recording first.');
  if(!uuid.test(id)) throw new Error('Invalid recording identity.');
  if(id === activeRecordingId) throw new Error('Stop this recording before deleting its local audio.');
  await withRecordingLock(id,() => deleteRecording(id));
}
