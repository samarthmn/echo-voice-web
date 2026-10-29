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
import { database, result, committed, storageLock } from './vault-db';
import {
  Ciphertext,
  RecordingEnvelope,
  createRecordingKey,
  openRecordingKey,
  encryptPayload,
  decryptPayload,
} from './vault-crypto';
import { vaultDescriptor, privateIdentity, VaultLockedError } from './vault-manager';
export { database } from './vault-db';
type Summary = Pick<
  Recording,
  | 'recordingId'
  | 'libraryId'
  | 'chunkCount'
  | 'totalFrames'
  | 'captureState'
  | 'transferState'
  | 'interrupted'
  | 'receipt'
>;
type Stored = Summary & {
  version: 2;
  envelope: RecordingEnvelope;
  metadata: Ciphertext;
  migrating?: boolean;
};
type StoredChunk = {
  recordingId: string;
  sequence: number;
  frames: number;
  version: 2;
  encrypted: Ciphertext;
};
const summaryKeys = [
  'recordingId',
  'libraryId',
  'chunkCount',
  'totalFrames',
  'captureState',
  'transferState',
  'interrupted',
  'receipt',
] as const;
const activeKeys = new Map<string, CryptoKey>();
function summary(row: Recording | Stored): Summary {
  const value = Object.fromEntries(
    summaryKeys.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]),
  ) as Summary;
  if (value.receipt)
    value.receipt = {
      libraryId: value.receipt.libraryId,
      meetingId: value.receipt.meetingId,
      verifiedAt: '',
    };
  return value;
}
function isProtected(row: any): row is Stored {
  return row?.version === 2 && !!row.envelope && !!row.metadata;
}
async function rawRecording(id: string): Promise<Stored | Recording | undefined> {
  const db = await database();
  return result(db.transaction('recordings').objectStore('recordings').get(id));
}
async function rawChunk(id: string, sequence: number): Promise<StoredChunk | Chunk | undefined> {
  const db = await database();
  return result(db.transaction('chunks').objectStore('chunks').get([id, sequence]));
}
async function rowKey(row: Stored): Promise<CryptoKey> {
  const active = activeKeys.get(row.recordingId);
  if (active && ['recording', 'paused'].includes(row.captureState)) return active;
  const descriptor = await vaultDescriptor();
  if (!descriptor) throw new VaultLockedError();
  return openRecordingKey(
    descriptor,
    await privateIdentity(descriptor),
    row.recordingId,
    row.envelope,
  );
}
async function encode(
  row: Recording,
  key: CryptoKey,
  envelope: RecordingEnvelope,
): Promise<Stored> {
  const { locked, protectionError, ...metadata } = row;
  return {
    ...summary(row),
    version: 2,
    envelope,
    metadata: await encryptPayload(key, new TextEncoder().encode(JSON.stringify(metadata)), [
      'metadata',
      envelope.vaultId,
      row.recordingId,
    ]),
  };
}
async function decode(row: Stored): Promise<Recording> {
  const bytes = await decryptPayload(await rowKey(row), row.metadata, [
    'metadata',
    row.envelope.vaultId,
    row.recordingId,
  ]);
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const receiptMatches =
      (!body.receipt && !row.receipt) ||
      (!!body.receipt &&
        !!row.receipt &&
        body.receipt.libraryId === row.receipt.libraryId &&
        body.receipt.meetingId === row.receipt.meetingId);
    if (
      body.recordingId !== row.recordingId ||
      body.chunkCount !== row.chunkCount ||
      body.totalFrames !== row.totalFrames ||
      body.libraryId !== row.libraryId ||
      !receiptMatches
    )
      throw new Error('Recording metadata integrity check failed. Your audio is retained.');
    // Only recovery's operational state may differ while history is locked.
    // Ownership, receipts, counts and all identifying metadata are authenticated.
    return {
      ...body,
      captureState: row.captureState,
      transferState: row.transferState,
      interrupted: row.interrupted,
      ...(body.receipt ? { error: undefined } : {}),
    };
  } finally {
    bytes.fill(0);
  }
}
function lockedRow(row: Stored | Recording, error?: unknown): Recording {
  return {
    recordingId: row.recordingId,
    title: 'Locked recording',
    provider: 'meet',
    meetingUrl: '',
    consent: true,
    liveTranscription: false,
    sampleRate: 16000,
    channels: 1,
    createdAt: '',
    gaps: [],
    ...summary(row),
    locked: true,
    protectionError:
      error instanceof VaultLockedError
        ? undefined
        : 'Recording protection needs attention. Your committed audio is retained.',
  };
}
export async function allRecordings(): Promise<Recording[]> {
  const db = await database();
  const rows = await result<(Stored | Recording)[]>(
    db.transaction('recordings').objectStore('recordings').getAll(),
  );
  return Promise.all(
    rows.map(async (row) => {
      if (!isProtected(row) || row.migrating) return lockedRow(row);
      try {
        return await decode(row);
      } catch (error) {
        return lockedRow(row, error);
      }
    }),
  );
}
export async function recording(id: string): Promise<Recording | undefined> {
  const row = await rawRecording(id);
  if (!row) return;
  if (!isProtected(row) || row.migrating)
    throw new Error('Complete recording protection in Setup before opening existing audio.');
  return decode(row);
}
export async function createRecording(value: Recording): Promise<void> {
  await storageLock(value.recordingId, async () => {
    const descriptor = await vaultDescriptor();
    if (!descriptor) throw new Error('Save your recovery phrase in Setup before recording.');
    const created = await createRecordingKey(descriptor, value.recordingId);
    const stored = await encode(value, created.key, created.envelope);
    const db = await database();
    const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
    const done = committed(tx);
    tx.objectStore('recordings').add(stored);
    await done;
    activeKeys.set(value.recordingId, created.key);
  });
}
export async function updateRecording(id: string, patch: Partial<Recording>): Promise<Recording> {
  return storageLock(id, async () => {
    const current = await rawRecording(id);
    if (!current) throw new Error('Recording not found.');
    if (!isProtected(current)) throw new Error('Complete recording protection in Setup first.');
    if (patch.recordingId !== undefined && patch.recordingId !== id)
      throw new Error('Recording identity cannot change.');
    let stored: Stored;
    let next: Recording;
    try {
      const key = await rowKey(current);
      next = { ...(await decode(current)), ...patch };
      stored = {
        ...(await encode(next, key, current.envelope)),
        ...(current.migrating ? { migrating: true } : {}),
      };
    } catch (error) {
      // Recovery and pairing can update nonidentifying state while history is
      // locked. Sensitive metadata is retained verbatim until a valid unlock.
      if (!(error instanceof VaultLockedError)) throw error;
      if (
        Object.keys(patch).some(
          (field) =>
            !['captureState', 'transferState', 'interrupted', 'interruption', 'error'].includes(
              field,
            ),
        )
      )
        throw error;
      const operational = {
        captureState: patch.captureState ?? current.captureState,
        transferState: patch.transferState ?? current.transferState,
        interrupted: patch.interrupted ?? current.interrupted,
      };
      stored = { ...current, ...operational };
      next = lockedRow(stored);
    }
    const db = await database();
    const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
    const done = committed(tx);
    tx.objectStore('recordings').put(stored);
    await done;
    if (!['recording', 'paused'].includes(next.captureState)) activeKeys.delete(id);
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
    if (!current || !isProtected(current) || current.migrating)
      throw new Error('Recording protection is not ready.');
    const key = await rowKey(current);
    const nextRow = {
      ...(await decode(current)),
      chunkCount: sequence + 1,
      totalFrames: current.totalFrames + frames,
    };
    const nextMetadata = await encode(nextRow, key, current.envelope);
    const hash = await sha256(pcm);
    const encrypted = await encryptPayload(key, new Uint8Array(pcm), [
      'pcm',
      current.envelope.vaultId,
      id,
      sequence,
      frames,
    ]);
    const db = await database();
    const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite', {
      durability: 'strict',
    });
    const done = committed(tx);
    const store = tx.objectStore('recordings');
    const meta = tx.objectStore('meta');
    const [latest, pending] = await Promise.all([
      result<Stored>(store.get(id)),
      result<any>(meta.get('pendingBytes')),
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
    store.put({
      ...nextMetadata,
      chunkCount: sequence + 1,
      totalFrames: latest.totalFrames + frames,
    });
    meta.put({ key: 'pendingBytes', value: (pending?.value ?? 0) + pcm.byteLength });
    await done;
    return { recordingId: id, sequence, frames, sha256: hash, pcm };
  });
}
export async function getChunk(id: string, sequence: number): Promise<Chunk | undefined> {
  const row = await rawRecording(id);
  if (!row) return;
  if (!isProtected(row))
    throw new Error('Complete recording protection in Setup before opening audio.');
  const stored = await rawChunk(id, sequence);
  if (!stored) return;
  if (!('encrypted' in stored))
    throw new Error(
      'This recording needs protection migration in Setup. Its committed audio is retained.',
    );
  const bytes = await decryptPayload(await rowKey(row), stored.encrypted, [
    'pcm',
    row.envelope.vaultId,
    id,
    sequence,
    stored.frames,
  ]);
  if (bytes.byteLength !== stored.frames * 2)
    throw new Error('The encrypted audio length is invalid.');
  const pcm = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return { recordingId: id, sequence, frames: stored.frames, sha256: await sha256(pcm), pcm };
}
export async function markInterrupted(): Promise<void> {
  const db = await database();
  const rows = await result<(Stored | Recording)[]>(
    db.transaction('recordings').objectStore('recordings').getAll(),
  );
  for (const row of rows)
    if (isProtected(row) && ['recording', 'paused'].includes(row.captureState))
      await updateRecording(row.recordingId, {
        captureState: 'interrupted',
        interrupted: true,
        interruption: interruption('recorder-recovered', row.totalFrames),
        transferState: 'saved-local',
        error:
          'Recording was interrupted. Committed audio is retained; recording will not restart automatically.',
      });
}
export async function retainReceiptAndRemovePCM(
  id: string,
  receipt: NonNullable<Recording['receipt']>,
): Promise<void> {
  await storageLock(id, async () => {
    const current = await rawRecording(id);
    if (!current || !isProtected(current)) throw new Error('Recording not found.');
    const completedRow = {
      ...(await decode(current)),
      transferState: 'saved-echo' as const,
      receipt,
      error: undefined,
    };
    const sealed = await encode(completedRow, await rowKey(current), current.envelope);
    const db = await database();
    const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite', {
      durability: 'strict',
    });
    const done = committed(tx);
    const store = tx.objectStore('recordings');
    const chunks = tx.objectStore('chunks');
    const meta = tx.objectStore('meta');
    const [row, pending] = await Promise.all([
      result<Stored>(store.get(id)),
      result<any>(meta.get('pendingBytes')),
    ]);
    if (
      !row ||
      row.libraryId !== receipt.libraryId ||
      !['stopped', 'interrupted'].includes(row.captureState)
    ) {
      tx.abort();
      await done.catch(() => {});
      throw new Error('Completion receipt does not match the local recording.');
    }
    chunks.index('recording').openCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    if (!row.receipt)
      meta.put({
        key: 'pendingBytes',
        value: Math.max(0, (pending?.value ?? 0) - row.totalFrames * 2),
      });
    store.put(sealed);
    await done;
    activeKeys.delete(id);
  });
}
export async function deleteRecording(id: string): Promise<void> {
  await storageLock(id, async () => {
    const db = await database();
    const tx = db.transaction(['recordings', 'chunks', 'meta'], 'readwrite', {
      durability: 'strict',
    });
    const done = committed(tx);
    const store = tx.objectStore('recordings');
    const chunks = tx.objectStore('chunks');
    const meta = tx.objectStore('meta');
    const [row, pending] = await Promise.all([
      result<Stored>(store.get(id)),
      result<any>(meta.get('pendingBytes')),
    ]);
    if (!row) {
      await done;
      return;
    }
    if (!['stopped', 'interrupted'].includes(row.captureState)) {
      tx.abort();
      await done.catch(() => {});
      throw new Error('Stop this recording before deleting its local audio.');
    }
    chunks.index('recording').openCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    if (!row.receipt)
      meta.put({
        key: 'pendingBytes',
        value: Math.max(0, (pending?.value ?? 0) - row.totalFrames * 2),
      });
    store.delete(id);
    await done;
    activeKeys.delete(id);
  });
}
// Migration commits encrypted metadata first, then replaces each verified PCM
// chunk atomically. Interruption leaves originals or encrypted replacements, both
// bound to the same durable envelope; retry resumes without deleting any prefix.
export async function migrateRecordings(): Promise<void> {
  await storageLock('migration', async () => {
    const descriptor = await vaultDescriptor();
    if (!descriptor) return;
    const privateKey = await privateIdentity(descriptor);
    const db = await database();
    const rows = await result<(Stored | Recording)[]>(
      db.transaction('recordings').objectStore('recordings').getAll(),
    );
    for (const initial of rows)
      await storageLock(initial.recordingId, async () => {
        let row = await rawRecording(initial.recordingId);
        if (!row) return;
        if (isProtected(row) && !row.migrating) return;
        let key: CryptoKey;
        if (!isProtected(row)) {
          const created = await createRecordingKey(descriptor, row.recordingId);
          key = created.key;
          const migrated = ['recording', 'paused'].includes(row.captureState)
            ? {
                ...row,
                captureState: 'interrupted' as const,
                interrupted: true,
                interruption:
                  row.interruption ?? interruption('recorder-recovered', row.totalFrames),
              }
            : row;
          const sealed = { ...(await encode(migrated, key, created.envelope)), migrating: true };
          const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
          const done = committed(tx);
          tx.objectStore('recordings').put(sealed);
          await done;
          row = sealed;
        } else key = await openRecordingKey(descriptor, privateKey, row.recordingId, row.envelope);
        for (let sequence = 0; sequence < row.chunkCount && !row.receipt; sequence++) {
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
            row.envelope.vaultId,
            row.recordingId,
            sequence,
            chunk.frames,
          ]);
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
        const tx = db.transaction('recordings', 'readwrite', { durability: 'strict' });
        const done = committed(tx);
        tx.objectStore('recordings').put(finished);
        await done;
      });
  });
}
export async function protectionMigrationPending(): Promise<boolean> {
  const db = await database();
  const rows = await result<any[]>(db.transaction('recordings').objectStore('recordings').getAll());
  return rows.some((row) => !isProtected(row) || row.migrating);
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
