/**
 * Tests for the query builder: which index a filter is planned onto, and the
 * pure post-index validation that follows it.
 *
 * The plan is asserted against a recording stub rather than a live Dexie table.
 * What matters about it is not the rows it returns — `dexie-storage.spec.ts`
 * covers those end to end — but *how many* it has to read to find them, and
 * only the chosen index says that.
 */

import type { Filter } from '@nostr-cache/shared';
import { buildOptimizedQuery, eventRowMatchesFilter } from './query-builder.js';
import type { NostrEventTable } from './schema.js';

interface Plan {
  /** The index the query was put on, or `(scan)` for a full-table collection. */
  index: string;
  distinct: boolean;
}

/** Run `buildOptimizedQuery` against a stub table and report what it chose. */
function planFor(filter: Filter): Plan {
  const plan: Plan = { index: '(scan)', distinct: false };
  const collection = {
    filter: () => collection,
    distinct: () => {
      plan.distinct = true;
      return collection;
    },
  };
  const table = {
    where: (index: string) => {
      plan.index = index;
      return {
        anyOf: () => collection,
        between: () => collection,
      };
    },
    toCollection: () => collection,
  };
  buildOptimizedQuery(table as never, filter);
  return plan;
}

describe('buildOptimizedQuery', () => {
  const ID = 'a'.repeat(64);
  const PUBKEY = 'b'.repeat(64);

  it('serves a tag condition from the tag index even beside kinds', () => {
    // The two filters `<nostr-post>` opens for one post. On the `kind` index
    // these read every kind 1 / kind 7 row the cache holds, and the post's own
    // id lookup cannot be answered while they do.
    expect(planFor({ kinds: [1], '#e': [ID], limit: 100 }).index).toBe('indexed_tags');
    expect(planFor({ kinds: [7], '#e': [ID], limit: 200 }).index).toBe('indexed_tags');
  });

  it('de-duplicates the tag index, which is multi-entry', () => {
    // A NIP-10 reply names its root and its parent, so a level asking about
    // both would otherwise get the same row twice — and `limit` would count it
    // twice.
    expect(planFor({ kinds: [1], '#e': [ID, PUBKEY] }).distinct).toBe(true);
  });

  it('serves a tag condition beside kinds and a time range from the tag index', () => {
    expect(planFor({ kinds: [1], '#e': [ID], since: 1 }).index).toBe('indexed_tags');
    expect(planFor({ authors: [PUBKEY], '#e': [ID] }).index).toBe('indexed_tags');
  });

  it('prefers the primary key to the tag index', () => {
    expect(planFor({ ids: [ID], '#e': [ID] }).index).toBe('id');
  });

  it('prefers authors × kinds to the tag index', () => {
    // The addressable lookup `<nostr-post>` and the quote cards use. Two-field
    // equality already narrows to one person's events of one kind, while a `d`
    // value collides across people (`d:"1"` and friends).
    expect(planFor({ kinds: [30023], authors: [PUBKEY], '#d': ['slug'] }).index).toBe(
      '[pubkey+kind]'
    );
  });

  it('keeps the plans that have no tag condition to move', () => {
    expect(planFor({ '#e': [ID] }).index).toBe('indexed_tags');
    expect(planFor({ authors: [PUBKEY], kinds: [1] }).index).toBe('[pubkey+kind]');
    expect(planFor({ kinds: [1] }).index).toBe('kind');
    expect(planFor({ authors: [PUBKEY] }).index).toBe('pubkey');
    expect(planFor({ kinds: [1], since: 1 }).index).toBe('created_at');
    expect(planFor({ authors: [PUBKEY], '#p': [ID], since: 1 }).index).toBe('created_at');
    expect(planFor({}).index).toBe('(scan)');
  });

  it('falls back when the tag condition is not one the index can answer', () => {
    // A multi-letter tag name is not indexed (and `eventRowMatchesFilter`
    // rejects every row for it), so the plan must not claim the tag index.
    expect(planFor({ kinds: [1], '#ee': [ID] } as unknown as Filter).index).toBe('kind');
    expect(planFor({ kinds: [1], '#e': [] }).index).toBe('kind');
  });
});

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
