import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { UpstreamRelayPool } from './upstream-relay-pool.js';

function makeEvent(id: string): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind: 1, tags: [], content: '', sig: '' };
}

describe('UpstreamRelayPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fans REQ out to every connection', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();

    pool.openSubscription('up1', [{ kinds: [1] }]);
    expect(fake.sockets[0].sent).toContainEqual(['REQ', 'up1', { kinds: [1] }]);
    expect(fake.sockets[1].sent).toContainEqual(['REQ', 'up1', { kinds: [1] }]);
  });

  it('fires aggregated EOSE only after every connected relay answers', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    fake.sockets[0].mockMessage(['EOSE', 'up1']);
    expect(onEose).not.toHaveBeenCalled();

    fake.sockets[1].mockMessage(['EOSE', 'up1']);
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('fires EOSE immediately (next tick) when no relay is connected', async () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    // socket never opened → no relay connected
    pool.openSubscription('up1', [{ kinds: [1] }]);

    await vi.runAllTicks();
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('only counts relays connected at subscription time (late relay does not stall)', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    // Only relay A is connected when the subscription opens.
    fake.sockets[0].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    // Relay B connects late; it is not part of the EOSE aggregate.
    fake.sockets[1].mockOpen();

    fake.sockets[0].mockMessage(['EOSE', 'up1']);
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('fires aggregated EOSE when a still-pending relay disconnects before EOSE', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    // Relay A answers; only relay B is still pending.
    fake.sockets[0].mockMessage(['EOSE', 'up1']);
    expect(onEose).not.toHaveBeenCalled();

    // Relay B drops before it can answer → it no longer owes EOSE, so the
    // aggregate completes instead of stalling until the coordinator timeout.
    fake.sockets[1].mockClose();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('does not fire EOSE early when a disconnecting relay is not the last pending', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    // Relay A drops while relay B is still pending → no EOSE yet.
    fake.sockets[0].mockClose();
    expect(onEose).not.toHaveBeenCalled();

    // Relay B then answers → aggregate completes.
    fake.sockets[1].mockMessage(['EOSE', 'up1']);
    expect(onEose).toHaveBeenCalledTimes(1);
  });

  it('forwards upstream events with the originating relay url', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    const onEvent = vi.fn();
    pool.onEvent(onEvent);
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    const event = makeEvent('a');
    fake.sockets[1].mockMessage(['EVENT', 'up1', event]);
    expect(onEvent).toHaveBeenCalledWith('up1', event, 'wss://b');
  });

  it('publishes to every connection', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    pool.start();
    fake.sockets[0].mockOpen();
    fake.sockets[1].mockOpen();

    const event = makeEvent('x');
    pool.publish(event);
    expect(fake.sockets[0].sent).toContainEqual(['EVENT', event]);
    expect(fake.sockets[1].sent).toContainEqual(['EVENT', event]);
  });

  it('closeSubscription sends CLOSE and drops any pending EOSE', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a'], { webSocketFactory: fake.factory });
    const onEose = vi.fn();
    pool.onEose(onEose);
    pool.start();
    fake.sockets[0].mockOpen();
    pool.openSubscription('up1', [{ kinds: [1] }]);

    pool.closeSubscription('up1');
    expect(fake.sockets[0].sent).toContainEqual(['CLOSE', 'up1']);

    // A late EOSE for the closed sub must not fire the callback.
    fake.sockets[0].mockMessage(['EOSE', 'up1']);
    expect(onEose).not.toHaveBeenCalled();
  });

  it('reports the connected count', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b'], { webSocketFactory: fake.factory });
    pool.start();
    expect(pool.getConnectedCount()).toBe(0);
    fake.sockets[0].mockOpen();
    expect(pool.getConnectedCount()).toBe(1);
    fake.sockets[1].mockOpen();
    expect(pool.getConnectedCount()).toBe(2);
  });

  it('caps the number of relays at maxRelays', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://b', 'wss://c'], {
      webSocketFactory: fake.factory,
      maxRelays: 2,
    });
    pool.start();
    expect(fake.sockets).toHaveLength(2);
  });

  it('de-duplicates repeated relay urls', () => {
    const fake = createFakeWebSocketFactory();
    const pool = new UpstreamRelayPool(['wss://a', 'wss://a'], { webSocketFactory: fake.factory });
    pool.start();
    expect(fake.sockets).toHaveLength(1);
  });
});
