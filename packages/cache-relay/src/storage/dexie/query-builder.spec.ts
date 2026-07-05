/**
 * Tests for the pure post-index validation in the query builder.
 *
 * `buildOptimizedQuery` needs a live Dexie table and is exercised end-to-end
 * by `dexie-storage.spec.ts`; here we cover the pure `eventRowMatchesFilter`
 * predicate directly.
 */

import type { Filter } from '@nostr-cache/shared';
import { eventRowMatchesFilter } from './query-builder.js';
import type { NostrEventTable } from './schema.js';

function makeRow(overrides: Partial<NostrEventTable> = {}): NostrEventTable {
  return {
    id: 'id1',
    pubkey: 'pub1',
    created_at: 1000,
    kind: 1,
    tags: [['e', 'evt1']],
    indexed_tags: ['e:evt1'],
    content: 'hello',
    sig: 'sig1',
    last_accessed_at: 0,
    access_count: 1,
    cached_at: 0,
    validated: 1,
    ...overrides,
  };
}

describe('eventRowMatchesFilter', () => {
  it('matches when the filter conditions are satisfied', () => {
    expect(eventRowMatchesFilter(makeRow(), { kinds: [1] })).toBe(true);
    expect(eventRowMatchesFilter(makeRow(), { authors: ['pub1'] })).toBe(true);
    expect(eventRowMatchesFilter(makeRow(), { '#e': ['evt1'] })).toBe(true);
  });

  it('does not match when a valid tag filter has no matching value', () => {
    expect(eventRowMatchesFilter(makeRow(), { '#e': ['other'] })).toBe(false);
  });

  it('rejects malformed tag filter names (not a single letter)', () => {
    expect(eventRowMatchesFilter(makeRow(), { '#ee': ['evt1'] } as unknown as Filter)).toBe(false);
  });

  it('rejects tag filters whose values are not all non-empty strings', () => {
    expect(eventRowMatchesFilter(makeRow(), { '#e': [123] } as unknown as Filter)).toBe(false);
    expect(eventRowMatchesFilter(makeRow(), { '#e': [''] })).toBe(false);
  });

  it('does not match when a non-tag condition fails', () => {
    expect(eventRowMatchesFilter(makeRow(), { kinds: [2] })).toBe(false);
    expect(eventRowMatchesFilter(makeRow(), { authors: ['other'] })).toBe(false);
  });
});
