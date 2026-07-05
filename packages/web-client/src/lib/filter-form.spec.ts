import { describe, expect, it } from 'vitest';
import { buildFilter, parseFilterJson } from './filter-form.ts';

describe('buildFilter', () => {
  it('parses comma-separated kinds into numbers', () => {
    const result = buildFilter({ kinds: '1, 30023' });
    expect(result).toEqual({ ok: true, filter: { kinds: [1, 30023] } });
  });

  it('parses authors and ids as trimmed token lists', () => {
    const result = buildFilter({ authors: 'abc, def\n ghi', ids: 'id1 id2' });
    expect(result).toEqual({
      ok: true,
      filter: { authors: ['abc', 'def', 'ghi'], ids: ['id1', 'id2'] },
    });
  });

  it('omits empty fields entirely', () => {
    const result = buildFilter({ kinds: '', authors: '  ', ids: undefined, limit: '' });
    expect(result).toEqual({ ok: true, filter: {} });
  });

  it('parses limit, since, and until as integers', () => {
    const result = buildFilter({ limit: '50', since: '1700000000', until: '1800000000' });
    expect(result).toEqual({
      ok: true,
      filter: { limit: 50, since: 1700000000, until: 1800000000 },
    });
  });

  it('rejects non-numeric kinds', () => {
    const result = buildFilter({ kinds: '1, abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('abc');
    }
  });

  it('rejects negative or non-integer numeric fields', () => {
    expect(buildFilter({ limit: '-1' }).ok).toBe(false);
    expect(buildFilter({ since: '1.5' }).ok).toBe(false);
    expect(buildFilter({ until: 'soon' }).ok).toBe(false);
    expect(buildFilter({ kinds: '-2' }).ok).toBe(false);
  });
});

describe('parseFilterJson', () => {
  it('accepts a valid filter object', () => {
    const result = parseFilterJson('{"kinds": [1], "authors": ["abc"], "limit": 10}');
    expect(result).toEqual({
      ok: true,
      filter: { kinds: [1], authors: ['abc'], limit: 10 },
    });
  });

  it('accepts tag queries with string arrays', () => {
    const result = parseFilterJson('{"#e": ["evt"], "#p": ["pk"]}');
    expect(result).toEqual({ ok: true, filter: { '#e': ['evt'], '#p': ['pk'] } });
  });

  it('rejects invalid JSON', () => {
    const result = parseFilterJson('{nope');
    expect(result.ok).toBe(false);
  });

  it('rejects non-object JSON', () => {
    expect(parseFilterJson('[1, 2]').ok).toBe(false);
    expect(parseFilterJson('"filter"').ok).toBe(false);
    expect(parseFilterJson('null').ok).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(parseFilterJson('{"kinds": ["1"]}').ok).toBe(false);
    expect(parseFilterJson('{"authors": [1]}').ok).toBe(false);
    expect(parseFilterJson('{"limit": "10"}').ok).toBe(false);
    expect(parseFilterJson('{"#e": [1]}').ok).toBe(false);
  });
});
