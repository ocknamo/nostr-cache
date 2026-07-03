import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory } from '../test/utils/fake-web-socket.js';
import { UpstreamConnection } from './upstream-connection.js';

const OPTIONS = {
  connectionTimeout: 5000,
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 60000,
};

function makeEvent(id: string): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind: 1, tags: [], content: '', sig: '' };
}

describe('UpstreamConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a socket and reports connected after onopen', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );

    conn.connect();
    expect(conn.isConnected()).toBe(false);
    fake.last().mockOpen();
    expect(conn.isConnected()).toBe(true);
  });

  it('sends REQ when a subscription is opened on a connected socket', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    fake.last().mockOpen();

    conn.openSubscription('up1', [{ kinds: [1] }]);
    expect(fake.last().sent).toContainEqual(['REQ', 'up1', { kinds: [1] }]);
  });

  it('drops sends while the socket is not open', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    // Not opened yet.
    conn.openSubscription('up1', [{ kinds: [1] }]);
    expect(fake.last().sent).toHaveLength(0);
  });

  it('dispatches EVENT and EOSE messages to handlers', () => {
    const fake = createFakeWebSocketFactory();
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent,
        onEose,
      }
    );
    conn.connect();
    fake.last().mockOpen();

    const event = makeEvent('a');
    fake.last().mockMessage(['EVENT', 'up1', event]);
    fake.last().mockMessage(['EOSE', 'up1']);

    expect(onEvent).toHaveBeenCalledWith('up1', event);
    expect(onEose).toHaveBeenCalledWith('up1');
  });

  it('ignores OK / NOTICE / malformed messages', () => {
    const fake = createFakeWebSocketFactory();
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent,
        onEose,
      }
    );
    conn.connect();
    fake.last().mockOpen();

    fake.last().mockMessage(['OK', 'id', true, '']);
    fake.last().mockMessage(['NOTICE', 'hi']);
    fake.last().onmessage?.(new MessageEvent('message', { data: 'not json' }));

    expect(onEvent).not.toHaveBeenCalled();
    expect(onEose).not.toHaveBeenCalled();
  });

  it('reconnects with backoff and re-sends active subscriptions', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    fake.last().mockOpen();
    conn.openSubscription('up1', [{ kinds: [1] }]);
    expect(fake.sockets).toHaveLength(1);

    // Lose the connection.
    fake.last().mockClose();
    expect(conn.isConnected()).toBe(false);

    // Backoff timer (base 1000ms) fires → new socket constructed.
    vi.advanceTimersByTime(1000);
    expect(fake.sockets).toHaveLength(2);

    // On reopen the active subscription's REQ is re-sent automatically.
    fake.last().mockOpen();
    expect(fake.last().sent).toContainEqual(['REQ', 'up1', { kinds: [1] }]);
  });

  it('reconnects when the connect attempt times out', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    // Never opens; connect timeout (5000ms) elapses.
    vi.advanceTimersByTime(5000);
    // Then the reconnect backoff (1000ms) elapses → a fresh socket.
    vi.advanceTimersByTime(1000);
    expect(fake.sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('stops reconnecting after close()', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    fake.last().mockOpen();
    conn.close();
    expect(conn.isConnected()).toBe(false);

    fake.last().mockClose();
    vi.advanceTimersByTime(60000);
    // No new socket after an explicit close.
    expect(fake.sockets).toHaveLength(1);
  });

  it('sends CLOSE and stops tracking a closed subscription', () => {
    const fake = createFakeWebSocketFactory();
    const conn = new UpstreamConnection(
      'wss://relay',
      { ...OPTIONS, webSocketFactory: fake.factory },
      {
        onEvent: vi.fn(),
        onEose: vi.fn(),
      }
    );
    conn.connect();
    fake.last().mockOpen();
    conn.openSubscription('up1', [{ kinds: [1] }]);
    conn.closeSubscription('up1');
    expect(fake.last().sent).toContainEqual(['CLOSE', 'up1']);

    // After reconnect the closed subscription must not be re-sent.
    fake.last().mockClose();
    vi.advanceTimersByTime(1000);
    fake.last().mockOpen();
    expect(fake.last().sent).not.toContainEqual(['REQ', 'up1', { kinds: [1] }]);
  });
});
