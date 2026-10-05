import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ValidationStatus } from '../storage/storage-adapter.js';
import { createMockStorage } from '../test/utils/mock-storage.js';
import { MAX_PREFETCH_AUTHORS, RelayListResolver } from './relay-list-resolver.js';

const WINDOW = 3600;
const pk = (n: number) => n.toString(16).padStart(64, '0');

function relayList(pubkey: string, createdAt: number, url = 'wss://a.example.com'): NostrEvent {
  return {
    id: `${pubkey.slice(-4)}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 10002,
    tags: [['r', url]],
    content: '',
    sig: '',
  };
}

/** 保存済みの 10002 を返す最小のストレージ。ingest がここへ書く。 */
function setup({
  stored = [] as NostrEvent[],
  cachedAt = new Map<string, number>(),
  status = 'validated' as ValidationStatus,
  upstream = [] as NostrEvent[],
  withCachedAt = true,
  now = 1_000_000,
  batchSize = undefined as number | undefined,
} = {}) {
  const rows = new Map(stored.map((event) => [event.pubkey, event]));
  const storage = createMockStorage({
    getEvents: vi.fn(async (filters: Filter[]) => {
      const authors = new Set(filters[0].authors);
      return [...rows.values()].filter((event) => authors.has(event.pubkey));
    }),
    getValidationStatus: vi.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, status] as const))
    ),
    ...(withCachedAt
      ? {
          getCachedAt: vi.fn(async (ids: string[]) => {
            const found = new Map<string, number>();
            for (const id of ids) {
              const at = cachedAt.get(id);
              if (at !== undefined) {
                found.set(id, at);
              }
            }
            return found;
          }),
        }
      : {}),
  });
  const fetch = vi.fn(async (filter: Filter) => ({
    events: upstream.filter((event) => filter.authors?.includes(event.pubkey)),
    answered: 1,
  }));
  const ingest = vi.fn(async (event: NostrEvent) => {
    rows.set(event.pubkey, event);
    cachedAt.set(event.id, now);
  });
  const resolver = new RelayListResolver(
    { storage, fetch, ingest },
    { freshnessSeconds: WINDOW, now: () => now, batchSize }
  );
  return { resolver, storage, fetch, ingest, rows };
}

describe('RelayListResolver.resolve', () => {
  it('fetches only authors whose list is missing or stale', async () => {
    const fresh = relayList(pk(1), 10);
    const stale = relayList(pk(2), 10);
    const { resolver, fetch } = setup({
      stored: [fresh, stale],
      cachedAt: new Map([
        [fresh.id, 1_000_000 - 1000],
        [stale.id, 1_000_000 - (WINDOW + 1) * 1000],
      ]),
    });

    await resolver.resolve([pk(1), pk(2), pk(3)]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual({ kinds: [10002], authors: [pk(2), pk(3)] });
  });

  it('ingests one newest version per author, in order, ignoring what was not asked for', async () => {
    const { resolver, ingest } = setup({
      upstream: [
        relayList(pk(1), 5),
        relayList(pk(1), 9),
        relayList(pk(1), 7),
        relayList(pk(2), 3),
        { ...relayList(pk(1), 20), kind: 3 },
      ],
    });

    await resolver.resolve([pk(1)]);

    expect(ingest.mock.calls.map(([event]) => event.created_at)).toEqual([9]);
  });

  it('does not ask again within the window, even for authors that have no list', async () => {
    const { resolver, fetch } = setup();

    await resolver.resolve([pk(1)]);
    await resolver.resolve([pk(1)]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight fetch with a concurrent caller', async () => {
    const { resolver, fetch } = setup({ upstream: [relayList(pk(1), 1)] });

    await Promise.all([resolver.resolve([pk(1)]), resolver.resolve([pk(1)])]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('splits large requests into sequential batches', async () => {
    const { resolver, fetch } = setup({ batchSize: 2 });
    let running = 0;
    let maxRunning = 0;
    fetch.mockImplementation(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      return { events: [], answered: 1 };
    });

    await resolver.resolve([pk(1), pk(2), pk(3), pk(4), pk(5)]);

    expect(fetch.mock.calls.map(([filter]) => filter.authors)).toEqual([
      [pk(1), pk(2)],
      [pk(3), pk(4)],
      [pk(5)],
    ]);
    expect(maxRunning).toBe(1);
  });

  it('treats everyone as stale when the storage cannot tell cache times', async () => {
    const { resolver, fetch } = setup({ stored: [relayList(pk(1), 1)], withCachedAt: false });

    await resolver.resolve([pk(1)]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next call when no index relay answered', async () => {
    const { resolver, fetch } = setup();
    fetch.mockResolvedValueOnce({ events: [], answered: 0 });

    await resolver.resolve([pk(1)]);
    await resolver.resolve([pk(1)]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('asks again after being stopped mid-fetch, and ingests nothing from it', async () => {
    const { resolver, fetch, ingest } = setup();
    fetch.mockImplementationOnce(async () => {
      resolver.stop();
      return { events: [relayList(pk(1), 1)], answered: 1 };
    });

    await resolver.resolve([pk(1)]);
    resolver.start();
    await resolver.resolve([pk(1)]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledTimes(0);
  });

  it('skips malformed pubkeys and normalizes case', async () => {
    const { resolver, fetch } = setup();

    await resolver.resolve(['nope', pk(10).toUpperCase(), pk(10)]);

    expect(fetch.mock.calls[0][0].authors).toEqual([pk(10)]);
  });

  it('does nothing once stopped', async () => {
    const { resolver, fetch } = setup();
    resolver.stop();

    await resolver.resolve([pk(1)]);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('RelayListResolver.prefetchFollows', () => {
  const followList = (id: string, follows: string[]): NostrEvent => ({
    id,
    pubkey: pk(99),
    created_at: 0,
    kind: 3,
    tags: follows.map((p) => ['p', p]),
    content: '',
    sig: '',
  });

  it('resolves the follows of a kind 3, once per event', async () => {
    const { resolver, fetch } = setup();
    const resolve = vi.spyOn(resolver, 'resolve');

    resolver.prefetchFollows(followList('k3', [pk(1), pk(2)]));
    resolver.prefetchFollows(followList('k3', [pk(1), pk(2)]));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith([pk(1), pk(2)]);
  });

  it('prefetches the same list again once the window has passed', async () => {
    let now = 1_000_000;
    const storage = createMockStorage();
    const fetch = vi.fn(async () => ({ events: [], answered: 1 }));
    const resolver = new RelayListResolver(
      { storage, fetch, ingest: vi.fn() },
      { freshnessSeconds: WINDOW, now: () => now }
    );
    const resolve = vi.spyOn(resolver, 'resolve');

    resolver.prefetchFollows(followList('k3', [pk(1)]));
    now += (WINDOW + 1) * 1000;
    resolver.prefetchFollows(followList('k3', [pk(1)]));

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('caps how many authors one follow list prefetches', () => {
    const { resolver } = setup();
    const resolve = vi.spyOn(resolver, 'resolve').mockResolvedValue();

    resolver.prefetchFollows(
      followList(
        'big',
        Array.from({ length: MAX_PREFETCH_AUTHORS + 10 }, (_, i) => pk(i + 1))
      )
    );

    expect(resolve.mock.calls[0][0]).toHaveLength(MAX_PREFETCH_AUTHORS);
  });

  it('stops queueing once enough authors are already waiting', async () => {
    const { resolver, fetch } = setup();
    fetch.mockImplementation(() => new Promise(() => {}));
    resolver.prefetchFollows(
      followList(
        'first',
        Array.from({ length: MAX_PREFETCH_AUTHORS }, (_, i) => pk(i + 1))
      )
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const resolve = vi.spyOn(resolver, 'resolve');

    resolver.prefetchFollows(followList('second', [pk(99_999)]));

    expect(resolve).not.toHaveBeenCalled();
  });

  it('neither prefetches nor remembers a list while stopped', () => {
    const { resolver } = setup();
    const resolve = vi.spyOn(resolver, 'resolve').mockResolvedValue();

    resolver.stop();
    resolver.prefetchFollows(followList('k3', [pk(1)]));
    resolver.start();
    resolver.prefetchFollows(followList('k3', [pk(1)]));

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('ignores other kinds', () => {
    const { resolver } = setup();
    const resolve = vi.spyOn(resolver, 'resolve');

    resolver.prefetchFollows({ ...followList('k1', [pk(1)]), kind: 1 });

    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('RelayListResolver.lookup', () => {
  it('parses validated lists', async () => {
    const { resolver } = setup({ stored: [relayList(pk(1), 1, 'wss://w.example.com')] });

    const lists = await resolver.lookup([pk(1), pk(2)]);

    expect(lists).toEqual(
      new Map([[pk(1), { read: ['wss://w.example.com'], write: ['wss://w.example.com'] }]])
    );
  });

  it('withholds lists that are not validated', async () => {
    const { resolver } = setup({ stored: [relayList(pk(1), 1)], status: 'pending' });

    expect((await resolver.lookup([pk(1)])).size).toBe(0);
  });
});
