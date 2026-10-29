import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// Versioned WebCrypto envelopes. This module never persists keys or phrases.
// A public identity permits new offline recordings without unlocking old ones.
export type Ciphertext = { version: 1; nonce: string; ciphertext: string };
export type VaultDescriptor = {
  version: 1;
  vaultId: string;
  publicKey: string;
  recovery: Ciphertext;
};
export type RecordingEnvelope = {
  version: 1;
  vaultId: string;
  ephemeralPublicKey: string;
  wrappedKey: Ciphertext;
};
type Binding = ReadonlyArray<string | number>;
const LIMIT = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const curve = { name: 'ECDH', namedCurve: 'P-256' };

function base64(value: ArrayBuffer | Uint8Array): string {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  let text = '';
  for (let offset = 0; offset < data.length; offset += 8192)
    text += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(text);
}
function decode(value: unknown, max = LIMIT + 16): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('Invalid encrypted data.');
  const raw = atob(value);
  if (raw.length > max) throw new Error('Encrypted data exceeds its size limit.');
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
function aad(binding: Binding): Uint8Array {
  if (
    !Array.isArray(binding) ||
    binding.length > 12 ||
    binding.some((value) =>
      typeof value === 'string'
        ? value.length > 256
        : typeof value !== 'number' || !Number.isSafeInteger(value),
    )
  )
    throw new Error('Invalid encryption context.');
  return encoder.encode(JSON.stringify(['echo-vault', 1, ...binding]));
}
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
async function hkdf(secret: Uint8Array, binding: Binding): Promise<CryptoKey> {
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
export async function encryptPayload(
  key: CryptoKey,
  plaintext: Uint8Array,
  binding: Binding,
): Promise<Ciphertext> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > LIMIT)
    throw new Error('Recording data exceeds its size limit.');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(binding), tagLength: 128 },
    key,
    plaintext,
  );
  return { version: 1, nonce: base64(nonce), ciphertext: base64(ciphertext) };
}
export async function decryptPayload(
  key: CryptoKey,
  value: Ciphertext,
  binding: Binding,
): Promise<Uint8Array> {
  if (!value || value.version !== 1) throw new Error('Unsupported encrypted recording version.');
  const nonce = decode(value.nonce, 12);
  const ciphertext = decode(value.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16)
    throw new Error('Invalid encrypted recording.');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad(binding), tagLength: 128 },
      key,
      ciphertext,
    ),
  );
}
async function recoveryKey(phrase: string, vaultId: string): Promise<CryptoKey> {
  if (typeof phrase !== 'string' || phrase.length > 1024)
    throw new Error('Check your recovery phrase.');
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalized.split(' ').length !== 24) throw new Error('Enter all 24 recovery words.');
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new Error('Check your recovery phrase.');
  }
  try {
    return await hkdf(entropy, ['recovery', vaultId]);
  } finally {
    entropy.fill(0);
  }
}
export async function createVault(): Promise<{
  descriptor: VaultDescriptor;
  phrase: string;
  privateKey: CryptoKey;
  privateMaterial: string;
}> {
  const pair = (await crypto.subtle.generateKey(curve, true, ['deriveBits'])) as CryptoKeyPair;
  const vaultId = crypto.randomUUID();
  const publicKey = base64(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const phrase = generateMnemonic(wordlist, 256);
  try {
    const wrappingKey = await recoveryKey(phrase, vaultId);
    const recovery = await encryptPayload(wrappingKey, privateBytes, [
      'private-identity',
      vaultId,
      publicKey,
    ]);
    const privateKey = await crypto.subtle.importKey('pkcs8', privateBytes, curve, false, [
      'deriveBits',
    ]);
    return {
      descriptor: { version: 1, vaultId, publicKey, recovery },
      phrase,
      privateKey,
      privateMaterial: base64(privateBytes),
    };
  } finally {
    privateBytes.fill(0);
  }
}
export async function importPrivateIdentity(
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
export async function recoverIdentity(
  descriptor: VaultDescriptor,
  phrase: string,
): Promise<{ privateKey: CryptoKey; privateMaterial: string }> {
  validateDescriptor(descriptor);
  let bytes: Uint8Array | undefined;
  try {
    const wrappingKey = await recoveryKey(phrase, descriptor.vaultId);
    bytes = await decryptPayload(wrappingKey, descriptor.recovery, [
      'private-identity',
      descriptor.vaultId,
      descriptor.publicKey,
    ]);
    const privateMaterial = base64(bytes);
    return {
      privateKey: await importPrivateIdentity(descriptor, privateMaterial),
      privateMaterial,
    };
  } catch {
    throw new Error(
      'Could not unlock this recording vault. Check the recovery phrase; your saved audio has not changed.',
    );
  } finally {
    bytes?.fill(0);
  }
}
export async function unlockRecovery(
  descriptor: VaultDescriptor,
  phrase: string,
): Promise<CryptoKey> {
  return (await recoverIdentity(descriptor, phrase)).privateKey;
}
export async function createRecordingKey(
  descriptor: VaultDescriptor,
  recordingId: string,
): Promise<{ key: CryptoKey; envelope: RecordingEnvelope }> {
  validateDescriptor(descriptor);
  const ephemeral = (await crypto.subtle.generateKey(curve, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ephemeralPublicKey = base64(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const binding = ['recording-key', descriptor.vaultId, recordingId, ephemeralPublicKey] as const;
  const wrappingKey = await sharedKey(ephemeral.privateKey, descriptor.publicKey, binding);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrappedKey = await encryptPayload(wrappingKey, bytes, binding);
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    return {
      key,
      envelope: { version: 1, vaultId: descriptor.vaultId, ephemeralPublicKey, wrappedKey },
    };
  } finally {
    bytes.fill(0);
  }
}
export async function openRecordingKey(
  descriptor: VaultDescriptor,
  privateKey: CryptoKey,
  recordingId: string,
  envelope: RecordingEnvelope,
): Promise<CryptoKey> {
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
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}
