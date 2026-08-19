// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import { NostrCacheRelay, WebSocketServerEmulator } from '@nostr-cache/cache-relay/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEvent } from '../test-fixtures.ts';
import {
  DEFAULT_CACHE_STRATEGY,
  DEFAULT_FOLLOWS_FRESHNESS,
  DEFAULT_PROFILE_FRESHNESS,
  DEFAULT_STORAGE_MAX_SIZE,
  type RelayHost,
  acquireRelayHost,
  getRelayHostRefCount,
} from './relay-host.ts';

/**
 * The shared relay host is the piece most likely to break the embedding page:
 * it patches `globalThis.WebSocket`, so a botched refcount leaves the host page
 * with a dead WebSocket constructor. These specs pin that contract down.
 */
describe('acquireRelayHost', () => {
  const originalWebSocket = globalThis.WebSocket;
  const acquired: RelayHost[] = [];

  async function acquire(config?: Parameters<typeof acquireRelayHost>[0]): Promise<RelayHost> {
    const host = await acquireRelayHost(config ?? { dbName: `test-${crypto.randomUUID()}` });
    acquired.push(host);
    return host;
  }

  afterEach(async () => {
    // Release anything a failing assertion left behind, then make sure the
    // global really is back to its original value for the next spec.
    for (const host of acquired.splice(0)) {
      await host.release();
    }
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  it('starts the relay and patches the global WebSocket', async () => {
    const host = await acquire();

    expect(globalThis.WebSocket).not.toBe(originalWebSocket);
    expect(host.interceptUrl).toBe('ws://nostr-cache.invalid');
    expect(getRelayHostRefCount()).toBe(1);
  });

  it('restores the global WebSocket when the only holder releases', async () => {
    const host = await acquire();
    await host.release();

    expect(globalThis.WebSocket).toBe(originalWebSocket);
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('shares one relay between holders and tears it down only on the last release', async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const first = await acquire({ dbName });
    const second = await acquire({ dbName });

    expect(second.relay).toBe(first.relay);
    expect(second.metrics).toBe(first.metrics);
    expect(getRelayHostRefCount()).toBe(2);

    await first.release();
    // Still one widget using it: tearing down here would kill its subscription
    // and leave the page's WebSocket patched by a relay nobody owns.
    expect(globalThis.WebSocket).not.toBe(originalWebSocket);
    expect(getRelayHostRefCount()).toBe(1);

    await second.release();
    expect(globalThis.WebSocket).toBe(originalWebSocket);
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('treats a repeated release from the same holder as a no-op', async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const first = await acquire({ dbName });
    const second = await acquire({ dbName });

    await first.release();
    await first.release();

    // The double release must not have consumed second's claim.
    expect(getRelayHostRefCount()).toBe(1);
    expect(globalThis.WebSocket).not.toBe(originalWebSocket);

    await second.release();
    expect(globalThis.WebSocket).toBe(originalWebSocket);
  });

  it('boots a single relay for concurrent acquisitions', async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      acquireRelayHost({ dbName }),
      acquireRelayHost({ dbName }),
    ]);
    acquired.push(first, second);

    expect(second.relay).toBe(first.relay);
    expect(getRelayHostRefCount()).toBe(2);
  });

  it('starts a fresh relay after every holder has released', async () => {
    const first = await acquire();
    await first.release();
    const second = await acquire();

    expect(second.relay).not.toBe(first.relay);
    expect(globalThis.WebSocket).not.toBe(originalWebSocket);
  });

  it('reuses the running relay and warns when a later widget asks for other settings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbName = `test-${crypto.randomUUID()}`;
    const first = await acquire({ dbName });
    const second = await acquire({ dbName, upstreamRelays: ['wss://relay.example'] });

    expect(second.relay).toBe(first.relay);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('upstreamRelays');
  });

  it('does not warn when a later widget asks for identical settings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbName = `test-${crypto.randomUUID()}`;
    await acquire({ dbName });
    await acquire({ dbName });

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports no connected upstreams when configured without any', async () => {
    const host = await acquire();

    expect(host.getConnectedUpstreams()).toBe(0);
  });

  it('shuts the emulator down when startup fails', async () => {
    // relay.connect() patches the global WebSocket before it can fail on
    // anything after that, so a failed start must still undo the patch —
    // otherwise the next host captures a patched constructor as its "original".
    const stop = vi.spyOn(WebSocketServerEmulator.prototype, 'stop');
    vi.spyOn(NostrCacheRelay.prototype, 'connect').mockRejectedValueOnce(new Error('boom'));

    await expect(acquireRelayHost({ dbName: `test-${crypto.randomUUID()}` })).rejects.toThrow(
      'boom'
    );

    expect(stop).toHaveBeenCalled();
    expect(globalThis.WebSocket).toBe(originalWebSocket);
    expect(getRelayHostRefCount()).toBe(0);
  });

  it('starts cleanly after a failed startup', async () => {
    vi.spyOn(NostrCacheRelay.prototype, 'connect').mockRejectedValueOnce(new Error('boom'));
    await expect(acquireRelayHost({ dbName: `test-${crypto.randomUUID()}` })).rejects.toThrow(
      'boom'
    );

    const host = await acquire();
    await host.release();

    // The retry must have captured the real original, not the leftover patch.
    expect(globalThis.WebSocket).toBe(originalWebSocket);
  });

  it('waits for a host that is still stopping before starting the next one', async () => {
    const first = await acquire({ dbName: `test-${crypto.randomUUID()}` });

    // Deliberately not awaited: this is what the demo's relay restart does when
    // it swaps upstream relays.
    const releasing = first.release();
    const second = await acquireRelayHost({ dbName: `test-${crypto.randomUUID()}` });
    acquired.push(second);
    await releasing;

    expect(second.relay).not.toBe(first.relay);
    // The new host must be live, i.e. it patched a global that had really been
    // restored first.
    expect(globalThis.WebSocket).not.toBe(originalWebSocket);

    await second.release();
    expect(globalThis.WebSocket).toBe(originalWebSocket);
  });

  it('serves a NIP-01 client over the intercepted URL without touching the network', async () => {
    const host = await acquire();

    const socket = new WebSocket(host.interceptUrl);
    const eose = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for EOSE')), 5000);
      socket.onopen = () => socket.send(JSON.stringify(['REQ', 'sub', { kinds: [1], limit: 10 }]));
      socket.onmessage = (message) => {
        const parsed = JSON.parse(String(message.data));
        if (parsed[0] === 'EOSE' && parsed[1] === 'sub') {
          clearTimeout(timeout);
          resolve();
        }
      };
    });

    await expect(eose).resolves.toBeUndefined();
    socket.close();
  });

  /**
   * Losing the ceiling would go unnoticed until someone's IndexedDB had grown
   * for a month, so pin what reaches the relay.
   */
  describe('cache ceiling', () => {
    function evictionOptions(host: RelayHost): {
      storageMaxSize?: number;
      cacheStrategy?: string;
      cachePriority?: { pubkeys?: string[]; kinds?: number[] };
    } {
      return (host.relay as unknown as { options: Record<string, never> }).options;
    }

    it('bounds the cache by default', async () => {
      const host = await acquire();

      expect(evictionOptions(host).storageMaxSize).toBe(DEFAULT_STORAGE_MAX_SIZE);
      expect(evictionOptions(host).cacheStrategy).toBe(DEFAULT_CACHE_STRATEGY);
    });

    it('keeps profiles and follow lists to the end of the eviction order', async () => {
      const host = await acquire();

      expect(evictionOptions(host).cachePriority).toEqual({ pubkeys: [], kinds: [0, 3] });
    });

    it('accepts an overridden ceiling', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, storageMaxSize: 10 });

      expect(evictionOptions(host).storageMaxSize).toBe(10);
    });

    it('accepts an overridden eviction strategy', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, cacheStrategy: 'FIFO' });

      expect(evictionOptions(host).cacheStrategy).toBe('FIFO');
    });

    it('lets the cache grow unbounded when the ceiling is switched off', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, storageMaxSize: 0 });

      expect(evictionOptions(host).storageMaxSize).toBe(0);
    });

    it('evicts down to the ceiling as events are saved', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, storageMaxSize: 2 });

      for (const index of [1, 2, 3]) {
        await host.relay.publishEvent(
          makeEvent({ id: `${index}`.repeat(64), created_at: 1_700_000_000 + index })
        );
      }

      expect(await host.storage.count()).toBe(2);
    });

    it('evicts notes rather than the profile they belong to', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, storageMaxSize: 2 });

      // The profile goes in first, so every eviction order that ignores the
      // priority rules — LRU, FIFO and LFU alike — would pick it as the victim.
      await host.relay.publishEvent(makeEvent({ id: '0'.repeat(64), kind: 0, content: '{}' }));
      for (const index of [1, 2]) {
        await host.relay.publishEvent(
          makeEvent({ id: `${index}`.repeat(64), created_at: 1_700_000_000 + index })
        );
      }

      expect(await host.storage.count()).toBe(2);
      expect(await host.storage.getEvents([{ kinds: [0] }])).toHaveLength(1);
    });
  });

  /**
   * The kind 0 freshness window is what keeps the timeline's profile lookups
   * from forwarding a REQ upstream on every re-subscribe. Nothing else in the
   * package would notice if this stopped being passed to the relay, so the
   * wiring itself is what these pin down.
   */
  describe('freshness windows', () => {
    /** The relay only builds a gate when at least one window was configured. */
    function hasFreshnessGate(host: RelayHost): boolean {
      return (host.relay as unknown as { freshnessGate?: unknown }).freshnessGate !== undefined;
    }

    /** Seconds the relay was actually given for a kind, if any. */
    function windowForKind(host: RelayHost, kind: number): number | undefined {
      const gate = (host.relay as unknown as { freshnessGate?: { windows: Map<number, number> } })
        .freshnessGate;
      return gate?.windows.get(kind);
    }

    it('configures a day-long kind 0 window by default', async () => {
      const host = await acquire();

      expect(hasFreshnessGate(host)).toBe(true);
      expect(windowForKind(host, 0)).toBe(DEFAULT_PROFILE_FRESHNESS);
      expect(DEFAULT_PROFILE_FRESHNESS).toBe(24 * 60 * 60);
    });

    it('configures an hour-long kind 3 window by default', async () => {
      const host = await acquire();

      // This is what makes a follow timeline's second load skip the upstream
      // round trip it needs before it can even build the timeline REQ.
      expect(windowForKind(host, 3)).toBe(DEFAULT_FOLLOWS_FRESHNESS);
      expect(DEFAULT_FOLLOWS_FRESHNESS).toBe(60 * 60);
    });

    it('accepts an overridden window', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, profileFreshness: 30 });

      expect(windowForKind(host, 0)).toBe(30);
    });

    it('accepts an overridden follow-list window', async () => {
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, followsFreshness: 45 });

      expect(windowForKind(host, 3)).toBe(45);
    });

    it('treats a non-positive window as "no window" rather than failing to start', async () => {
      // The relay rejects a non-positive window outright, which would take the
      // whole widget down — a surprising way to spell "turn this off".
      const host = await acquire({
        dbName: `test-${crypto.randomUUID()}`,
        profileFreshness: 0,
        followsFreshness: 0,
      });

      expect(hasFreshnessGate(host)).toBe(false);
    });

    it('keeps the kind 3 window when profiles are switched off', async () => {
      // The two windows are independent switches. Assembling the record as one
      // expression made "no profile window" delete kind 3's as well.
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, profileFreshness: 0 });

      expect(hasFreshnessGate(host)).toBe(true);
      expect(windowForKind(host, 0)).toBeUndefined();
      expect(windowForKind(host, 3)).toBe(DEFAULT_FOLLOWS_FRESHNESS);
    });

    it('keeps the kind 0 window when follow lists are switched off', async () => {
      // A non-positive window must be omitted, not passed through as `{3: 0}`:
      // the relay throws on one, and `relay.connect()` failing means the widget
      // never starts at all.
      const host = await acquire({ dbName: `test-${crypto.randomUUID()}`, followsFreshness: 0 });

      expect(hasFreshnessGate(host)).toBe(true);
      expect(windowForKind(host, 0)).toBe(DEFAULT_PROFILE_FRESHNESS);
      expect(windowForKind(host, 3)).toBeUndefined();
    });
  });
});
