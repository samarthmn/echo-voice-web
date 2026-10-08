// Shared across the service worker and offscreen document. A queued transfer
// must re-read its journal row inside this lock before using any saved snapshot.
export function withRecordingLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if(!globalThis.navigator?.locks) throw new Error('This browser cannot safely coordinate local recording changes.');
  return navigator.locks.request(`echo-recording:${id}`,{mode:'exclusive'},work);
}
