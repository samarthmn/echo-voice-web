import { readMeta, writeMeta, storageLock } from './vault-db';
import { Ciphertext, encryptPayload, decryptPayload } from './vault-crypto';
let deviceKey: Promise<CryptoKey> | undefined;
async function key(): Promise<CryptoKey> {
  return (deviceKey ??= storageLock('device-key', async () => {
    let saved = await readMeta<CryptoKey>('credential-device-key');
    if (!saved) {
      saved = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await writeMeta('credential-device-key', saved);
    }
    if (saved.extractable || saved.type !== 'secret' || saved.algorithm.name !== 'AES-GCM')
      throw new Error('The browser credential key is unavailable.');
    return saved;
  }).catch((error) => {
    deviceKey = undefined;
    throw error;
  }));
}
export async function sealSecret(value: unknown, purpose: string): Promise<Ciphertext> {
  return encryptPayload(await key(), new TextEncoder().encode(JSON.stringify(value)), [
    'device-secret',
    purpose,
  ]);
}
export async function openSecret<T>(value: Ciphertext, purpose: string): Promise<T> {
  const bytes = await decryptPayload(await key(), value, ['device-secret', purpose]);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
