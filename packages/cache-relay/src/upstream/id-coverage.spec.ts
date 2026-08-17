/** Tests for the id coverage short-circuit. */

import type { Filter } from '@nostr-cache/shared';
import { describe, expect, it } from 'vitest';
import { isIdCovered, narrowFiltersByIdCoverage } from './id-coverage.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const PUBKEY = 'c'.repeat(64);

describe('isIdCovered', () => {
  it('covers a filter whose every id was delivered', () => {
    expect(isIdCovered({ ids: [ID_A, ID_B] }, new Set([ID_A, ID_B]))).toBe(true);
  });

  it('does not cover a filter with one id missing', () => {
    expect(isIdCovered({ ids: [ID_A, ID_B] }, new Set([ID_A]))).toBe(false);
  });

  it('does not cover a filter without ids', () => {
    expect(isIdCovered({ kinds: [1], '#e': [ID_A] }, new Set([ID_A]))).toBe(false);
  });

  it('covers an id filter carrying further narrowing conditions', () => {
    // それらは絞るだけなので、id が揃っていれば上流に聞くことは何も無い
    const filter: Filter = { ids: [ID_A], kinds: [1], authors: [PUBKEY], since: 1, until: 2 };
    expect(isIdCovered(filter, new Set([ID_A]))).toBe(true);
  });

  it('covers an empty ids array', () => {
    expect(isIdCovered({ ids: [] }, new Set())).toBe(true);
  });
});

describe('narrowFiltersByIdCoverage', () => {
  it('drops covered filters and keeps the rest', () => {
    const open: Filter = { kinds: [1], '#e': [ID_A] };

    expect(narrowFiltersByIdCoverage([{ ids: [ID_A] }, open], [ID_A])).toEqual([open]);
  });

  it('returns an empty array when every filter is covered', () => {
    expect(narrowFiltersByIdCoverage([{ ids: [ID_A] }, { ids: [ID_B] }], [ID_A, ID_B])).toEqual([]);
  });

  it('accepts ids delivered by another filter of the same REQ as evidence', () => {
    // 判定しているのは「マッチしたか」ではなく「キャッシュが保持しているか」
    const covered: Filter = { ids: [ID_A], kinds: [7] };

    expect(narrowFiltersByIdCoverage([{ ids: [ID_A] }, covered], [ID_A])).toEqual([]);
  });

  it('leaves filters untouched when none names ids', () => {
    const filters: Filter[] = [{ kinds: [1] }, { authors: [PUBKEY] }];

    expect(narrowFiltersByIdCoverage(filters, [ID_A])).toBe(filters);
  });

  it('forwards an id filter when nothing was delivered', () => {
    const filters: Filter[] = [{ ids: [ID_A] }];

    expect(narrowFiltersByIdCoverage(filters, [])).toEqual(filters);
  });
});
