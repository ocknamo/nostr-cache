/**
 * 暗号関連のユーティリティ関数
 */

/**
 * Generates a random 32-byte secret key encoded as lowercase hex
 * @returns A 64-character lowercase hex string (32 bytes)
 */
export function getRandomSecret(): string {
  // Create a new Uint8Array of 32 bytes
  const randomBytes = new Uint8Array(32);

  // Fill the array with cryptographically secure random values
  crypto.getRandomValues(randomBytes);

  // Convert the bytes to a hex string and ensure it's lowercase
  let hexString = '';
  for (const byte of randomBytes) {
    // Convert each byte to a 2-character hex string and pad with 0 if needed
    hexString += byte.toString(16).padStart(2, '0');
  }

  return hexString;
}
