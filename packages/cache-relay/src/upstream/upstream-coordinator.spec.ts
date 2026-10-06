import type { Filter, NostrEvent } from '@nostr-cache/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type IngestResult, type ReadPart, UpstreamCoordinator } from './upstream-coordinator.js';
import type { UpstreamPool } from './upstream-types.js';

function makeEvent(id: string, kind = 1): NostrEvent {
  return { id, pubkey: 'p', created_at: 0, kind, tags: [], content: '', sig: '' };
}

/** In-memory mock pool that records calls and lets the test emit events/EOSE. */
class MockPool implements UpstreamPool {
  eventCb?: (subId: string, event: NostrEvent, relayUrl: string) => void;
  eoseCb?: (subId: string) => void;
  readonly opened: Array<{ subId: string; filters: Filter[]; relays?: string[] }> = [];
  readonly closed: string[] = [];
  readonly published: NostrEvent[] = [];
  started = false;
  stopped = false;
  connectedCount = 1;

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  publish(event: NostrEvent): void {
    this.published.push(event);
  }
  openSubscription(subId: string, filters: Filter[], relays?: string[]): void {
    this.opened.push({ subId, filters, ...(relays ? { relays } : {}) });
  }
  closeSubscription(subId: string): void {
    this.closed.push(subId);
  }
  onEvent(cb: (subId: string, event: NostrEvent, relayUrl: string) => void): void {
    this.eventCb = cb;
  }
  onEose(cb: (subId: string) => void): void {
    this.eoseCb = cb;
  }
  getConnectedCount(): number {
    return this.connectedCount;
  }
  emitEvent(subId: string, event: NostrEvent): void {
    this.eventCb?.(subId, event, 'wss://relay');
  }
  emitEose(subId: string): void {
    this.eoseCb?.(subId);
  }
  lastSubId(): string {
    return this.opened[this.opened.length - 1].subId;
  }
}

interface Harness {
  pool: MockPool;
  coordinator: UpstreamCoordinator;
  deliver: ReturnType<typeof vi.fn>;
  sendEose: ReturnType<typeof vi.fn>;
  ingest: ReturnType<typeof vi.fn>;
}

function makeHarness(
  ingestImpl: (event: NostrEvent) => Promise<IngestResult> = async () => ({
    success: true,
    stored: true,
  }),
  options?: { eoseTimeout?: number; maxSentIdsPerSub?: number }
): Harness {
  const pool = new MockPool();
  const deliver = vi.fn();
  const sendEose = vi.fn();
  const ingest = vi.fn(ingestImpl);
  // The coordinator wires the pool's onEvent/onEose callbacks in its
  // constructor, so the test helpers can emit events/EOSE without start().
  const coordinator = new UpstreamCoordinator({ pool, ingest, deliver, sendEose }, options);
  return { pool, coordinator, deliver, sendEose, ingest };
}

