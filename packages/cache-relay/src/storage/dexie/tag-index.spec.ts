/**
 * Tests for the Dexie tag-indexing helpers.
 */

import {
  formatTagForIndex,
  getIndexedTagValues,
  getIndexedTags,
  sortIndexedTags,
} from './tag-index.js';

describe('formatTagForIndex', () => {
  it('formats a single-letter tag as "key:value"', () => {
    expect(formatTagForIndex(['e', 'abc'])).toBe('e:abc');
    expect(formatTagForIndex(['p', 'def', 'extra'])).toBe('p:def');
  });

  it('returns null for non single-letter keys', () => {
    expect(formatTagForIndex(['relay', 'wss://x'])).toBeNull();
    expect(formatTagForIndex(['1', 'x'])).toBeNull();
  });

  it('returns null for malformed tags', () => {
    expect(formatTagForIndex(['e'])).toBeNull();
    expect(formatTagForIndex(['', 'x'])).toBeNull();
    expect(formatTagForIndex(['e', ''])).toBeNull();
  });
});

describe('getIndexedTags', () => {
  it('keeps only indexable single-letter tags', () => {
    const result = getIndexedTags([
      ['e', 'evt'],
      ['relay', 'wss://x'],
      ['p', 'pk'],
    ]);
    expect(result).toEqual(['e:evt', 'p:pk']);
  });

  it('returns an empty array for undefined / empty input', () => {
    expect(getIndexedTags()).toEqual([]);
    expect(getIndexedTags([])).toEqual([]);
  });

  it('caps the result at 100 entries, keeping priority tags', () => {
    // 101 non-priority tags ("z") + 1 priority tag ("e") => must cap to 100
    // and the priority tag must survive the cap.
    const tags: string[][] = [];
    for (let i = 0; i < 101; i++) {
      tags.push(['z', `v${i}`]);
    }
    tags.push(['e', 'keep']);

    const result = getIndexedTags(tags);
    expect(result).toHaveLength(100);
    expect(result).toContain('e:keep');
  });
});

describe('sortIndexedTags', () => {
  it('orders priority tags before non-priority ones', () => {
    const sorted = sortIndexedTags(['z:1', 'e:2', 'x:3', 'p:4']);
    expect(sorted.slice(0, 2)).toEqual(expect.arrayContaining(['e:2', 'p:4']));
    // priority entries come first
    expect(sorted.indexOf('e:2')).toBeLessThan(sorted.indexOf('z:1'));
    expect(sorted.indexOf('p:4')).toBeLessThan(sorted.indexOf('x:3'));
  });
});

describe('getIndexedTagValues', () => {
  it('formats values for a single-letter tag name', () => {
    expect(getIndexedTagValues('e', ['a', 'b'])).toEqual(['e:a', 'e:b']);
  });

  it('drops empty / non-string values', () => {
    expect(getIndexedTagValues('p', ['ok', '', undefined as unknown as string])).toEqual(['p:ok']);
  });

  it('returns an empty array for non single-letter tag names', () => {
    expect(getIndexedTagValues('relay', ['x'])).toEqual([]);
  });
});
