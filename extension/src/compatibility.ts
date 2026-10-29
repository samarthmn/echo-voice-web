// Protocol v1 has older plaintext-storage implementations. Check the protection
// capabilities before sending any recording metadata or audio to a companion.
export function protectedCompanion(body: unknown): boolean {
  const value = body as Record<string, unknown> | null;
  return (
    !!value &&
    typeof value.appVersion === 'string' &&
    value.appVersion.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.appVersion) &&
    value.storageProtectionVersion === 1 &&
    value.recordingReceiptVersion === 1
  );
}
export const UPDATE_ECHO_MESSAGE =
  'Update the Echo app before transferring recordings. This version cannot confirm protected storage and complete audio verification. Audio stays saved in this browser.';
