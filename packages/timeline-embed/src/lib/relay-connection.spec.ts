import type { NostrEvent } from '@nostr-cache/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from './relay-connection.ts';
import { ONE_SHOT_TIMEOUT_MS, RelayConnection } from './relay-connection.ts';

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
    this.emit('message', { type: 'message', data: JSON.stringify(message) });
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

    it('rejects and reports error when the relay refuses the connection', async () => {
      const statuses: ConnectionStatus[] = [];
      const connection = createConnection({ onStatusChange: (s) => statuses.push(s) });

      const promise = connection.connect(RELAY_URL);
      // 4000 is NIP-01's "do not reconnect", so this settles without going
      // anywhere near the retry ladder — how long rx-nostr retries for, and how
      // often, is its business and not something to pin down here.
      FakeWebSocket.instances[0].close(4000);

      await expect(promise).rejects.toThrow('Failed to connect');
      expect(statuses).toEqual(['connecting', 'error']);
      expect(connection.isConnected).toBe(false);
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

    it('silently ignores message types it does not handle', async () => {
      const onNotice = vi.fn();
      const onOk = vi.fn();
      const { connection, socket } = await createOpenConnection({ onNotice, onOk });
      const onEvent = vi.fn();
      connection.subscribe('sub-1', [{}], { onEvent });
      await flush();

      socket.simulateMessage(['UNKNOWN', 'x']);
      await flush();

      // Nothing reaches a handler, and routing carries on afterwards.
      expect(onNotice).not.toHaveBeenCalled();
      expect(onOk).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      socket.simulateMessage(['EVENT', wireSubId('sub-1'), sampleEvent('a')]);
      await flush();
      expect(onEvent).toHaveBeenCalledTimes(1);
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

/**
 * `fetchOnce` is rx-nostr's oneshot strategy, so what these pin down is the
 * wire behaviour we now rely on it for rather than our own bookkeeping: a REQ
 * goes out, EOSE ends it, a CLOSE follows, and nothing hangs when the relay
 * says nothing at all.
 */
describe('RelayConnection.fetchOnce', () => {
  /** The REQ this fetch put on the wire, and the subscription id it used. */
  function lastReq(socket: FakeWebSocket): { subId: string; filters: unknown[] } | undefined {
    const req = socket.messages.filter(
      (message): message is [string, string, ...unknown[]] =>
        Array.isArray(message) && message[0] === 'REQ'
    );
    const latest = req.at(-1);
    return latest ? { subId: latest[1], filters: latest.slice(2) } : undefined;
  }

  it('sends the REQ, collects until EOSE and then closes', async () => {
    const { connection, socket } = await createOpenConnection();

    const settled = connection.fetchOnce([{ kinds: [1], authors: ['pub'] }]);
    await flush();
    const req = lastReq(socket);
    expect(req?.filters).toEqual([{ kinds: [1], authors: ['pub'] }]);

    socket.simulateMessage(['EVENT', req?.subId, sampleEvent('a', 100)]);
    socket.simulateMessage(['EVENT', req?.subId, sampleEvent('b', 200)]);
    await flush();
    socket.simulateMessage(['EOSE', req?.subId]);

    expect((await settled).map((event) => event.id)).toEqual(['a', 'b']);
    // The CLOSE is rx-nostr's `finalize`; nothing is left open on the relay.
    expect(socket.messages).toContainEqual(['CLOSE', req?.subId]);
  });

  it('resolves empty when the relay answers with EOSE and nothing else', async () => {
    const { connection, socket } = await createOpenConnection();

    const settled = connection.fetchOnce([{ kinds: [1] }]);
    await flush();
    socket.simulateMessage(['EOSE', lastReq(socket)?.subId]);

    expect(await settled).toEqual([]);
  });

  it('ends on CLOSED, keeping what had already arrived', async () => {
    const { connection, socket } = await createOpenConnection();

    const settled = connection.fetchOnce([{ kinds: [1] }]);
    await flush();
    const subId = lastReq(socket)?.subId;
    socket.simulateMessage(['EVENT', subId, sampleEvent('a')]);
    await flush();
    socket.simulateMessage(['CLOSED', subId, 'too many subscriptions']);

    expect((await settled).map((event) => event.id)).toEqual(['a']);
  });

  it('gives up when the relay answers with nothing at all', async () => {
    vi.useFakeTimers();
    try {
      const { connection, socket } = await createOpenConnection();

      const settled = connection.fetchOnce([{ kinds: [1] }]);
      await flush();
      expect(lastReq(socket)).toBeDefined();
      // A refused REQ gets a NOTICE and neither EOSE nor CLOSED. rx-nostr's
      // backward observable pipes itself through `completeOnTimeout(eoseTimeout)`,
      // which is what ends this — the connection configures that timeout.
      await vi.advanceTimersByTimeAsync(ONE_SHOT_TIMEOUT_MS);

      expect(await settled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons the fetch and closes when the signal aborts', async () => {
    const { connection, socket } = await createOpenConnection();
    const controller = new AbortController();

    const settled = connection.fetchOnce([{ kinds: [1] }], { signal: controller.signal });
    await flush();
    const subId = lastReq(socket)?.subId;
    socket.simulateMessage(['EVENT', subId, sampleEvent('a')]);
    controller.abort();

    // Nothing is reported back, not even the event that did arrive: the caller
    // is being torn down and must not act on half an answer.
    expect(await settled).toEqual([]);
    expect(socket.messages).toContainEqual(['CLOSE', subId]);
  });

  it('opens no subscription at all when it is already aborted', async () => {
    const { connection, socket } = await createOpenConnection();
    const controller = new AbortController();
    controller.abort();

    expect(await connection.fetchOnce([{ kinds: [1] }], { signal: controller.signal })).toEqual([]);
    await flush();
    expect(lastReq(socket)).toBeUndefined();
  });

  it('resolves empty when there is no connection', async () => {
    const connection = createConnection();

    expect(await connection.fetchOnce([{ kinds: [1] }])).toEqual([]);
  });
});
