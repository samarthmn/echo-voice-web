// Keep this envelope and AAD encoding stable: existing PCM uses it.
export type Ciphertext = { version: 1; nonce: string; ciphertext: string };
export type Binding = ReadonlyArray<string | number>;
const LIMIT = 8 * 1024 * 1024;
const encoder = new TextEncoder();
export function base64(value: ArrayBuffer | Uint8Array): string {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  let text = '';
  for (let offset = 0; offset < data.length; offset += 8192)
    text += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(text);
}
export function decode(value: unknown, max = LIMIT + 16): Uint8Array<ArrayBuffer> {
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
export function aad(binding: Binding): Uint8Array<ArrayBuffer> {
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
export async function encryptPayload(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
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
): Promise<Uint8Array<ArrayBuffer>> {
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
