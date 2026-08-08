/** 暗号関連のユーティリティ関数 */

/** Generates a random 32-byte secret key encoded as lowercase hex */
export function getRandomSecret(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  let hexString = '';
  for (const byte of randomBytes) {
    hexString += byte.toString(16).padStart(2, '0');
  }

  return hexString;
}