/** Let queued ingest promise chains settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('UpstreamCoordinator', () => {
  it('start wires callbacks and starts the pool', async () => {
    const { pool, coordinator } = makeHarness();
    await coordinator.start();
    expect(pool.started).toBe(true);
    expect(pool.eventCb).toBeDefined();
    expect(pool.eoseCb).toBeDefined();
  });

  it('opens an upstream subscription with a short (<=64 char) id', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    expect(pool.opened).toHaveLength(1);
    expect(pool.opened[0].subId.length).toBeLessThanOrEqual(64);
    expect(pool.opened[0].filters).toEqual([{ kinds: [1] }]);
  });

  it('ingests, dedupes and delivers an upstream event', async () => {
    const { pool, coordinator, deliver, ingest } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const event = makeEvent('a');
    pool.emitEvent(pool.lastSubId(), event);
    await flush();

    expect(ingest).toHaveBeenCalledWith(event);
    expect(deliver).toHaveBeenCalledWith('client', 'sub', event);
  });

  it('does not deliver an event already sent from local storage', async () => {
    const { pool, coordinator, deliver, ingest } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], ['a']);
    pool.emitEvent(pool.lastSubId(), makeEvent('a'));
    await flush();

    expect(ingest).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a duplicate event from two relays only once', async () => {
    const { pool, coordinator, deliver } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    const event = makeEvent('a');
    pool.emitEvent(subId, event);
    pool.emitEvent(subId, event);
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not deliver events that fail ingest (e.g. invalid)', async () => {
    const { pool, coordinator, deliver } = makeHarness(async () => ({
      success: false,
      stored: false,
    }));
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    pool.emitEvent(pool.lastSubId(), makeEvent('a'));
    await flush();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not deliver an event superseded by a newer cached version', async () => {
    // 上流が古い版の replaceable イベントを返した場合、キャッシュは保存していない。
    // 配信するとクライアントの手元で新しい版が古い版に上書きされうる
    const { pool, coordinator, deliver, ingest } = makeHarness(async () => ({
      success: true,
      stored: false,
      superseded: true,
    }));
    coordinator.openForSubscription('client', 'sub', [{ kinds: [0] }], []);
    const subId = pool.lastSubId();
    const event = makeEvent('a', 0);
    pool.emitEvent(subId, event);
    await flush();

    expect(deliver).not.toHaveBeenCalled();

    // 同じ古い版が別の上流から届いても ingest はやり直さない
    pool.emitEvent(subId, event);
    await flush();

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers accepted-but-unstored (ephemeral) events', async () => {
    const { pool, coordinator, deliver } = makeHarness(async () => ({
      success: true,
      stored: false,
    }));
    coordinator.openForSubscription('client', 'sub', [{ kinds: [20000] }], []);
    pool.emitEvent(pool.lastSubId(), makeEvent('a', 20000));
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  describe('EOSE', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends client EOSE when the aggregated upstream EOSE arrives', async () => {
      const { pool, coordinator, sendEose } = makeHarness();
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose(pool.lastSubId());
      await flush();
      expect(sendEose).toHaveBeenCalledWith('client', 'sub');
    });

    it('sends client EOSE after the timeout if upstream is silent', async () => {
      const { coordinator, sendEose } = makeHarness(undefined, { eoseTimeout: 500 });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      expect(sendEose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      await flush();
      expect(sendEose).toHaveBeenCalledWith('client', 'sub');
    });

    it('sends client EOSE only once (aggregate then timeout)', async () => {
      const { pool, coordinator, sendEose } = makeHarness(undefined, { eoseTimeout: 500 });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose(pool.lastSubId());
      vi.advanceTimersByTime(500);
      await flush();
      expect(sendEose).toHaveBeenCalledTimes(1);
    });

    /**
     * The ordering this class exists for: "hold back the client's EOSE ... so
     * one-shot clients see upstream results before end of stored".
     *
     * Upstream events are delivered only once their storage write resolves,
     * while EOSE had no such wait — so it overtook events the relay had already
     * accepted. A client that closes on EOSE (rx-nostr's oneshot strategy,
     * nostr-tools' `get`) then never saw them: the ingest chain drops every
     * queued delivery as soon as `closed` is set.
     */
    it('waits for queued ingests before sending EOSE', async () => {
      let releaseIngest: (() => void) | undefined;
      const ingestGate = new Promise<void>((resolve) => {
        releaseIngest = resolve;
      });
      const { pool, coordinator, deliver, sendEose } = makeHarness(async (event) => {
        await ingestGate;
        return { success: true, stored: true, event };
      });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      pool.emitEvent(pool.lastSubId(), makeEvent('slow-write'));
      pool.emitEose(pool.lastSubId());
      await flush();

      // Upstream said "end of stored", but the event it sent just before that
      // is still being written. EOSE now would be a lie.
      expect(deliver).not.toHaveBeenCalled();
      expect(sendEose).not.toHaveBeenCalled();

      releaseIngest?.();
      await flush();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(sendEose).toHaveBeenCalledTimes(1);
      expect(deliver.mock.invocationCallOrder[0]).toBeLessThan(
        sendEose.mock.invocationCallOrder[0]
      );
    });

    it('does not send EOSE when the client closed while an ingest was pending', async () => {
      let releaseIngest: (() => void) | undefined;
      const ingestGate = new Promise<void>((resolve) => {
        releaseIngest = resolve;
      });
      const { pool, coordinator, sendEose } = makeHarness(async (event) => {
        await ingestGate;
        return { success: true, stored: true, event };
      });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      pool.emitEvent(pool.lastSubId(), makeEvent('abandoned'));
      pool.emitEose(pool.lastSubId());
      coordinator.closeForSubscription('client', 'sub');
      releaseIngest?.();
      await flush();

      expect(sendEose).not.toHaveBeenCalled();
    });

    it('still sends EOSE when the backfill failed', async () => {
      // A failed write is not a reason to withhold "end of stored" for good;
      // the chain catches its own errors so it always settles.
      const { pool, coordinator, sendEose } = makeHarness(async () => {
        throw new Error('storage full');
      });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      pool.emitEvent(pool.lastSubId(), makeEvent('doomed'));
      pool.emitEose(pool.lastSubId());
      await flush();

      expect(sendEose).toHaveBeenCalledWith('client', 'sub');
    });
  });

  it('closeForSubscription closes the upstream sub and stops delivering', async () => {
    const { pool, coordinator, deliver } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    coordinator.closeForSubscription('client', 'sub');
    expect(pool.closed).toContain(subId);

    // An event arriving after close is dropped.
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a REQ reusing a subscription id closes the previous upstream sub', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const first = pool.lastSubId();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [2] }], []);
    expect(pool.closed).toContain(first);
    expect(pool.opened).toHaveLength(2);
  });

  it('closeAllForClient closes every subscription of that client only', () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub1', [{ kinds: [1] }], []);
    coordinator.openForSubscription('client', 'sub2', [{ kinds: [2] }], []);
    coordinator.openForSubscription('other', 'sub3', [{ kinds: [3] }], []);
    const [s1, s2, s3] = pool.opened.map((o) => o.subId);

    coordinator.closeAllForClient('client');
    expect(pool.closed).toContain(s1);
    expect(pool.closed).toContain(s2);
    expect(pool.closed).not.toContain(s3);
  });

  it('publish forwards to the pool', () => {
    const { pool, coordinator } = makeHarness();
    const event = makeEvent('x');
    coordinator.publish(event);
    expect(pool.published).toEqual([event]);
  });

  it('publish hands the event on after the default upstreams, surviving a throwing hook', () => {
    const pool = new MockPool();
    const onPublish = vi.fn(() => {
      expect(pool.published).toHaveLength(1);
      throw new Error('boom');
    });
    const coordinator = new UpstreamCoordinator({
      pool,
      ingest: vi.fn(),
      deliver: vi.fn(),
      sendEose: vi.fn(),
      onPublish,
    });
    const event = makeEvent('x');

    expect(() => coordinator.publish(event)).not.toThrow();
    expect(onPublish).toHaveBeenCalledWith(event);
  });

  it('markDelivered dedups a subsequent upstream echo of a locally-delivered event', async () => {
    const { pool, coordinator, deliver } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    // The event was already broadcast to this subscription locally (write-through
    // path), so record it.
    coordinator.markDelivered('client', 'sub', 'echo-id');

    // The upstream echo of the same event must not be delivered again.
    pool.emitEvent(pool.lastSubId(), makeEvent('echo-id'));
    await flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('markDelivered is a no-op for a subscription with no upstream counterpart', () => {
    const { coordinator } = makeHarness();
    // No openForSubscription: must not throw.
    expect(() => coordinator.markDelivered('client', 'missing', 'id')).not.toThrow();
  });

  it('stop() prevents an already-queued ingest from delivering', async () => {
    // ingest resolves on demand so we can stop() while it is in flight.
    let releaseIngest: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const { pool, coordinator, deliver } = makeHarness(async () => {
      await gate;
      return { success: true, stored: true };
    });
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    pool.emitEvent(pool.lastSubId(), makeEvent('a'));

    // Stop while the ingest promise is still pending.
    await coordinator.stop();
    releaseIngest?.();
    await flush();

    // The subscription was marked closed by stop(), so no delivery happens.
    expect(deliver).not.toHaveBeenCalled();
  });

  it('bounds the dedup set to maxSentIdsPerSub', async () => {
    const { pool, coordinator, deliver } = makeHarness(undefined, { maxSentIdsPerSub: 2 });
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    const subId = pool.lastSubId();
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    pool.emitEvent(subId, makeEvent('b'));
    await flush();
    pool.emitEvent(subId, makeEvent('c')); // evicts 'a'
    await flush();
    expect(deliver).toHaveBeenCalledTimes(3);

    // 'a' was evicted from the dedup set, so it is delivered again.
    pool.emitEvent(subId, makeEvent('a'));
    await flush();
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it('stop clears state and stops the pool', async () => {
    const { pool, coordinator } = makeHarness();
    coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
    await coordinator.stop();
    expect(pool.stopped).toBe(true);
  });

  describe('outbox routing', () => {
    /** ルーティングは何段かの Promise を経るので、マイクロタスク数回では足りない。 */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    function routedHarness(route: (filters: Filter[]) => Promise<ReadPart[]>) {
      const pool = new MockPool();
      const deliver = vi.fn();
      const sendEose = vi.fn();
      const coordinator = new UpstreamCoordinator({
        pool,
        ingest: async () => ({ success: true, stored: true }),
        deliver,
        sendEose,
        route,
      });
      return { pool, coordinator, deliver, sendEose };
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('opens the default subscription at once and the outbox parts once routed', async () => {
      const routed = deferred<ReadPart[]>();
      const { pool, coordinator } = routedHarness(() => routed.promise);

      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      expect(pool.opened).toEqual([{ subId: 'up1', filters: [{ kinds: [1] }] }]);

      routed.resolve([
        { relay: 'wss://a', filters: [{ kinds: [1], authors: ['x'] }] },
        { relay: 'wss://b', filters: [{ kinds: [1], authors: ['y'] }] },
      ]);
      await settle();

      expect(pool.opened.slice(1)).toEqual([
        { subId: 'up1.0', filters: [{ kinds: [1], authors: ['x'] }], relays: ['wss://a'] },
        { subId: 'up1.1', filters: [{ kinds: [1], authors: ['y'] }], relays: ['wss://b'] },
      ]);
    });

    it('holds the client EOSE until routing is done and every part has answered', async () => {
      const routed = deferred<ReadPart[]>();
      const { pool, coordinator, sendEose } = routedHarness(() => routed.promise);
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      pool.emitEose('up1');
      await settle();
      expect(sendEose).not.toHaveBeenCalled();

      routed.resolve([{ relay: 'wss://a', filters: [{ kinds: [1] }] }]);
      await settle();
      expect(sendEose).not.toHaveBeenCalled();

      pool.emitEose('up1.0');
      await settle();
      expect(sendEose).toHaveBeenCalledTimes(1);
    });

    it('stops waiting on slow outbox parts shortly after the default upstreams answer', async () => {
      vi.useFakeTimers();
      try {
        const pool = new MockPool();
        const sendEose = vi.fn();
        const coordinator = new UpstreamCoordinator(
          {
            pool,
            ingest: async () => ({ success: true, stored: true }),
            deliver: vi.fn(),
            sendEose,
            route: async () => [{ relay: 'wss://slow', filters: [{ kinds: [1] }] }],
          },
          { eoseTimeout: 3000, outboxEoseGrace: 500 }
        );
        coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
        await vi.advanceTimersByTimeAsync(0);

        pool.emitEose('up1');
        await vi.advanceTimersByTimeAsync(499);
        expect(sendEose).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(sendEose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still opens the default subscription when routing throws synchronously', async () => {
      const { pool, coordinator, sendEose } = routedHarness(() => {
        throw new Error('boom');
      });

      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose('up1');
      await settle();

      expect(pool.opened.map((o) => o.subId)).toEqual(['up1']);
      expect(sendEose).toHaveBeenCalledTimes(1);
    });

    it('sends EOSE once on timeout, and still opens parts routed after it', async () => {
      vi.useFakeTimers();
      try {
        const routed = deferred<ReadPart[]>();
        const pool = new MockPool();
        const sendEose = vi.fn();
        const coordinator = new UpstreamCoordinator(
          {
            pool,
            ingest: async () => ({ success: true, stored: true }),
            deliver: vi.fn(),
            sendEose,
            route: () => routed.promise,
          },
          { eoseTimeout: 100 }
        );
        coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

        await vi.advanceTimersByTimeAsync(100);
        expect(sendEose).toHaveBeenCalledTimes(1);

        routed.resolve([{ relay: 'wss://late', filters: [{ kinds: [1] }] }]);
        await vi.advanceTimersByTimeAsync(0);
        pool.emitEose('up1');
        // EOSE を送ったあとは、宛先を待つ猶予タイマーも張らない
        expect(vi.getTimerCount()).toBe(0);
        pool.emitEose('up1.0');
        await vi.advanceTimersByTimeAsync(1000);

        expect(pool.opened.map((o) => o.subId)).toEqual(['up1', 'up1.0']);
        expect(sendEose).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens no part once stopped mid-routing', async () => {
      const routed = deferred<ReadPart[]>();
      const { pool, coordinator } = routedHarness(() => routed.promise);
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      await coordinator.stop();
      routed.resolve([{ relay: 'wss://a', filters: [{ kinds: [1] }] }]);
      await settle();

      expect(pool.opened.map((o) => o.subId)).toEqual(['up1']);
    });

    it('skips routing while the pool is offline', async () => {
      const route = vi.fn(async () => [{ relay: 'wss://a', filters: [{ kinds: [1] }] }]);
      const { pool, coordinator, sendEose } = routedHarness(route);
      Object.assign(pool, { isOffline: () => true });

      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      pool.emitEose('up1');
      await settle();

      expect(route).not.toHaveBeenCalled();
      expect(sendEose).toHaveBeenCalledTimes(1);
    });

    it('does not wait on routing that failed', async () => {
      const { pool, coordinator, sendEose } = routedHarness(async () => {
        throw new Error('index down');
      });
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);

      pool.emitEose('up1');
      await settle();

      expect(sendEose).toHaveBeenCalledTimes(1);
      expect(pool.opened).toHaveLength(1);
    });

    it('delivers part events through the same dedup set', async () => {
      const { pool, coordinator, deliver } = routedHarness(async () => [
        { relay: 'wss://a', filters: [{ kinds: [1] }] },
      ]);
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], ['seen']);
      await settle();

      pool.emitEvent('up1.0', makeEvent('seen'));
      pool.emitEvent('up1.0', makeEvent('new'));
      pool.emitEvent('up1', makeEvent('new'));
      await settle();
      await settle();

      expect(deliver.mock.calls.map(([, , event]) => event.id)).toEqual(['new']);
    });

    it('closes every part with the subscription, and opens none after it closed', async () => {
      const routed = deferred<ReadPart[]>();
      const { pool, coordinator } = routedHarness(() => routed.promise);
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      coordinator.openForSubscription('client', 'other', [{ kinds: [1] }], []);

      coordinator.closeForSubscription('client', 'sub');
      routed.resolve([{ relay: 'wss://a', filters: [{ kinds: [1] }] }]);
      await settle();

      expect(pool.closed).toContain('up1');
      expect(pool.opened.map((o) => o.subId)).toEqual(['up1', 'up2', 'up2.0']);
    });

    it('closes the parts already opened', async () => {
      const { pool, coordinator } = routedHarness(async () => [
        { relay: 'wss://a', filters: [{ kinds: [1] }] },
      ]);
      coordinator.openForSubscription('client', 'sub', [{ kinds: [1] }], []);
      await settle();

      coordinator.closeForSubscription('client', 'sub');

      expect(pool.closed).toEqual(['up1', 'up1.0']);
    });
  });
});
