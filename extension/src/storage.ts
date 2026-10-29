import {
  Chunk,
  Recording,
  MAX_FRAMES,
  MAX_PENDING_BYTES,
  PART_FRAMES,
  sha256,
  wavHeader,
  interruption,
} from './core';
import { database, result, committed, storageLock, readMeta } from './vault-db';
import { Ciphertext, encryptPayload, decryptPayload } from './encryption';
import { wrapRecordingKey, unwrapRecordingKey } from './device-secrets';
import { RecordingEnvelope, legacyRecordingKey, clearLegacyVault } from './legacy-vault';
import { connectedPair } from './settings';
import { jsonRequest, ProtocolError } from './protocol';
export { database } from './vault-db';
// Storage v3 row: plaintext summary for lists and badges, a per-recording AES key wrapped by
// the device key (AAD ["recording-key", id]), and encrypted metadata. Chunks keep the v2
// format and AAD ["pcm", keyContext, id, sequence, frames]; keyContext is "device" or, for
// rows rewrapped from the former recovery vault, that vault's id.
type Summary = Pick<
  Recording,
  | 'recordingId'
  | 'createdAt'
  | 'provider'
  | 'libraryId'
  | 'chunkCount'
  | 'totalFrames'
  | 'captureState'
  | 'transferState'
  | 'interrupted'
  | 'interruption'
  | 'error'
  | 'receipt'
