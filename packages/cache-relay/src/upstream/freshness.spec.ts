/** Tests for the cache-first freshness window. */

import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { type Mock, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '../storage/storage-adapter.js';
import { FreshnessGate, isFreshnessEligible, narrowFiltersByFreshness } from './freshness.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

const NOW = 1_700_000_000_000;
/** kind 0 は1時間、kind 3 は10分 */
const WINDOWS = new Map([
  [0, 3600],
  [3, 600],
]);

/** Minimal stored event; only id / kind / pubkey matter to the freshness logic. */
function event(id: string, kind: number, pubkey: string): NostrEvent {
  return {
    id,
    pubkey,
    created_at: Math.floor(NOW / 1000),
    kind,
    tags: [],
    content: '',
    sig: 'f'.repeat(128),
  };
}

/** `cached_at` map placing each id the given number of seconds in the past. */
function cachedSecondsAgo(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries).map(([id, ago]) => [id, NOW - ago * 1000]));
}

describe('isFreshnessEligible', () => {
  it('accepts a replaceable kinds + authors filter', () => {
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A] }, WINDOWS)).toBe(true);
  });

  it('rejects a filter without authors (the expected set is not enumerable)', () => {
    expect(isFreshnessEligible({ kinds: [0] }, WINDOWS)).toBe(false);
  });

  it('rejects a filter without kinds', () => {
    expect(isFreshnessEligible({ authors: [PUBKEY_A] }, WINDOWS)).toBe(false);
  });

  it('rejects empty kinds / authors arrays', () => {
    expect(isFreshnessEligible({ kinds: [], authors: [PUBKEY_A] }, WINDOWS)).toBe(false);
    expect(isFreshnessEligible({ kinds: [0], authors: [] }, WINDOWS)).toBe(false);
  });

  it('rejects a regular kind mixed in with a replaceable one', () => {
    expect(isFreshnessEligible({ kinds: [0, 1], authors: [PUBKEY_A] }, WINDOWS)).toBe(false);
  });

  it('rejects an addressable kind (out of scope: the d tag is part of the coordinate)', () => {
    const windows = new Map([[30023, 3600]]);
    expect(isFreshnessEligible({ kinds: [30023], authors: [PUBKEY_A] }, windows)).toBe(false);
  });

  it('rejects a replaceable kind that has no configured window', () => {
    expect(isFreshnessEligible({ kinds: [10002], authors: [PUBKEY_A] }, WINDOWS)).toBe(false);
  });

  it('rejects filters carrying ids, since or until', () => {
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], ids: ['x'] }, WINDOWS)).toBe(
      false
    );
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], since: 1 }, WINDOWS)).toBe(false);
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], until: 1 }, WINDOWS)).toBe(false);
  });

  it('rejects filters carrying a tag condition', () => {
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], '#p': ['x'] }, WINDOWS)).toBe(
      false
    );
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], '#d': ['x'] }, WINDOWS)).toBe(
      false
    );
  });

  it('allows limit (a truncated response simply leaves coordinates uncovered)', () => {
    expect(isFreshnessEligible({ kinds: [0], authors: [PUBKEY_A], limit: 1 }, WINDOWS)).toBe(true);
  });
});

