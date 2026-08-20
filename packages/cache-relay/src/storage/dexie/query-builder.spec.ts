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
import { buildOptimizedQuery, eventRowMatchesFilter, planQuery } from './query-builder.js';
import type { NostrEventTable } from './schema.js';

interface Plan {
  /** The index the query was put on, or `(scan)` for a full-table collection. */
  index: string;
  distinct: boolean;
}

/** Stub table that records the indexes it is asked for, one entry per cursor. */
function recordingTable() {
  const indexes: string[] = [];
  const reversed: boolean[] = [];
  let distinct = false;
  const collection = {
    filter: () => collection,
    reverse: () => {
      reversed[indexes.length - 1] = true;
      return collection;
    },
    distinct: () => {
      distinct = true;
      return collection;
    },
  };
  const table = {
    where: (index: string) => {
      indexes.push(index);
      reversed.push(false);
      return {
        anyOf: () => collection,
        between: () => collection,
      };
    },
    toCollection: () => {
      indexes.push('(scan)');
      reversed.push(false);
      return collection;
    },
  };
  return {
    table,
    get indexes() {
      return indexes;
    },
    get reversed() {
      return reversed;
    },
    get distinct() {
      return distinct;
    },
  };
}

/** Run `buildOptimizedQuery` against a stub table and report what it chose. */
function planFor(filter: Filter): Plan {
  const recorder = recordingTable();
  buildOptimizedQuery(recorder.table as never, filter);
  return { index: recorder.indexes[0] ?? '(scan)', distinct: recorder.distinct };
}

interface OrderedPlan {
  /** One entry per cursor the plan opens, in the order they were opened. */
  indexes: string[];
  /** Whether each cursor walks its index backwards (newest first). */
  reversed: boolean[];
  ordered: boolean;
}

/** Run `planQuery` against a stub table and report the cursors it opened. */
function orderedPlanFor(filter: Filter, limit: number | undefined): OrderedPlan {
  const recorder = recordingTable();
  const plan = planQuery(recorder.table as never, filter, limit);
  return { indexes: recorder.indexes, reversed: recorder.reversed, ordered: plan.ordered };
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

  /** A follow list, i.e. far more authors than deserve a cursor each. */
  const FOLLOWS = Array.from({ length: 500 }, (_, i) => `${i}`.padStart(64, '0'));

  it('walks a kind newest-first for a follow list, so the walk can stop early', () => {
    // `[pubkey+kind]` だと 500 本の部分範囲を舐めて一致行を全件読む（574ms）
    const follows = orderedPlanFor({ kinds: [1], authors: FOLLOWS, limit: 50 }, 50);
    expect(follows.ordered).toBe(true);
    expect(follows.indexes).toEqual(['[kind+created_at]']);
    expect(follows.reversed).toEqual([true]);
  });

  it('opens one cursor per kind, since a compound range covers only one', () => {
    const plan = orderedPlanFor({ kinds: [1, 6], authors: FOLLOWS, limit: 50 }, 50);
    expect(plan.indexes).toEqual(['[kind+created_at]', '[kind+created_at]']);
    expect(plan.reversed).toEqual([true, true]);
  });

  it('reads a narrow author set per author, never leaving their rows', () => {
    // `<nostr-timeline authors="npub1…">` の形。kind 走査に載せると、その 1 人を
    // 探して全 kind 1 を読むことになる（128ms。旧経路は 8ms）
    const single = orderedPlanFor({ kinds: [1], authors: [PUBKEY], limit: 50 }, 50);
    expect(single.indexes).toEqual(['[pubkey+kind+created_at]']);
    expect(single.reversed).toEqual([true]);

    // kind の指定が無ければ著者だけの複合インデックスで足りる
    expect(orderedPlanFor({ authors: [PUBKEY], limit: 50 }, 50).indexes).toEqual([
      '[pubkey+created_at]',
    ]);
  });

  it('opens a cursor per (author, kind) pair, and stops when there are too many', () => {
    const two = [PUBKEY, ID];
    expect(orderedPlanFor({ kinds: [1, 7], authors: two, limit: 50 }, 50).indexes).toEqual(
      Array(4).fill('[pubkey+kind+created_at]')
    );

    // 座標が増えるとサブレンジのシーク自体が高くつくので kind 走査へ倒す
    const many = Array.from({ length: 9 }, (_, i) => `${i}`.padStart(64, 'a'));
    expect(orderedPlanFor({ kinds: [1, 7], authors: many, limit: 50 }, 50).indexes).toEqual([
      '[kind+created_at]',
      '[kind+created_at]',
    ]);
  });

  it('de-duplicates kinds and authors, which would otherwise deliver a row twice', () => {
    // 同じ行が 2 回届き、`capEvents` が limit を重複で食う
    expect(orderedPlanFor({ kinds: [1, 1], limit: 50 }, 50).indexes).toEqual(['[kind+created_at]']);
    expect(orderedPlanFor({ authors: [PUBKEY, PUBKEY], limit: 50 }, 50).indexes).toEqual([
      '[pubkey+created_at]',
    ]);
  });

  it('walks created_at itself when the kinds are too many to be worth a cursor each', () => {
    const manyKinds = [0, 1, 3, 4, 5, 6, 7, 40, 1984];
    const plan = orderedPlanFor({ kinds: manyKinds, limit: 50 }, 50);
    expect(plan.indexes).toEqual(['created_at']);
    expect(plan.reversed).toEqual([true]);
  });

  it('walks created_at itself when nothing narrows the range', () => {
    expect(orderedPlanFor({ limit: 3 }, 3).indexes).toEqual(['created_at']);
    expect(orderedPlanFor({ since: 1, limit: 3 }, 3).indexes).toEqual(['created_at']);
  });

  it('keeps the plans that have nothing to gain from reading newest-first', () => {
    // limit が無ければ打ち切る先が無い
    expect(orderedPlanFor({ kinds: [1], authors: [PUBKEY] }, undefined).ordered).toBe(false);
    expect(orderedPlanFor({ kinds: [1], authors: [PUBKEY] }, undefined).indexes).toEqual([
      '[pubkey+kind]',
    ]);
    expect(orderedPlanFor({ ids: [ID], limit: 10 }, 10).ordered).toBe(false);
    expect(orderedPlanFor({ ids: [ID], limit: 10 }, 10).indexes).toEqual(['id']);
    // タグ値に一致する行は普通ごく少数で、created_at 順には並べられない
    expect(orderedPlanFor({ kinds: [1], '#e': [ID], limit: 100 }, 100).ordered).toBe(false);
    expect(orderedPlanFor({ kinds: [1], '#e': [ID], limit: 100 }, 100).indexes).toEqual([
      'indexed_tags',
    ]);
    expect(orderedPlanFor({ kinds: [1], limit: 0 }, 0).ordered).toBe(false);
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
