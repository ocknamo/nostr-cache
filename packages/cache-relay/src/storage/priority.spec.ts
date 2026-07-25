import { describe, expect, it } from 'vitest';
import { createPriorityMatcher, hasPriorityRules } from './priority.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

describe('hasPriorityRules', () => {
  it('should be false for undefined', () => {
    expect(hasPriorityRules(undefined)).toBe(false);
  });

  it('should be false for an empty object', () => {
    expect(hasPriorityRules({})).toBe(false);
  });

  it('should be false for empty arrays', () => {
    expect(hasPriorityRules({ pubkeys: [], kinds: [] })).toBe(false);
  });

  it('should be true when a pubkey is listed', () => {
    expect(hasPriorityRules({ pubkeys: [PUBKEY_A] })).toBe(true);
  });

  it('should be true when a kind is listed', () => {
    expect(hasPriorityRules({ kinds: [0] })).toBe(true);
  });
});

describe('createPriorityMatcher', () => {
  it('should match on pubkey', () => {
    const isPriority = createPriorityMatcher({ pubkeys: [PUBKEY_A] });
    expect(isPriority({ pubkey: PUBKEY_A, kind: 1 })).toBe(true);
    expect(isPriority({ pubkey: PUBKEY_B, kind: 1 })).toBe(false);
  });

  it('should match on kind', () => {
    const isPriority = createPriorityMatcher({ kinds: [0] });
    expect(isPriority({ pubkey: PUBKEY_B, kind: 0 })).toBe(true);
    expect(isPriority({ pubkey: PUBKEY_B, kind: 1 })).toBe(false);
  });

  it('should match when either rule matches (OR semantics)', () => {
    const isPriority = createPriorityMatcher({ pubkeys: [PUBKEY_A], kinds: [0] });
    expect(isPriority({ pubkey: PUBKEY_A, kind: 1 })).toBe(true);
    expect(isPriority({ pubkey: PUBKEY_B, kind: 0 })).toBe(true);
    expect(isPriority({ pubkey: PUBKEY_B, kind: 1 })).toBe(false);
  });
});