describe('narrowFiltersByFreshness', () => {
  it('drops a filter whose every coordinate was served fresh', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A, PUBKEY_B] }];
    const sent = [event('e1', 0, PUBKEY_A), event('e2', 0, PUBKEY_B)];
    const cachedAt = cachedSecondsAgo({ e1: 60, e2: 120 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual([]);
  });

  it('keeps the filter unchanged when one copy is past its window', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A, PUBKEY_B] }];
    const sent = [event('e1', 0, PUBKEY_A), event('e2', 0, PUBKEY_B)];
    // e2 は 2 時間前 → kind 0 の窓（1時間）を超過
    const cachedAt = cachedSecondsAgo({ e1: 60, e2: 7200 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
  });

  it('keeps the filter when a requested author is missing from the cache', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A, PUBKEY_B] }];
    const sent = [event('e1', 0, PUBKEY_A)];
    const cachedAt = cachedSecondsAgo({ e1: 60 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
  });

  it('treats an id with no cached_at entry as stale', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A] }];
    const sent = [event('e1', 0, PUBKEY_A)];

    expect(narrowFiltersByFreshness(filters, sent, new Map(), WINDOWS, NOW)).toEqual(filters);
  });

  it('requires every (kind, pubkey) coordinate of a multi-kind filter', () => {
    const filters: Filter[] = [{ kinds: [0, 3], authors: [PUBKEY_A] }];
    // kind 0 だけ充足。kind 3 が欠けている
    const sent = [event('e1', 0, PUBKEY_A)];
    const cachedAt = cachedSecondsAgo({ e1: 60 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
  });

  it('applies each kind its own window', () => {
    const filters: Filter[] = [{ kinds: [3], authors: [PUBKEY_A] }];
    const sent = [event('e1', 3, PUBKEY_A)];
    // 20 分前: kind 0 の窓（1時間）なら新鮮だが kind 3 の窓（10分）は超過
    const cachedAt = cachedSecondsAgo({ e1: 1200 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
  });

  it('treats an event cached exactly at the window boundary as fresh', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A] }];
    const sent = [event('e1', 0, PUBKEY_A)];
    const cachedAt = cachedSecondsAgo({ e1: 3600 });

    expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual([]);
  });

  it('drops only the satisfied filters of a multi-filter REQ', () => {
    const fresh: Filter = { kinds: [0], authors: [PUBKEY_A] };
    const notes: Filter = { kinds: [1], authors: [PUBKEY_A] };
    const sent = [event('e1', 0, PUBKEY_A), event('e2', 1, PUBKEY_A)];
    const cachedAt = cachedSecondsAgo({ e1: 60, e2: 60 });

    expect(narrowFiltersByFreshness([fresh, notes], sent, cachedAt, WINDOWS, NOW)).toEqual([notes]);
  });

  it('counts coverage across filters (a coordinate delivered once is delivered)', () => {
    // 同じ kind 0 イベントを2つのフィルタが要求する形。1件届いていれば両方充足
    const byAuthor: Filter = { kinds: [0], authors: [PUBKEY_A] };
    const withLimit: Filter = { kinds: [0], authors: [PUBKEY_A], limit: 1 };
    const sent = [event('e1', 0, PUBKEY_A)];
    const cachedAt = cachedSecondsAgo({ e1: 60 });

    expect(narrowFiltersByFreshness([byAuthor, withLimit], sent, cachedAt, WINDOWS, NOW)).toEqual(
      []
    );
  });

  it('returns ineligible filters untouched when nothing was cached', () => {
    const filters: Filter[] = [{ kinds: [1], authors: [PUBKEY_A] }];
    expect(narrowFiltersByFreshness(filters, [], new Map(), WINDOWS, NOW)).toEqual(filters);
  });

  // 判定不能な値は「新鮮」ではなく「古い」に倒れなければならない。素朴な
  // `now - cached > window` 比較は NaN で false になり、逆側に倒れてしまう
  describe('unusable inputs fall out as stale', () => {
    const filters: Filter[] = [{ kinds: [0], authors: [PUBKEY_A] }];
    const sent = [event('e1', 0, PUBKEY_A)];

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a Date', new Date(NOW) as unknown as number],
      ['an ISO string', '2026-07-30T00:00:00Z' as unknown as number],
      ['an object', {} as unknown as number],
      ['null', null as unknown as number],
    ])('treats a cached_at of %s as stale', (_label, cached) => {
      const cachedAt = new Map<string, number>([['e1', cached]]);
      expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
    });

    it('treats a future cached_at as stale (clock skew must not widen the window)', () => {
      const cachedAt = new Map([['e1', NOW + 60_000]]);
      expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, NOW)).toEqual(filters);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['zero', 0],
      ['negative', -1],
    ])('treats a window of %s as stale', (_label, windowSeconds) => {
      // FreshnessGate は公開エクスポートなので、正規化を通らない窓が届きうる
      const windows = new Map([[0, windowSeconds]]);
      const cachedAt = cachedSecondsAgo({ e1: 1 });
      expect(narrowFiltersByFreshness(filters, sent, cachedAt, windows, NOW)).toEqual(filters);
    });

    it('treats a NaN clock as stale', () => {
      const cachedAt = cachedSecondsAgo({ e1: 1 });
      expect(narrowFiltersByFreshness(filters, sent, cachedAt, WINDOWS, Number.NaN)).toEqual(
        filters
      );
    });
  });
});

