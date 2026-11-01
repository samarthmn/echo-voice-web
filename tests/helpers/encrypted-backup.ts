import { object, text, array, numeric } from './assertions.ts';
import type { CipherKey } from 'node:crypto';
// Independent test decoder for portable backup compatibility; never logs keys.
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
function open(input: ArrayBuffer | CipherKey, value: unknown, binding: unknown[]) {
  const key = input instanceof ArrayBuffer ? Buffer.from(input) : input;
  const sealed = object(value);
  const bytes = Buffer.from(text(sealed['ciphertext']), 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(text(sealed['nonce']), 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]);
}
export function decodeBackup(input: unknown, phrase: string): unknown {
  const backup = object(input);
  const r = object(backup['recovery']);
  const wrapping = hkdfSync(
    'sha256',
    mnemonicToEntropy(phrase, wordlist),
    Buffer.from(text(r['id'])),
    Buffer.from('Echo library recovery v1'),
    32,
  );
  const master = open(wrapping, r['sealed'], [
    'echo-library-recovery',
    1,
    text(r['id']),
    text(r['fingerprint']),
  ]);
  const fingerprint = createHash('sha256')
    .update('echo-library-key-v1:')
    .update(master)
    .digest('base64');
  if (fingerprint !== text(r['fingerprint'])) throw Error('Recovery key mismatch.');
  try {
    const integrity = hkdfSync(
      'sha256',
      master,
      Buffer.from(text(r['id'])),
      Buffer.from('Echo recovery metadata integrity v1'),
      32,
    );
    if (
      open(integrity, r['integrity'], [
        'echo-library-recovery-integrity',
        r['version'],
        text(r['id']),
        text(r['fingerprint']),
        object(r['sealed'])['nonce'],
        object(r['sealed'])['ciphertext'],
      ]).length !== 0
    )
      throw Error('Invalid recovery metadata.');
    return JSON.parse(
      open(
        hkdfSync(
          'sha256',
          master,
          Buffer.from(text(backup['id'])),
          Buffer.from('Echo encrypted backup v1'),
          32,
        ),
        backup['data'],
        ['echo-voice-encrypted', 1, text(backup['id']), r],
      ).toString(),
    );
  } finally {
    master.fill(0);
  }
}
export async function prepareRecovery(
  api: (path: string, options: { method: string; body: unknown }) => Promise<unknown>,
): Promise<string> {
  const setup = object(await api('/privacy/recovery/prepare', { method: 'POST', body: {} }));
  const words = text(setup['phrase']).split(' ');
  await api('/privacy/recovery/confirm', {
    method: 'POST',
    body: {
      setupId: setup['setupId'],
      words: array(setup['confirmWords']).map((index) => words[numeric(index) - 1]),
    },
  });
  return text(setup['phrase']);
}
