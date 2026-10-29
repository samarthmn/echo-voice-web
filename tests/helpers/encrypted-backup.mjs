// Independent test decoder for portable backup compatibility; never logs keys.
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
function open(key, sealed, binding) {
  const bytes = Buffer.from(sealed.ciphertext, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]);
}
export function decodeBackup(backup, phrase) {
  const r = backup.recovery;
  const wrapping = hkdfSync(
    'sha256',
    mnemonicToEntropy(phrase, wordlist),
    Buffer.from(r.id),
    Buffer.from('Echo library recovery v1'),
    32,
  );
  const master = open(wrapping, r.sealed, ['echo-library-recovery', 1, r.id, r.fingerprint]);
  const fingerprint = createHash('sha256')
    .update('echo-library-key-v1:')
    .update(master)
    .digest('base64');
  if (fingerprint !== r.fingerprint) throw Error('Recovery key mismatch.');
  try {
    const integrity = hkdfSync(
      'sha256',
      master,
      Buffer.from(r.id),
      Buffer.from('Echo recovery metadata integrity v1'),
      32,
    );
    if (
      open(integrity, r.integrity, [
        'echo-library-recovery-integrity',
        r.version,
        r.id,
        r.fingerprint,
        r.sealed.nonce,
        r.sealed.ciphertext,
      ]).length !== 0
    )
      throw Error('Invalid recovery metadata.');
    return JSON.parse(
      open(
        hkdfSync(
          'sha256',
          master,
          Buffer.from(backup.id),
          Buffer.from('Echo encrypted backup v1'),
          32,
        ),
        backup.data,
        ['echo-voice-encrypted', 1, backup.id, r],
      ).toString(),
    );
  } finally {
    master.fill(0);
  }
}
export async function prepareRecovery(api) {
  const setup = await api('/privacy/recovery/prepare', { method: 'POST', body: {} });
  const words = setup.phrase.split(' ');
  await api('/privacy/recovery/confirm', {
    method: 'POST',
    body: { setupId: setup.setupId, words: setup.confirmWords.map((index) => words[index - 1]) },
  });
  return setup.phrase;
}