> & { durationMs: number; bytes: number };
type Stored = Summary & {
  version: 3;
  keyContext: string;
  keyWrap?: Ciphertext;
  metadata?: Ciphertext;
  migrating?: boolean;
  needsUnlock?: boolean;
};
type Legacy = Partial<Summary> & {
  recordingId: string;
  version: 2;
  envelope: RecordingEnvelope;
  metadata: Ciphertext;
  migrating?: boolean;
  needsUnlock?: boolean;
};
type Row = Stored | Legacy | Recording;
type StoredChunk = {
  recordingId: string;
  sequence: number;
  frames: number;
  version: 2;
  encrypted: Ciphertext;
};
const keys = new Map<string, CryptoKey>();
const summaryKeys = [
  'recordingId',
  'createdAt',
  'provider',
  'libraryId',
  'chunkCount',
  'totalFrames',
  'captureState',
  'transferState',
  'interrupted',
  'interruption',
  'error',
  'receipt',
] as const;
// Operational status a locked or migrating row may still record (never meeting details).
const OPERATIONAL_KEYS = ['captureState', 'transferState', 'interrupted', 'interruption', 'error'];
function summary(row: Recording): Summary {
  return {
    ...(Object.fromEntries(summaryKeys.map((key) => [key, row[key]])) as Summary),
    durationMs: row.totalFrames / 16,
    bytes: row.receipt ? 0 : row.totalFrames * 2,
  };
}
function isV3(row: Row): row is Stored {
  return 'version' in row && row.version === 3;
}
function isV2(row: Row): row is Legacy {
  return 'version' in row && row.version === 2;
}
/** List and badge view: plaintext summary fields only; never opens keys or metadata. */
function listed(row: Row): Recording {
  const locked = !row.receipt && (!isV3(row) || !!row.migrating || !!row.needsUnlock);
  return {
    title: '',
    meetingUrl: '',
    consent: true,
    liveTranscription: false,
    sampleRate: 16000,
    channels: 1,
    gaps: [],
    recordingId: row.recordingId,
    receipt: row.receipt,
    createdAt: row.createdAt ?? row.receipt?.verifiedAt ?? '',
    provider: row.provider ?? 'meet',
    libraryId: row.libraryId ?? null,
    chunkCount: row.chunkCount ?? 0,
    totalFrames: row.totalFrames ?? 0,
    captureState: row.captureState ?? 'interrupted',
    transferState: row.transferState ?? 'saved-local',
    interrupted: row.interrupted ?? false,
    interruption: row.interruption,
    error: row.error,
    locked,
    needsUnlock: !!row.needsUnlock,
  };
}
async function rawRecording(id: string): Promise<Row | undefined> {
  const db = await database();
  return result(db.transaction('recordings').objectStore('recordings').get(id));
}
async function rows(): Promise<Row[]> {
  const db = await database();
  return result(db.transaction('recordings').objectStore('recordings').getAll());
}
async function putRow(row: Row): Promise<void> {
  const db = await database();
  const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
  const done = committed(tx);
  tx.objectStore('recordings').put(row);
  await done;
}
async function rawChunk(id: string, sequence: number): Promise<StoredChunk | Chunk | undefined> {
  const db = await database();
  return result(db.transaction('chunks').objectStore('chunks').get([id, sequence]));
}
async function rowKey(row: Stored): Promise<CryptoKey> {
  let key = keys.get(row.recordingId);
  if (!key) {
    if (!row.keyWrap) throw new Error('Recording key is unavailable.');
    key = await unwrapRecordingKey(row.keyWrap, row.recordingId);
    keys.set(row.recordingId, key);
  }
  return key;
}
async function encode(
  row: Recording,
  key: CryptoKey,
  context: string,
  keyWrap: Ciphertext,
): Promise<Stored> {
  const { locked, needsUnlock, ...body } = row;
  return {
    ...summary(row),
    version: 3,
    keyContext: context,
    keyWrap,
    metadata: await encryptPayload(key, new TextEncoder().encode(JSON.stringify(body)), [
      'metadata',
      context,
      row.recordingId,
    ]),
  };
}
async function decode(row: Stored): Promise<Recording> {
  if (row.receipt) return listed(row);
  if (!row.metadata || row.migrating) throw new Error('Older recording migration is incomplete.');
  const bytes = await decryptPayload(await rowKey(row), row.metadata, [
    'metadata',
    row.keyContext,
    row.recordingId,
  ]);
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Recording;
    if (
      body.recordingId !== row.recordingId ||
      body.libraryId !== row.libraryId ||
      body.chunkCount !== row.chunkCount ||
      body.totalFrames !== row.totalFrames ||
      body.receipt
    )
      throw new Error('Recording metadata integrity check failed. Your audio is retained.');
    return {
      ...body,
      captureState: row.captureState,
      transferState: row.transferState,
      interrupted: row.interrupted,
    };
  } finally {
    bytes.fill(0);
  }
}
export async function allRecordings(): Promise<Recording[]> {
  return (await rows()).map(listed);
}
export async function recording(id: string): Promise<Recording | undefined> {
  const row = await rawRecording(id);
  if (!row) return;
  if (row.receipt) return listed(row);
  if (!isV3(row))
    throw new Error(
      isV2(row)
        ? 'Connect to Echo to unlock this older recording.'
        : 'This older recording is still being prepared. Its audio is kept.',
    );
  return decode(row);
}
async function newKey(id: string) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const keyWrap = await wrapRecordingKey(raw, id);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, keyWrap };
  } finally {
    raw.fill(0);
  }
}
export async function createRecording(value: Recording): Promise<void> {
  await storageLock(value.recordingId, async () => {
    const { key, keyWrap } = await newKey(value.recordingId);
    const row = await encode(value, key, 'device', keyWrap);
    const db = await database();
    const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
    const done = committed(tx);
    tx.objectStore('recordings').add(row);
    await done;
    keys.set(value.recordingId, key);
  });
}
export async function updateRecording(id: string, patch: Partial<Recording>): Promise<Recording> {
  return storageLock(id, async () => {
    const current = await rawRecording(id);
    if (!current) throw new Error('Recording not found.');
    if (patch.recordingId !== undefined && patch.recordingId !== id)
      throw new Error('Recording identity cannot change.');
    if (!isV3(current) || current.migrating) {
      if (Object.keys(patch).some((key) => !OPERATIONAL_KEYS.includes(key)))
        throw new Error('Connect to Echo to unlock older recordings.');
      const next = { ...current, ...patch } as Row;
      await putRow(next);
      return listed(next);
    }
    if (!current.keyWrap) throw new Error('Recording is already transferred.');
    const next = { ...(await decode(current)), ...patch };
    await putRow(await encode(next, await rowKey(current), current.keyContext, current.keyWrap));
    return next;
  });
}
export async function appendChunk(id: string, sequence: number, pcm: ArrayBuffer): Promise<Chunk> {
  const frames = pcm.byteLength / 2;
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isSafeInteger(frames) ||
    frames < 1 ||
    frames > 16000
  )
    throw new Error('Invalid audio chunk.');
  return storageLock(id, async () => {
    const current = await rawRecording(id);
    if (!current || !isV3(current) || current.migrating || !current.keyWrap || current.receipt)
      throw new Error('Recording protection is not ready.');
    const key = await rowKey(current);
    const next = await encode(
      {
        ...(await decode(current)),
        chunkCount: sequence + 1,
        totalFrames: current.totalFrames + frames,
      },
      key,
      current.keyContext,
      current.keyWrap,
    );
    const encrypted = await encryptPayload(key, new Uint8Array(pcm), [
      'pcm',
      current.keyContext,
      id,
      sequence,
      frames,
    ]);
    const hash = await sha256(pcm);
    const db = await database();
    const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite', {
      durability: 'strict',
    });
    const done = committed(tx);
    const store = tx.objectStore('recordings');
    const meta = tx.objectStore('meta');
    const [latest, pending] = await Promise.all([
      result<Stored>(store.get(id)),
      result<{ value: number } | undefined>(meta.get('pendingBytes')),
    ]);
    if (
      !latest ||
      latest.chunkCount !== sequence ||
      latest.captureState !== 'recording' ||
      latest.totalFrames + frames > MAX_FRAMES ||
      (pending?.value ?? 0) + pcm.byteLength > MAX_PENDING_BYTES
    ) {
      tx.abort();
      await done.catch(() => {});
      throw new Error(
        'Recording limit reached or local journal is out of sequence. Your saved audio is retained.',
      );
    }
    tx.objectStore('chunks').add({ recordingId: id, sequence, frames, version: 2, encrypted });
    store.put(next);
    meta.put({ key: 'pendingBytes', value: (pending?.value ?? 0) + pcm.byteLength });
    await done;
    return { recordingId: id, sequence, frames, sha256: hash, pcm };
  });
}
export async function getChunk(id: string, sequence: number): Promise<Chunk | undefined> {
  const row = await rawRecording(id);
  if (!row) return;
  if (!isV3(row) || row.migrating) throw new Error('Connect to Echo to unlock older recordings.');
  const chunk = await rawChunk(id, sequence);
  if (!chunk) return;
  if (!('encrypted' in chunk)) throw new Error('Older recording migration is incomplete.');
  const bytes = await decryptPayload(await rowKey(row), chunk.encrypted, [
    'pcm',
    row.keyContext,
    id,
    sequence,
    chunk.frames,
  ]);
  if (bytes.byteLength !== chunk.frames * 2)
    throw new Error('The encrypted audio length is invalid.');
  const pcm = bytes.buffer as ArrayBuffer;
  return { recordingId: id, sequence, frames: chunk.frames, sha256: await sha256(pcm), pcm };
}
export async function markInterrupted(): Promise<void> {
  for (const row of await rows())
    if (['recording', 'paused'].includes(row.captureState ?? ''))
      await updateRecording(row.recordingId, {
        captureState: 'interrupted',
        interrupted: true,
        interruption: interruption('recorder-recovered', row.totalFrames ?? 0),
        transferState: 'saved-local',
        error:
          'Recording was interrupted. Committed audio is retained; recording will not restart automatically.',
      });
}
function removeChunks(store: IDBObjectStore, id: string) {
  store.index('recording').openCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
}
async function removePCM(id: string, receipt?: NonNullable<Recording['receipt']>) {
  const db = await database();
  const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite', {
    durability: 'strict',
  });
  const done = committed(tx);
  const store = tx.objectStore('recordings');
  const meta = tx.objectStore('meta');
  const [row, pending] = await Promise.all([
    result<Row | undefined>(store.get(id)),
    result<{ value: number } | undefined>(meta.get('pendingBytes')),
  ]);
  if (!row) {
    await done;
    return;
  }
  if (
    !['stopped', 'interrupted'].includes(row.captureState ?? '') ||
    (receipt && row.libraryId !== receipt.libraryId)
  ) {
    tx.abort();
    await done.catch(() => {});
    throw new Error(
      receipt
        ? 'Completion receipt does not match the local recording.'
        : 'Stop this recording before deleting its local audio.',
    );
  }
  removeChunks(tx.objectStore('chunks'), id);
  if (!row.receipt)
    meta.put({
      key: 'pendingBytes',
      value: Math.max(0, (pending?.value ?? 0) - (row.totalFrames ?? 0) * 2),
    });
  if (receipt)
    store.put({
      ...summary(listed(row)),
      version: 3,
      keyContext: 'device',
      receipt,
      transferState: 'saved-echo',
      error: undefined,
      bytes: 0,
    });
  else store.delete(id);
  await done;
  keys.delete(id);
}
export async function retainReceiptAndRemovePCM(
  id: string,
  receipt: NonNullable<Recording['receipt']>,
): Promise<void> {
  await storageLock(id, () => removePCM(id, receipt));
}
export async function deleteRecording(id: string): Promise<void> {
  await storageLock(id, () => removePCM(id));
}
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Forget "saved in Echo" receipts a week after Echo verified them; Echo keeps the audio. */
export async function pruneReceipts(now = Date.now()): Promise<void> {
  for (const row of await rows())
    if (
      row.receipt &&
      Date.parse(row.receipt.verifiedAt || row.createdAt || '') < now - RECEIPT_RETENTION_MS
    )
      await deleteRecording(row.recordingId);
}
async function encryptPlaintextChunks(row: Stored, key: CryptoKey): Promise<void> {
  for (let sequence = 0; sequence < row.chunkCount; sequence++) {
    const chunk = await rawChunk(row.recordingId, sequence);
    if (!chunk)
      throw new Error(
        'A committed recording chunk is missing. Migration stopped; saved audio is retained.',
      );
    if ('encrypted' in chunk) continue;
    if ((await sha256(chunk.pcm)) !== chunk.sha256)
      throw new Error(
        'A recording failed its integrity check. Migration stopped; saved audio is retained.',
      );
    const encrypted = await encryptPayload(key, new Uint8Array(chunk.pcm), [
      'pcm',
      row.keyContext,
      row.recordingId,
      sequence,
      chunk.frames,
    ]);
    const db = await database();
    const tx = db.transaction('chunks', 'readwrite', { durability: 'strict' });
    const done = committed(tx);
    tx.objectStore('chunks').put({
      recordingId: row.recordingId,
      sequence,
      frames: chunk.frames,
      version: 2,
      encrypted,
    });
    await done;
  }
  const { migrating, ...finished } = row;
  await putRow(finished);
}
/** Rewrap a v2 (recovery-vault) row's key with the device key. Its ciphertext stays as is. */
async function rewrapLegacyRow(row: Legacy): Promise<{ row: Stored; key: CryptoKey }> {
  const raw = await legacyRecordingKey(row.recordingId, row.envelope);
  let key: CryptoKey;
  let keyWrap: Ciphertext;
  try {
    keyWrap = await wrapRecordingKey(raw, row.recordingId);
    key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
  const bytes = await decryptPayload(key, row.metadata, [
    'metadata',
    row.envelope.vaultId,
    row.recordingId,
  ]);
  let body: Recording;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    bytes.fill(0);
  }
  if (
    body.recordingId !== row.recordingId ||
    body.chunkCount !== row.chunkCount ||
    body.totalFrames !== row.totalFrames ||
    body.libraryId !== row.libraryId
  )
    throw new Error('Older recording metadata failed its integrity check.');
  const operational = {
    captureState: row.captureState ?? body.captureState,
    transferState: row.transferState ?? body.transferState,
    interrupted: row.interrupted ?? body.interrupted,
  };
  const next: Stored = {
    ...summary({ ...body, ...operational }),
    version: 3,
    keyContext: row.envelope.vaultId,
    keyWrap,
    metadata: row.metadata,
    ...(row.migrating ? { migrating: true } : {}),
  };
  await putRow(next);
  return { row: next, key };
}
// Every row and chunk commit is restartable; legacy audio ciphertext and AAD never change.
async function migrateRow(id: string): Promise<void> {
  let row = await rawRecording(id);
  if (!row) return;
  if (row.receipt) {
    if (!isV3(row) || row.metadata)
      await removePCM(id, {
        ...row.receipt,
        verifiedAt: row.receipt.verifiedAt || new Date().toISOString(),
      });
    return;
  }
  if (isV3(row) && !row.migrating) return;
  let key: CryptoKey;
  if (isV2(row)) {
    try {
      ({ row, key } = await rewrapLegacyRow(row));
    } catch (error) {
      console.warn(`Echo: older recording ${id} stays locked until Echo can unlock it.`, error);
      if (!row.needsUnlock) await putRow({ ...row, needsUnlock: true });
      return;
    }
  } else if (!isV3(row)) {
    const created = await newKey(id);
    key = created.key;
    row = { ...(await encode(row, key, 'device', created.keyWrap)), migrating: true };
    await putRow(row);
  } else key = await rowKey(row);
  keys.set(id, key);
  await encryptPlaintextChunks(row, key);
}
/** Once no recovery-vault rows remain, drop the vault and Echo's escrow of it. */
async function retireLegacyVault(): Promise<void> {
  if (!(await readMeta('recording-vault')) || (await rows()).some(isV2)) return;
  const pair = await connectedPair();
  if (!pair) return;
  try {
    await jsonRequest(pair.endpoint, '/vault', { method: 'DELETE' }, pair.credential);
  } catch (error) {
    if (!(error instanceof ProtocolError && error.status === 404)) throw error;
  }
  await clearLegacyVault();
}
/** Idempotent v1/v2 → v3 migration and receipt pruning. Throws the first row failure. */
export async function migrateRecordings(): Promise<void> {
  await storageLock('migration', async () => {
    const failures: unknown[] = [];
    for (const { recordingId } of await rows())
      await storageLock(recordingId, () => migrateRow(recordingId)).catch((error) => {
        console.error(
          `Echo: recording ${recordingId} could not be migrated; its audio is retained.`,
          error,
        );
        failures.push(error);
      });
    await pruneReceipts();
    await retireLegacyVault();
    if (failures.length) throw failures[0];
  });
}
export async function* exportParts(
  id: string,
): AsyncGenerator<{ blob: Blob; part: number; startFrame: number; frames: number }> {
  const row = await recording(id);
  if (!row) throw new Error('Recording not found.');
  if (row.transferState === 'saved-echo')
    throw new Error('This recording is saved in Echo. Export its audio there.');
  let pieces: BlobPart[] = [];
  let frames = 0;
  let part = 1;
  let startFrame = 0;
  for (let sequence = 0; sequence < row.chunkCount; sequence++) {
    const chunk = await getChunk(id, sequence);
    if (!chunk) throw new Error('The local recording has a missing chunk.');
    let offset = 0;
    while (offset < chunk.frames) {
      const count = Math.min(PART_FRAMES - frames, chunk.frames - offset);
      pieces.push(chunk.pcm.slice(offset * 2, (offset + count) * 2));
      frames += count;
      offset += count;
      if (frames === PART_FRAMES) {
        yield {
          blob: new Blob([wavHeader(frames), ...pieces], { type: 'audio/wav' }),
          part,
          startFrame,
          frames,
        };
        startFrame += frames;
        part++;
        frames = 0;
        pieces = [];
      }
    }
  }
  if (frames)
    yield {
      blob: new Blob([wavHeader(frames), ...pieces], { type: 'audio/wav' }),
      part,
      startFrame,
      frames,
    };
}
