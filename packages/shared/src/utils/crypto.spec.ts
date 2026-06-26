import { describe, expect, it } from 'vitest';
import { getRandomSecret } from './crypto.js';

describe('getRandomSecret', () => {
  it('should generate a 64-character lowercase hex string', () => {
    const secret = getRandomSecret();

    expect(secret).toHaveLength(64);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate different values on each call', () => {
    const values = new Set([getRandomSecret(), getRandomSecret(), getRandomSecret()]);

    expect(values.size).toBe(3);
  });
});
