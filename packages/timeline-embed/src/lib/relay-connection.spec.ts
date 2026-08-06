import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from './relay-connection.ts';
import { RelayConnection } from './relay-connection.ts';

const RELAY_URL = 'ws://nostr-cache.invalid';

/**
 * Minimal WebSocket stand-in with manual event triggers.
 *
 * Only `addEventListener` is implemented, because that is all rx-nostr uses —
 * it never touches the `on*` properties — and the close event carries the
 * status code the caller passed, as a real socket does. rx-nostr reads that
 * code to tell its own deliberate closes from a connection that dropped.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, callback: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(callback as (event: unknown) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, callback: (event: never) => void): void {
    this.listeners.get(type)?.delete(callback as (event: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3; // CLOSED
    this.emit('close', { type: 'close', code, reason: '' });
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.emit('open', { type: 'open' });
  }

  simulateMessage(message: unknown): void {
    this.simulateRawMessage(JSON.stringify(message));
  }

  simulateRawMessage(data: string): void {
    this.emit('message', { type: 'message', data });
  }

  /** Drop the connection the way a relay going away does. */
  simulateServerClose(): void {
    this.close(1006);
  }

  /** Everything the connection has sent, parsed back into NIP-01 messages. */
  get messages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** The wire subscription ID rx-nostr derives from a caller-supplied one. */
function wireSubId(subId: string): string {
  return `${subId}:0`;
}

function createConnection(options: ConstructorParameters<typeof RelayConnection>[0] = {}) {
  FakeWebSocket.instances = [];
  return new RelayConnection({
    ...options,
    webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
  });
}

/**
 * rx-nostr opens the socket synchronously, so the instance exists as soon as
 * connect() has been called.
 */
async function createOpenConnection(
  options: ConstructorParameters<typeof RelayConnection>[0] = {}
) {
  const connection = createConnection(options);
  const promise = connection.connect(RELAY_URL);
  const socket = FakeWebSocket.instances[0];
  socket.simulateOpen();
  await promise;
  return { connection, socket };
}

