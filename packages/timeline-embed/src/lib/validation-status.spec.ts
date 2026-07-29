import type { NostrCacheRelay } from '@nostr-cache/cache-relay/browser';
import { describe, expect, it, vi } from 'vitest';
import type { ValidationStatus } from './validation-status.ts';
import { fetchValidationStatuses, hasPending } from './validation-status.ts';

describe('fetchValidationStatuses', () => {
  function fakeRelay(statuses: Map<string, ValidationStatus>) {
    return {
      getValidationStatus: vi.fn().mockResolvedValue(statuses),
    } as unknown as NostrCacheRelay;
  }

  it('fetches statuses for the given ids', async () => {
    const statuses = new Map<string, ValidationStatus>([
      ['a', 'validated'],
      ['b', 'pending'],
    ]);
    const relay = fakeRelay(statuses);

    const result = await fetchValidationStatuses(relay, ['a', 'b']);

    expect(relay.getValidationStatus).toHaveBeenCalledWith(['a', 'b']);
    expect(result).toBe(statuses);
  });

  it('deduplicates ids before querying', async () => {
    const relay = fakeRelay(new Map());

    await fetchValidationStatuses(relay, ['a', 'b', 'a']);

    expect(relay.getValidationStatus).toHaveBeenCalledWith(['a', 'b']);
  });

  it('returns an empty map without querying when there are no ids', async () => {
    const relay = fakeRelay(new Map());

    const result = await fetchValidationStatuses(relay, []);

    expect(relay.getValidationStatus).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe('hasPending', () => {
  it('returns false when every status is validated', () => {
    const statuses = new Map<string, ValidationStatus>([
      ['a', 'validated'],
      ['b', 'validated'],
    ]);
    expect(hasPending(statuses)).toBe(false);
  });

  it('returns true when a status is pending', () => {
    const statuses = new Map<string, ValidationStatus>([
      ['a', 'validated'],
      ['b', 'pending'],
    ]);
    expect(hasPending(statuses)).toBe(true);
  });

  it('returns false when a status is unknown (terminal — must not poll)', () => {
    const statuses = new Map<string, ValidationStatus>([['a', 'unknown']]);
    expect(hasPending(statuses)).toBe(false);
  });

  it('returns false for an empty map', () => {
    expect(hasPending(new Map())).toBe(false);
  });
});
