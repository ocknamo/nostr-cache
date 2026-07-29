// fake-indexeddb provides an in-memory IndexedDB so DexieStorage works in Node.
import 'fake-indexeddb/auto';
import { NostrCacheRelay, WebSocketServerEmulator } from '@nostr-cache/cache-relay/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RelayHost, acquireRelayHost, getRelayHostRefCount } from './relay-host.ts';

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
});
