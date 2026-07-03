import type { NostrEvent } from '@nostr-cache/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from './relay-connection.ts';
import { RelayConnection } from './relay-connection.ts';

/**
 * Minimal WebSocket stand-in with manual event triggers.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({});
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  simulateMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  simulateRawMessage(data: string): void {
    this.onmessage?.({ data });
  }

  simulateError(): void {
    this.onerror?.({});
  }
}

function createConnection(options: ConstructorParameters<typeof RelayConnection>[0] = {}) {
  FakeWebSocket.instances = [];
  const connection = new RelayConnection({
    ...options,
    webSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
  });
  return connection;
}

async function createOpenConnection(
  options: ConstructorParameters<typeof RelayConnection>[0] = {}
) {
  const connection = createConnection(options);
  const promise = connection.connect('ws://nostr-cache.invalid');
  const socket = FakeWebSocket.instances[0];
  socket.simulateOpen();
  await promise;
  return { connection, socket };
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
  describe('connect()', () => {
    it('resolves on open and reports status transitions', async () => {
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect('ws://nostr-cache.invalid');
      expect(statuses).toEqual(['connecting']);

      FakeWebSocket.instances[0].simulateOpen();
      await promise;

      expect(statuses).toEqual(['connecting', 'connected']);
      expect(connection.isConnected).toBe(true);
    });

    it('rejects and reports error when the socket errors before opening', async () => {
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect('ws://nostr-cache.invalid');
      FakeWebSocket.instances[0].simulateError();

      await expect(promise).rejects.toThrow('Failed to connect');
      expect(statuses).toEqual(['connecting', 'error']);
      expect(connection.isConnected).toBe(false);
    });

    it('rejects when the socket closes before opening', async () => {
      const connection = createConnection();
      const promise = connection.connect('ws://nostr-cache.invalid');
      FakeWebSocket.instances[0].close();
      await expect(promise).rejects.toThrow('closed before opening');
    });
  });

  describe('subscribe() / unsubscribe()', () => {
    it('sends REQ with the subscription ID and filters', async () => {
      const { connection, socket } = await createOpenConnection();

      connection.subscribe('sub-1', [{ kinds: [1], limit: 10 }], { onEvent: vi.fn() });

      expect(socket.sent).toEqual([JSON.stringify(['REQ', 'sub-1', { kinds: [1], limit: 10 }])]);
    });

    it('sends CLOSE and stops routing after unsubscribe', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });

      connection.unsubscribe('sub-1');
      expect(socket.sent[1]).toBe(JSON.stringify(['CLOSE', 'sub-1']));

      socket.simulateMessage(['EVENT', 'sub-1', sampleEvent('a')]);
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('does not send CLOSE for unknown subscription IDs', async () => {
      const { connection, socket } = await createOpenConnection();
      connection.unsubscribe('nope');
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

      const event = sampleEvent('a');
      socket.simulateMessage(['EVENT', 'sub-1', event]);

      expect(first).toHaveBeenCalledWith(event);
      expect(second).not.toHaveBeenCalled();
    });

    it('ignores EVENT for unknown subscriptions', async () => {
      const { socket } = await createOpenConnection();
      expect(() => socket.simulateMessage(['EVENT', 'unknown', sampleEvent('a')])).not.toThrow();
    });

    it('routes EOSE to the subscription', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEose = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent: vi.fn(), onEose });

      socket.simulateMessage(['EOSE', 'sub-1']);
      expect(onEose).toHaveBeenCalledTimes(1);
    });

    it('routes CLOSED, removes the subscription, and passes the reason', async () => {
      const { connection, socket } = await createOpenConnection();
      const onClosed = vi.fn();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent, onClosed });

      socket.simulateMessage(['CLOSED', 'sub-1', 'shutting down']);
      expect(onClosed).toHaveBeenCalledWith('shutting down');

      socket.simulateMessage(['EVENT', 'sub-1', sampleEvent('a')]);
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
      const { socket } = await createOpenConnection();
      expect(() => {
        socket.simulateRawMessage('not json');
        socket.simulateMessage({ not: 'an array' });
        socket.simulateMessage(['UNKNOWN', 'x']);
        socket.simulateMessage([42]);
      }).not.toThrow();
    });
  });

  describe('publish()', () => {
    it('sends EVENT with the event payload', async () => {
      const { connection, socket } = await createOpenConnection();
      const event = sampleEvent('a');
      connection.publish(event);
      expect(socket.sent).toEqual([JSON.stringify(['EVENT', event])]);
    });
  });

  describe('disconnect()', () => {
    it('closes the socket, clears subscriptions, and reports disconnected', async () => {
      const statuses: ConnectionStatus[] = [];
      const { connection, socket } = await createOpenConnection({
        onStatusChange: (s) => statuses.push(s),
      });
      connection.subscribe('sub-1', [{}], { onEvent: vi.fn() });

      connection.disconnect();

      expect(socket.closed).toBe(true);
      expect(connection.isConnected).toBe(false);
      expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
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

    it('clears subscriptions when the server closes the socket', async () => {
      const { connection, socket } = await createOpenConnection();
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });

      socket.close();

      expect(connection.isConnected).toBe(false);
      socket.simulateMessage(['EVENT', 'sub-1', sampleEvent('a')]);
      expect(onEvent).not.toHaveBeenCalled();
    });
  });
});