describe('FreshnessGate', () => {
  /** Storage stub exposing only what the gate touches. */
  function storageWith(getCachedAt?: StorageAdapter['getCachedAt']): StorageAdapter {
    return { getCachedAt } as unknown as StorageAdapter;
  }

  const freshFilter: Filter = { kinds: [0], authors: [PUBKEY_A] };
  const sent = [event('e1', 0, PUBKEY_A)];

  it('skips upstream when the cache is fresh', async () => {
    const getCachedAt = vi.fn().mockResolvedValue(cachedSecondsAgo({ e1: 60 }));
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);

    expect(await gate.filtersForUpstream([freshFilter], sent)).toEqual([]);
    expect(getCachedAt).toHaveBeenCalledWith(['e1']);
  });

  it('forwards upstream when the cache is past its window', async () => {
    const getCachedAt = vi.fn().mockResolvedValue(cachedSecondsAgo({ e1: 7200 }));
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);

    expect(await gate.filtersForUpstream([freshFilter], sent)).toEqual([freshFilter]);
  });

  it('does not touch storage when no filter is eligible', async () => {
    const getCachedAt = vi.fn().mockResolvedValue(new Map());
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);
    const notes: Filter = { kinds: [1], authors: [PUBKEY_A] };

    expect(await gate.filtersForUpstream([notes], sent)).toEqual([notes]);
    expect(getCachedAt).not.toHaveBeenCalled();
  });

  it('does not touch storage when nothing was served from cache', async () => {
    const getCachedAt = vi.fn().mockResolvedValue(new Map());
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);

    expect(await gate.filtersForUpstream([freshFilter], [])).toEqual([freshFilter]);
    expect(getCachedAt).not.toHaveBeenCalled();
  });

  it('only asks about events of a windowed kind', async () => {
    const getCachedAt = vi.fn().mockResolvedValue(cachedSecondsAgo({ e1: 60 }));
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);

    await gate.filtersForUpstream([freshFilter], [...sent, event('e2', 1, PUBKEY_A)]);

    expect(getCachedAt).toHaveBeenCalledWith(['e1']);
  });

  it('fails open when the adapter does not implement getCachedAt', async () => {
    const gate = new FreshnessGate(storageWith(undefined), WINDOWS, () => NOW);

    expect(await gate.filtersForUpstream([freshFilter], sent)).toEqual([freshFilter]);
  });

  it('fails open when getCachedAt rejects', async () => {
    const getCachedAt = vi.fn().mockRejectedValue(new Error('storage down'));
    const gate = new FreshnessGate(storageWith(getCachedAt), WINDOWS, () => NOW);

    expect(await gate.filtersForUpstream([freshFilter], sent)).toEqual([freshFilter]);
  });

  describe('markRevalidated (re-arming the window)', () => {
    /** Storage stub exposing `touchCachedAt`. */
    function storageWithTouch(touchCachedAt: Mock): StorageAdapter {
      return { getCachedAt: vi.fn(), touchCachedAt } as unknown as StorageAdapter;
    }

    it('re-stamps an upstream-confirmed event of a windowed kind', () => {
      const touchCachedAt = vi.fn().mockResolvedValue(1);
      const gate = new FreshnessGate(storageWithTouch(touchCachedAt), WINDOWS, () => NOW);

      gate.markRevalidated(event('e1', 0, PUBKEY_A));

      expect(touchCachedAt).toHaveBeenCalledWith(['e1']);
    });

    it('ignores kinds without a window (a busy regular kind must not hit storage)', () => {
      const touchCachedAt = vi.fn().mockResolvedValue(1);
      const gate = new FreshnessGate(storageWithTouch(touchCachedAt), WINDOWS, () => NOW);

      gate.markRevalidated(event('e1', 1, PUBKEY_A));

      expect(touchCachedAt).not.toHaveBeenCalled();
    });

    it('is a no-op when the adapter does not implement touchCachedAt', () => {
      const gate = new FreshnessGate(storageWith(vi.fn()), WINDOWS, () => NOW);

      expect(() => gate.markRevalidated(event('e1', 0, PUBKEY_A))).not.toThrow();
    });

    it('swallows a rejected touch (read-path bookkeeping must not surface)', async () => {
      const touchCachedAt = vi.fn().mockRejectedValue(new Error('storage down'));
      const gate = new FreshnessGate(storageWithTouch(touchCachedAt), WINDOWS, () => NOW);

      gate.markRevalidated(event('e1', 0, PUBKEY_A));
      // 未処理の rejection にならないことを確認するため microtask を1周させる
      await Promise.resolve();

      expect(touchCachedAt).toHaveBeenCalled();
    });
  });
});
