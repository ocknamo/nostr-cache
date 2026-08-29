/** Tests for filterUtils */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import {
  capEvents,
  createFilterKey,
  eventMatchesFilter,
  isValidFilterShape,
  mergeFilters,
  normalizeFilter,
  normalizeLimit,
  rejectsEveryRow,
} from './filter-utils.js';

describe('filterUtils', () => {
  const sampleEvent: NostrEvent = {
    id: '123',
    pubkey: 'abc',
    created_at: 1000,
    kind: 1,
    tags: [
      ['e', '456'],
      ['p', 'def'],
      ['t', 'tag1'],
      ['t', 'tag2'],
    ],
    content: 'Hello, world!',
    sig: 'xyz',
  };

  const sampleFilter1: Filter = {
    kinds: [1],
    authors: ['abc'],
    limit: 10,
  };

  const sampleFilter2: Filter = {
    kinds: [1, 2],
    '#e': ['456'],
    limit: 20,
  };

  const sampleFilter3: Filter = {
    since: 500,
    until: 1500,
    '#p': ['def'],
  };

  describe('createFilterKey', () => {
    it('should create a consistent key for a filter', () => {
      const key = createFilterKey(sampleFilter1);

      expect(typeof key).toBe('string');

      const parsedKey = JSON.parse(key);

      // Check that the parsed object has the same properties as the original filter
      expect(parsedKey).toHaveProperty('kinds');
      expect(parsedKey).toHaveProperty('authors');
      expect(parsedKey).toHaveProperty('limit');

      expect(parsedKey.kinds).toEqual(sampleFilter1.kinds);
      expect(parsedKey.authors).toEqual(sampleFilter1.authors);
      expect(parsedKey.limit).toEqual(sampleFilter1.limit);
    });

    it('should create the same key for filters with the same content but different order', () => {
      const filter1 = {
        kinds: [1, 2],
        authors: ['abc', 'def'],
      };

      const filter2 = {
        authors: ['def', 'abc'],
        kinds: [2, 1],
      };

      const key1 = createFilterKey(filter1);
      const key2 = createFilterKey(filter2);

      expect(key1).toBe(key2);
    });
  });

  describe('normalizeFilter', () => {
    it('should sort arrays in the filter', () => {
      const filter = {
        kinds: [2, 1],
        authors: ['def', 'abc'],
      };

      const normalized = normalizeFilter(filter);

      expect(normalized.kinds).toEqual([1, 2]);
      expect(normalized.authors).toEqual(['abc', 'def']);
    });

    it('should preserve non-array values', () => {
      const filter = {
        kinds: [1],
        limit: 10,
        since: 1000,
      };

      const normalized = normalizeFilter(filter);

      expect(normalized.limit).toBe(10);
      expect(normalized.since).toBe(1000);
    });
  });

  describe('eventMatchesFilter', () => {
    it('should match an event against a filter with matching criteria', () => {
      const result = eventMatchesFilter(sampleEvent, sampleFilter1);

      expect(result).toBe(true);
    });

    it('should not match an event against a filter with non-matching criteria', () => {
      const result = eventMatchesFilter(sampleEvent, {
        kinds: [2], // Different kind
        authors: ['def'], // Different author
      });

      expect(result).toBe(false);
    });

    it('should match events based on ids', () => {
      const result = eventMatchesFilter(sampleEvent, {
        ids: ['123'],
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        ids: ['456'], // Different ID
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on authors', () => {
      const result = eventMatchesFilter(sampleEvent, {
        authors: ['abc'],
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        authors: ['def'], // Different author
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on kinds', () => {
      const result = eventMatchesFilter(sampleEvent, {
        kinds: [1],
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        kinds: [2], // Different kind
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on since', () => {
      const result = eventMatchesFilter(sampleEvent, {
        since: 500, // Before event.created_at
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        since: 1500, // After event.created_at
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on until', () => {
      const result = eventMatchesFilter(sampleEvent, {
        until: 1500, // After event.created_at
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        until: 500, // Before event.created_at
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on tag filters', () => {
      const result = eventMatchesFilter(sampleEvent, {
        '#e': ['456'],
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        '#e': ['789'], // Not in event tags
      });

      expect(nonMatchResult).toBe(false);
    });

    it('should match events based on multiple criteria', () => {
      const result = eventMatchesFilter(sampleEvent, {
        kinds: [1],
        authors: ['abc'],
        '#e': ['456'],
        since: 500,
        until: 1500,
      });

      expect(result).toBe(true);

      const nonMatchResult = eventMatchesFilter(sampleEvent, {
        kinds: [1],
        authors: ['abc'],
        '#e': ['789'], // Not in event tags
      });

      expect(nonMatchResult).toBe(false);
    });

    // `until: 0` / `since: 0` を truthy 判定で「指定なし」として無視すると、
    // ストレージ側のインデックス絞り込みと最終判定が割れる
    it('should treat until: 0 as a real bound rather than unset', () => {
      expect(eventMatchesFilter(sampleEvent, { until: 0 })).toBe(false);
      expect(eventMatchesFilter({ ...sampleEvent, created_at: 0 }, { until: 0 })).toBe(true);
    });

    it('should treat since: 0 as a real bound rather than unset', () => {
      expect(eventMatchesFilter(sampleEvent, { since: 0 })).toBe(true);
      expect(eventMatchesFilter({ ...sampleEvent, created_at: -1 }, { since: 0 })).toBe(false);
    });
  });

  describe('normalizeLimit', () => {
    it('should pass through non-negative integers', () => {
      expect(normalizeLimit(0)).toBe(0);
      expect(normalizeLimit(20)).toBe(20);
    });

    it('should floor fractional limits', () => {
      // SQLite の LIMIT は小数でクエリ全体が失敗するため、境界を整数に丸める
      expect(normalizeLimit(2.7)).toBe(2);
    });

    it('should clamp negative limits to zero', () => {
      expect(normalizeLimit(-1)).toBe(0);
      expect(normalizeLimit(Number.NEGATIVE_INFINITY)).toBe(0);
    });

    it('should report unusable counts as no limit', () => {
      expect(normalizeLimit(undefined)).toBeUndefined();
      expect(normalizeLimit(Number.NaN)).toBeUndefined();
      expect(normalizeLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
    });
  });

  describe('mergeFilters', () => {
    it('should return an empty object for an empty array', () => {
      const result = mergeFilters([]);

      expect(result).toEqual({});
    });

    it('should return the filter for an array with a single filter', () => {
      const result = mergeFilters([sampleFilter1]);

      expect(result).toEqual(sampleFilter1);
    });

    it('should merge ids as a union', () => {
      const result = mergeFilters([{ ids: ['123', '456'] }, { ids: ['456', '789'] }]);

      expect(result.ids).toEqual(['123', '456', '789']);
    });

    it('should merge authors as a union', () => {
      const result = mergeFilters([{ authors: ['abc', 'def'] }, { authors: ['def', 'ghi'] }]);

      expect(result.authors).toEqual(['abc', 'def', 'ghi']);
    });

    it('should merge kinds as a union', () => {
      const result = mergeFilters([{ kinds: [1, 2] }, { kinds: [2, 3] }]);

      expect(result.kinds).toEqual([1, 2, 3]);
    });

    it('should merge since by taking the highest value', () => {
      const result = mergeFilters([{ since: 1000 }, { since: 2000 }]);

      expect(result.since).toBe(2000);
    });

    it('should merge until by taking the lowest value', () => {
      const result = mergeFilters([{ until: 3000 }, { until: 2000 }]);

      expect(result.until).toBe(2000);
    });

    it('should merge limit by taking the lowest value', () => {
      const result = mergeFilters([{ limit: 20 }, { limit: 10 }]);

      expect(result.limit).toBe(10);
    });

    it('should merge tag filters as a union', () => {
      const result = mergeFilters([{ '#e': ['123', '456'] }, { '#e': ['456', '789'] }]);

      expect(result['#e']).toEqual(['123', '456', '789']);
    });

    it('should merge multiple filters correctly', () => {
      const result = mergeFilters([sampleFilter1, sampleFilter2, sampleFilter3]);

      expect(result.kinds).toEqual([1, 2]);
      expect(result.authors).toEqual(['abc']);
      expect(result['#e']).toEqual(['456']);
      expect(result['#p']).toEqual(['def']);
      expect(result.since).toBe(500);
      expect(result.until).toBe(1500);
      expect(result.limit).toBe(10);
    });
  });

  const makeEvent = (id: string, created_at: number): NostrEvent => ({
    id,
    pubkey: 'pk',
    created_at,
    kind: 1,
    tags: [],
    content: '',
    sig: 'sig',
  });

  describe('capEvents', () => {
    // NIP-01 は limit 付きクエリの結果を「新しい順」で返すよう求めており、
    // 上限に達していない（＝切り詰めが起きない）場合も要件は変わらない
    it('should order newest-first even when within the cap', () => {
      const events = [makeEvent('a', 1), makeEvent('b', 2)];
      expect(capEvents(events, 2).map((e) => e.id)).toEqual(['b', 'a']);
      expect(capEvents(events, 5).map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('should not mutate the input array', () => {
      const events = [makeEvent('a', 1), makeEvent('b', 2)];
      capEvents(events, 5);
      expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('should return no events for a negative cap', () => {
      expect(capEvents([makeEvent('a', 1)], -1)).toEqual([]);
    });

    it('should keep the newest events (created_at descending) when over the cap', () => {
      const events = [
        makeEvent('old', 100),
        makeEvent('newest', 500),
        makeEvent('mid', 300),
        makeEvent('second', 400),
      ];
      expect(capEvents(events, 2).map((e) => e.id)).toEqual(['newest', 'second']);
    });

    it('should break created_at ties by id for deterministic output', () => {
      const events = [makeEvent('c', 100), makeEvent('a', 100), makeEvent('b', 100)];
      expect(capEvents(events, 2).map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('should not mutate the input array', () => {
      const events = [makeEvent('old', 100), makeEvent('newest', 500), makeEvent('mid', 300)];
      const snapshot = events.map((e) => e.id);
      capEvents(events, 1);
      expect(events.map((e) => e.id)).toEqual(snapshot);
    });
  });

  describe('isValidFilterShape', () => {
    it('accepts a filter with at least one valid condition', () => {
      expect(isValidFilterShape({ kinds: [1] })).toBe(true);
      expect(isValidFilterShape({ ids: ['abc'] })).toBe(true);
      expect(isValidFilterShape({ authors: [] })).toBe(true);
      expect(isValidFilterShape({ '#e': ['evt'] })).toBe(true);
      expect(isValidFilterShape({ '#p': ['pk'] })).toBe(true);
      expect(isValidFilterShape({ since: 100 })).toBe(true);
      expect(isValidFilterShape({ until: 200 })).toBe(true);
      expect(isValidFilterShape({ limit: 10 })).toBe(true);
    });

    it('rejects an empty filter or one with no recognised condition', () => {
      expect(isValidFilterShape({})).toBe(false);
      expect(isValidFilterShape({ kinds: [] })).toBe(false); // kinds must be non-empty
      expect(isValidFilterShape(null as unknown as Filter)).toBe(false);
      expect(isValidFilterShape('nope' as unknown as Filter)).toBe(false);
    });

    it('accepts any single-letter tag filter, not only #e and #p', () => {
      // ストレージ側も eventMatchesFilter も汎用タグを扱えるので、REQ 検証だけが
      // NIP-01 より狭いということが無いようにする（#t のハッシュタグ購読など）
      expect(isValidFilterShape({ '#t': ['nostr'] })).toBe(true);
      expect(isValidFilterShape({ '#d': ['identifier'] })).toBe(true);
      expect(isValidFilterShape({ '#a': ['30023:pk:slug'] })).toBe(true);
    });

    it('rejects conditions of the wrong type', () => {
      expect(isValidFilterShape({ ids: 'abc' } as unknown as Filter)).toBe(false);
      expect(isValidFilterShape({ since: '100' } as unknown as Filter)).toBe(false);
      expect(isValidFilterShape({ limit: '10' } as unknown as Filter)).toBe(false);
      expect(isValidFilterShape({ '#t': 'nostr' } as unknown as Filter)).toBe(false);
      // 1 文字でないタグキーは NIP-01 の定義外
      expect(isValidFilterShape({ '#tag': ['nostr'] } as unknown as Filter)).toBe(false);
    });
  });

  describe('rejectsEveryRow', () => {
    it('rejects malformed tag filter names (not a single letter)', () => {
      expect(rejectsEveryRow({ '#ee': ['evt1'] } as unknown as Filter)).toBe(true);
    });

    it('rejects tag filters whose values are not all non-empty strings', () => {
      expect(rejectsEveryRow({ '#e': [123] } as unknown as Filter)).toBe(true);
      expect(rejectsEveryRow({ '#e': [''] })).toBe(true);
    });

    it('accepts a well-formed filter', () => {
      expect(rejectsEveryRow({ kinds: [1], '#e': ['evt1'] })).toBe(false);
    });
  });
});
