import { getRandomSecret } from './getRandomSecret.js';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi, type Mock } from 'vitest';

describe('getRandomSecret', () => {
  it('should generate a 64-character lowercase hex string', () => {
    const secret = getRandomSecret();

    // Check length is 64 (32 bytes as hex)
    expect(secret.length).toBe(64);

    // Check that it only contains valid lowercase hex characters
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate different values on each call', () => {
    const secret1 = getRandomSecret();
    const secret2 = getRandomSecret();
    const secret3 = getRandomSecret();

    // Verify that multiple calls return different values
    expect(secret1).not.toBe(secret2);
    expect(secret1).not.toBe(secret3);
    expect(secret2).not.toBe(secret3);
  });
});
