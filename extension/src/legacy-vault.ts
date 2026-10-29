// MIGRATION ONLY. Reads the former recovery-phrase vault (storage v2) so its recordings can
// be rewrapped with the device key; never creates a vault. Delete once no v2 rows remain.
import { aad, decode, decryptPayload, Binding, Ciphertext } from './encryption';
import { readMeta, writeMeta } from './vault-db';
import { connectedPair } from './settings';
import { jsonRequest } from './protocol';
const encoder = new TextEncoder();
const curve = { name: 'ECDH', namedCurve: 'P-256' };
type VaultDescriptor = { version: 1; vaultId: string; publicKey: string; recovery: Ciphertext };
export type RecordingEnvelope = {
  version: 1;
  vaultId: string;
  ephemeralPublicKey: string;
  wrappedKey: Ciphertext;
};
function validateDescriptor(value: VaultDescriptor): void {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.vaultId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.vaultId) ||
    decode(value.publicKey, 65).length !== 65
  )
    throw new Error('Unsupported recording vault.');
}
async function hkdf(secret: Uint8Array<ArrayBuffer>, binding: Binding): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('Echo recording vault v1'),
      info: aad(binding),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function sharedKey(
  privateKey: CryptoKey,
  publicKey: string,
  binding: Binding,
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', decode(publicKey, 65), curve, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256),
  );
  try {
    return await hkdf(secret, binding);
  } finally {
    secret.fill(0);
  }
}
async function importPrivateIdentity(
  descriptor: VaultDescriptor,
  privateMaterial: string,
): Promise<CryptoKey> {
  validateDescriptor(descriptor);
  const bytes = decode(privateMaterial, 256);
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', bytes, curve, false, ['deriveBits']);
    // Verify that an authorized server returned this vault's identity, not a
    // stale or different library key. No private key is made extractable.
    const check = (await crypto.subtle.generateKey(curve, false, ['deriveBits'])) as CryptoKeyPair;
    const publicKey = await crypto.subtle.importKey(
      'raw',
      decode(descriptor.publicKey, 65),
      curve,
      false,
      [],
    );
    const left = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: check.publicKey }, privateKey, 256),
    );
    const right = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, check.privateKey, 256),
    );
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    left.fill(0);
    right.fill(0);
    if (difference) throw new Error('The unlock key belongs to a different recording vault.');
    return privateKey;
  } finally {
    bytes.fill(0);
  }
}
async function openRecordingKey(
  descriptor: VaultDescriptor,
  privateKey: CryptoKey,
  recordingId: string,
  envelope: RecordingEnvelope,
): Promise<Uint8Array<ArrayBuffer>> {
  validateDescriptor(descriptor);
  if (!privateKey || !envelope || envelope.version !== 1 || envelope.vaultId !== descriptor.vaultId)
    throw new Error('Unlock this recording vault before opening audio.');
  const binding = [
    'recording-key',
    descriptor.vaultId,
    recordingId,
    envelope.ephemeralPublicKey,
  ] as const;
  const wrappingKey = await sharedKey(privateKey, envelope.ephemeralPublicKey, binding);
  const bytes = await decryptPayload(wrappingKey, envelope.wrappedKey, binding);
  try {
    if (bytes.length !== 32) throw new Error('Invalid recording key.');
    return new Uint8Array(bytes);
  } finally {
    bytes.fill(0);
  }
}

// Imported identities live in memory only, like the former session unlock.
const identities = new Map<string, Promise<CryptoKey>>();
async function escrowedIdentity(descriptor: VaultDescriptor): Promise<string> {
  const saved = (await chrome.storage.session.get('recordingVaultIdentity'))
    .recordingVaultIdentity as { vaultId: string; privateMaterial: string } | undefined;
  if (saved?.vaultId === descriptor.vaultId) return saved.privateMaterial;
  const pair = await connectedPair();
  if (!pair) throw new Error('Connect to Echo to unlock older recordings.');
  const body = await jsonRequest(
    pair.endpoint,
    `/vault?vaultId=${encodeURIComponent(descriptor.vaultId)}`,
    {},
    pair.credential,
  );
  if (
    body.vaultId !== descriptor.vaultId ||
    body.libraryId !== pair.libraryId ||
    typeof body.privateMaterial !== 'string'
  )
    throw new Error('Echo returned an invalid identity for older recordings.');
  return body.privateMaterial;
}
function identity(descriptor: VaultDescriptor): Promise<CryptoKey> {
  let key = identities.get(descriptor.vaultId);
  if (!key) {
    key = escrowedIdentity(descriptor).then((material) =>
      importPrivateIdentity(descriptor, material),
    );
    // A failed unlock is retried on the next migration pass.
    key.catch(() => identities.delete(descriptor.vaultId));
    identities.set(descriptor.vaultId, key);
  }
  return key;
}
/** Recover a v2 recording's raw 32-byte key from the vault identity. Caller zeroes it. */
export async function legacyRecordingKey(
  recordingId: string,
  envelope: RecordingEnvelope,
): Promise<Uint8Array<ArrayBuffer>> {
  const descriptor = await readMeta<VaultDescriptor>('recording-vault');
  if (!descriptor || descriptor.vaultId !== envelope.vaultId)
    throw new Error('Older recording is locked.');
  return openRecordingKey(descriptor, await identity(descriptor), recordingId, envelope);
}
export async function clearLegacyVault(): Promise<void> {
  identities.clear();
  await chrome.storage.session.remove([
    'recordingVaultIdentity',
    'recordingVaultGeneration',
    'pendingRecordingVault',
  ]);
  await writeMeta('recording-vault', null);
}