/**
 * Let rx-nostr's internal promises settle.
 *
 * REQs are dispatched through a queue that consults (skipped) NIP-11 limits,
 * and events are delivered through an async filter, so neither is synchronous
 * with the call that triggered it.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function sampleEvent(id: string, createdAt = 1000): NostrEvent {
  return {
    id,
    pubkey: 'pub',
    created_at: createdAt,
    kind: 1,
    tags: [],
    content: `content-${id}`,
    sig: 'sig',
  };
}

describe('RelayConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect()', () => {
    it('resolves on open and reports status transitions', async () => {
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect(RELAY_URL);
      expect(statuses).toEqual(['connecting']);

      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      expect(statuses).toEqual(['connecting', 'connected']);
      expect(connection.isConnected).toBe(true);
    });

    it('retries a first attempt that fails, and resolves when one lands', async () => {
      vi.useFakeTimers();
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateServerClose();

      // A failed first attempt is not the caller's problem: rx-nostr puts it on
      // the same retry ladder as any other drop, so connect() waits it out.
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
      expect(statuses).toContain('reconnecting');

      FakeWebSocket.instances.at(-1)?.simulateOpen();
      await expect(promise).resolves.toBeUndefined();
      expect(connection.isConnected).toBe(true);
    });

    it('rejects once rx-nostr has spent its retries', async () => {
      vi.useFakeTimers();
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect(RELAY_URL);
      // Fail every attempt, including each retry, until the ladder runs out.
      for (let i = 0; i < 20; i++) {
        FakeWebSocket.instances.at(-1)?.simulateServerClose();
        await vi.advanceTimersByTimeAsync(60_000);
      }

      await expect(promise).rejects.toThrow('Failed to connect');
      expect(statuses.at(-1)).toBe('error');
      expect(connection.isConnected).toBe(false);

      // rx-nostr's default ladder is five attempts, so the retries really are
      // bounded rather than this having simply run out of patience.
      const settled = FakeWebSocket.instances.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(FakeWebSocket.instances).toHaveLength(settled);
      expect(settled).toBe(6); // the first attempt plus five retries
    });
  });

  describe('subscribe() / unsubscribe()', () => {
    it('sends REQ with the subscription ID and filters', async () => {
      const { connection, socket } = await createOpenConnection();

      connection.subscribe('sub-1', [{ kinds: [1], limit: 10 }], { onEvent: vi.fn() });
      await flush();

      expect(socket.messages).toEqual([['REQ', wireSubId('sub-1'), { kinds: [1], limit: 10 }]]);
    });

    it('sends CLOSE and stops routing after unsubscribe', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });
      await flush();

      connection.unsubscribe('sub-1');
      expect(socket.messages[1]).toEqual(['CLOSE', wireSubId('sub-1')]);

      socket.simulateMessage(['EVENT', wireSubId('sub-1'), sampleEvent('a')]);
      await flush();
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('does not send CLOSE for unknown subscription IDs', async () => {
      const { connection, socket } = await createOpenConnection();
      connection.unsubscribe('nope');
      await flush();
      expect(socket.sent).toEqual([]);
    });
  });

  describe('message routing', () => {
    it('routes EVENT to the matching subscription only', async () => {
      const { connection, socket } = await createOpenConnection();
      const first = vi.fn();
      const second = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent: first });
      connection.subscribe('sub-2', [{}], { onEvent: second });
      await flush();

      const event = sampleEvent('a');
      socket.simulateMessage(['EVENT', wireSubId('sub-1'), event]);
      await flush();

      expect(first).toHaveBeenCalledWith(event);
      expect(second).not.toHaveBeenCalled();
    });

    it('ignores EVENT for unknown subscriptions', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });
      await flush();

      socket.simulateMessage(['EVENT', 'unknown', sampleEvent('a')]);
      await flush();

      expect(onEvent).not.toHaveBeenCalled();
    });

    it('routes EOSE to the subscription', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEose = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent: vi.fn(), onEose });
      await flush();

      socket.simulateMessage(['EOSE', wireSubId('sub-1')]);
      expect(onEose).toHaveBeenCalledTimes(1);
    });

    it('routes CLOSED, removes the subscription, and passes the reason', async () => {
      const { connection, socket } = await createOpenConnection();
      const onClosed = vi.fn();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent, onClosed });
      await flush();

      socket.simulateMessage(['CLOSED', wireSubId('sub-1'), 'shutting down']);
      expect(onClosed).toHaveBeenCalledWith('shutting down');

      socket.simulateMessage(['EVENT', wireSubId('sub-1'), sampleEvent('a')]);
      await flush();
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('routes NOTICE and OK to connection-level callbacks', async () => {
      const onNotice = vi.fn();
      const onOk = vi.fn();
      const { socket } = await createOpenConnection({ onNotice, onOk });

      socket.simulateMessage(['NOTICE', 'be careful']);
      socket.simulateMessage(['OK', 'event-id', true, '']);

      expect(onNotice).toHaveBeenCalledWith('be careful');
      expect(onOk).toHaveBeenCalledWith('event-id', true, '');
    });

    it('silently ignores malformed and unknown messages', async () => {
      const onNotice = vi.fn();
      const onOk = vi.fn();
      const { connection, socket } = await createOpenConnection({ onNotice, onOk });
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });
      await flush();

      socket.simulateRawMessage('not json');
      socket.simulateMessage({ not: 'an array' });
      socket.simulateMessage(['UNKNOWN', 'x']);
      socket.simulateMessage([42]);
      await flush();

      // Junk on the wire must not reach any handler, and must leave the
      // connection able to carry on.
      expect(onEvent).not.toHaveBeenCalled();
      expect(onNotice).not.toHaveBeenCalled();
      expect(onOk).not.toHaveBeenCalled();
      socket.simulateMessage(['EVENT', wireSubId('sub-1'), sampleEvent('a')]);
      await flush();
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection', () => {
    it('reopens the socket and re-sends open REQs after the relay goes away', async () => {
      vi.useFakeTimers();
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      connection.subscribe('sub-1', [{ kinds: [1] }], { onEvent: vi.fn() });
      await flush();

      FakeWebSocket.instances[0].simulateServerClose();
      expect(connection.isConnected).toBe(false);
      expect(statuses).toContain('reconnecting');

      // The backoff ladder starts at a second.
      await vi.advanceTimersByTimeAsync(5_000);
      const reopened = FakeWebSocket.instances[1];
      expect(reopened).toBeDefined();

      reopened.simulateOpen();
      await flush();

      expect(reopened.messages).toEqual([['REQ', wireSubId('sub-1'), { kinds: [1] }]]);
      expect(connection.isConnected).toBe(true);
    });

    it('delivers events on the reconnected socket', async () => {
      vi.useFakeTimers();
      const connection = createConnection();
      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });
      await flush();

      FakeWebSocket.instances[0].simulateServerClose();
      await vi.advanceTimersByTimeAsync(5_000);
      const reopened = FakeWebSocket.instances[1];
      reopened.simulateOpen();
      await flush();

      const event = sampleEvent('a');
      reopened.simulateMessage(['EVENT', wireSubId('sub-1'), event]);
      await flush();

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('sends a REQ issued while the socket is down once it is back', async () => {
      vi.useFakeTimers();
      const connection = createConnection();
      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      FakeWebSocket.instances[0].simulateServerClose();
      connection.subscribe('sub-1', [{ kinds: [1] }], { onEvent: vi.fn() });
      await flush();

      await vi.advanceTimersByTimeAsync(5_000);
      const reopened = FakeWebSocket.instances[1];
      reopened.simulateOpen();
      await flush();

      expect(reopened.messages).toContainEqual(['REQ', wireSubId('sub-1'), { kinds: [1] }]);
    });
  });

  describe('publish()', () => {
    it('sends EVENT with the event payload', async () => {
      const { connection, socket } = await createOpenConnection();
      const event = sampleEvent('a');

      connection.publish(event);
      await flush();

      expect(socket.messages).toEqual([['EVENT', event]]);
    });

    it("reports the relay's OK for a published event", async () => {
      const onOk = vi.fn();
      const { connection, socket } = await createOpenConnection({ onOk });
      const event = sampleEvent('a');

      connection.publish(event);
      await flush();
      socket.simulateMessage(['OK', event.id, true, '']);

      expect(onOk).toHaveBeenCalledWith(event.id, true, '');
    });

    it('does not hold anything open waiting for an OK that never comes', async () => {
      vi.useFakeTimers();
      const connection = createConnection();
      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      const idle = vi.getTimerCount();
      connection.publish(sampleEvent('a'));
      await flush();

      // The send completes once the EVENT is out, so publishing leaves nothing
      // of its own ticking. Waiting for the OK instead — rx-nostr's default —
      // arms its 30s timeout per published event and holds the subscription
      // open until then.
      expect(vi.getTimerCount()).toBe(idle);
    });
  });

  describe('disconnect()', () => {
    it('closes the socket, clears subscriptions, and reports disconnected', async () => {
      const statuses: ConnectionStatus[] = [];
      const { connection, socket } = await createOpenConnection({
        onStatusChange: (s) => statuses.push(s),
      });
      connection.subscribe('sub-1', [{}], { onEvent: vi.fn() });
      await flush();

      connection.disconnect();

      expect(socket.readyState).toBe(3);
      expect(connection.isConnected).toBe(false);
      expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
    });

    it('does not reconnect after an explicit disconnect', async () => {
      vi.useFakeTimers();
      const connection = createConnection();
      const promise = connection.connect(RELAY_URL);
      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      connection.disconnect();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('does not crash when sending after disconnect', async () => {
      const { connection } = await createOpenConnection();
      connection.disconnect();
      expect(() => {
        connection.subscribe('sub-1', [{}], { onEvent: vi.fn() });
        connection.publish(sampleEvent('a'));
        connection.unsubscribe('sub-1');
      }).not.toThrow();
    });
  });
});
