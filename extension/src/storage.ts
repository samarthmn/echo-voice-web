import {Chunk, Recording, MAX_FRAMES, MAX_PENDING_BYTES, PART_FRAMES, sha256, wavHeader, interruption} from './core';
const DB = 'echo-meeting-journal';
let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('recordings', {keyPath: 'recordingId'});
      const chunks = db.createObjectStore('chunks', {keyPath: ['recordingId','sequence']}); chunks.createIndex('recording', 'recordingId');
      db.createObjectStore('meta', {keyPath: 'key'});
    };
    request.onsuccess = () => {request.result.onversionchange = () => request.result.close(); resolve(request.result);};
    request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Close other Echo extension pages and try again.'));
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject) => {request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);}); }
function committed(tx: IDBTransaction): Promise<void> {return new Promise((resolve,reject) => {tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Local storage did not commit.'));});}
export async function allRecordings(): Promise<Recording[]> { const db = await database(); return result(db.transaction('recordings').objectStore('recordings').getAll()); }
export async function recording(id: string): Promise<Recording | undefined> { const db = await database(); return result(db.transaction('recordings').objectStore('recordings').get(id)); }
export async function createRecording(value: Recording): Promise<void> {const db = await database(); const tx = db.transaction('recordings','readwrite',{durability:'strict'}); const done = committed(tx); tx.objectStore('recordings').add(value); await done;}
export async function updateRecording(id: string, patch: Partial<Recording>): Promise<Recording> {
  const db = await database(); const tx = db.transaction('recordings','readwrite',{durability:'strict'}); const done = committed(tx);
  const store = tx.objectStore('recordings'); const current = await result(store.get(id));
  if (!current) {tx.abort(); await done.catch(() => {}); throw new Error('Recording not found.');}
  const next = {...current, ...patch}; store.put(next); await done; return next;
}
export async function appendChunk(id: string, sequence: number, pcm: ArrayBuffer): Promise<Chunk> {
  const frames = pcm.byteLength / 2;
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 16000) throw new Error('Invalid audio chunk.');
  const hash = await sha256(pcm); const db = await database();
  const tx = db.transaction(['recordings','chunks','meta'],'readwrite',{durability:'strict'}); const done = committed(tx);
  const store = tx.objectStore('recordings'); const meta = tx.objectStore('meta');
  const [current, pending] = await Promise.all([result<Recording>(store.get(id)), result<any>(meta.get('pendingBytes'))]);
  if (!current || current.chunkCount !== sequence || current.captureState !== 'recording' || current.totalFrames + frames > MAX_FRAMES || (pending?.value ?? 0) + pcm.byteLength > MAX_PENDING_BYTES) {
    tx.abort(); await done.catch(() => {}); throw new Error('Recording limit reached or local journal is out of sequence. Your saved audio is retained.');
  }
  const chunk = {recordingId:id, sequence, frames, sha256:hash, pcm};
  tx.objectStore('chunks').add(chunk); store.put({...current, chunkCount:sequence + 1, totalFrames:current.totalFrames + frames});
  meta.put({key:'pendingBytes',value:(pending?.value ?? 0) + pcm.byteLength}); await done; return chunk;
}
export async function getChunk(id: string, sequence: number): Promise<Chunk | undefined> {const db = await database(); return result(db.transaction('chunks').objectStore('chunks').get([id,sequence]));}
export async function markInterrupted(): Promise<void> {
  for (const row of await allRecordings()) if (row.captureState === 'recording' || row.captureState === 'paused') await updateRecording(row.recordingId,{captureState:'interrupted',interrupted:true,interruption:row.interruption ?? interruption('recorder-recovered',row.totalFrames),transferState:'saved-local',error:'Recording was interrupted. The committed local audio is safe; recording will not restart automatically.'});
}
export async function retainReceiptAndRemovePCM(id: string, receipt: NonNullable<Recording['receipt']>): Promise<void> {
  const db = await database(); const tx = db.transaction(['recordings','chunks','meta'],'readwrite',{durability:'strict'}); const done = committed(tx);
  const store = tx.objectStore('recordings'); const chunks = tx.objectStore('chunks'); const meta = tx.objectStore('meta');
  const [row,pending] = await Promise.all([result<Recording>(store.get(id)),result<any>(meta.get('pendingBytes'))]);
  if (!row || row.libraryId !== receipt.libraryId || !['stopped','interrupted'].includes(row.captureState)) {tx.abort(); await done.catch(() => {}); throw new Error('Completion receipt does not match the local recording.');}
  chunks.index('recording').openCursor(IDBKeyRange.only(id)).onsuccess = event => {const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result; if(cursor){cursor.delete(); cursor.continue();}};
  meta.put({key:'pendingBytes',value:Math.max(0,(pending?.value ?? 0) - row.totalFrames * 2)});
  store.put({...row,transferState:'saved-echo',receipt,error:undefined}); await done;
}
export async function* exportParts(id: string): AsyncGenerator<{blob: Blob; part: number; startFrame: number; frames: number}> {
  const row = await recording(id); if(!row) throw new Error('Recording not found.');
  if(row.transferState === 'saved-echo') throw new Error('This recording is saved in Echo. Export its audio there.');
  let pieces: BlobPart[] = []; let frames = 0; let part = 1; let startFrame = 0;
  for(let sequence = 0; sequence < row.chunkCount; sequence++) {
    const chunk = await getChunk(id,sequence); if(!chunk) throw new Error('The local recording has a missing chunk.');
    if(await sha256(chunk.pcm) !== chunk.sha256) throw new Error('The local recording failed its audio integrity check.');
    let offset = 0;
    while(offset < chunk.frames) {
      const count = Math.min(PART_FRAMES - frames,chunk.frames - offset); pieces.push(chunk.pcm.slice(offset * 2,(offset + count) * 2)); frames += count; offset += count;
      if(frames === PART_FRAMES) {yield {blob:new Blob([wavHeader(frames),...pieces],{type:'audio/wav'}),part,startFrame,frames}; startFrame += frames; part++; frames = 0; pieces = [];}
    }
  }
  if(frames) yield {blob:new Blob([wavHeader(frames),...pieces],{type:'audio/wav'}),part,startFrame,frames};
}
