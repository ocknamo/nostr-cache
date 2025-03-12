/**
 * Tests for filterUtils
 */

import { Filter, NostrEvent } from '@nostr-cache/types';
import { createFilterKey, eventMatchesFilter, mergeFilters, normalizeFilter } from './filterUtils';

describe('filterUtils', () => {
  // Sample event
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

  // Sample filters
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

      // Parse the key back to an object
      const parsedKey = JSON.parse(key);

      // Check that the parsed object has the same properties as the original filter
      expect(parsedKey).toHaveProperty('kinds');
      expect(parsedKey).toHaveProperty('authors');
      expect(parsedKey).toHaveProperty('limit');

      // Check that the values are the same
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
});
